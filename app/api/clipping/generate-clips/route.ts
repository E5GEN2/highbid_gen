import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { pool } from '@/lib/db';
import { getPapaiApiKey } from '@/lib/config';
import { selectClips } from '@/lib/gemini-clip-selector';
import { cutClip, downloadVideo } from '@/lib/clip-cutter';
import type { VideoSegment } from '@/lib/gemini-files';

/**
 * POST /api/clipping/generate-clips
 * Full pipeline: AI selects clips → ffmpeg cuts them → stores in DB.
 * Body: { projectId }
 * Returns SSE stream with progress.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { projectId } = await req.json();
  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 });
  }

  // Verify project belongs to user
  const projectCheck = await pool.query(
    `SELECT id FROM clipping_projects WHERE id = $1 AND user_id = $2`,
    [projectId, session.user.id]
  );
  if (projectCheck.rows.length === 0) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Load latest analysis
  const analysisRes = await pool.query(
    `SELECT id, segments, video_url, video_duration_seconds
     FROM clipping_analyses
     WHERE project_id = $1 AND status = 'done'
     ORDER BY created_at DESC LIMIT 1`,
    [projectId]
  );
  if (analysisRes.rows.length === 0) {
    return NextResponse.json({ error: 'No completed analysis found' }, { status: 400 });
  }

  const analysis = analysisRes.rows[0];
  const segments: VideoSegment[] = analysis.segments;
  const videoUrl: string = analysis.video_url;
  const analysisId: string = analysis.id;

  const apiKey = await getPapaiApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: 'PAPAI_API_KEY not configured. Set it in Admin > Settings.' }, { status: 500 });
  }

  // Helper to log to clipping_logs
  const logStep = async (step: string, status: string, message: string, data?: Record<string, unknown>) => {
    await pool.query(
      `INSERT INTO clipping_logs (project_id, analysis_id, step, status, message, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [projectId, analysisId, step, status, message, data ? JSON.stringify(data) : null]
    ).catch(e => console.error('[generate-clips] Log write failed:', e));
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let streamClosed = false;
      const send = (event: string, data: Record<string, unknown>) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          streamClosed = true;
        }
      };

      try {
        // Step 1: AI clip selection
        send('progress', { step: 'Selecting clips', status: 'active' });
        await logStep('select_clips', 'active', `Selecting clips from ${segments.length} segments`);

        const selection = await selectClips(segments, apiKey);
        const clips = selection.clips;

        await logStep('select_clips', 'done', `Selected ${clips.length} clips`, {
          clipCount: clips.length,
          tokens_in: selection.tokens_in,
          tokens_out: selection.tokens_out,
          duration_ms: selection.duration_ms,
          clips: clips.map(c => ({ title: c.title, start: c.start, end: c.end, score: c.score })),
          raw_response: selection.raw_response?.substring(0, 2000),
        });

        send('progress', {
          step: 'Selecting clips',
          status: 'done',
          clipCount: clips.length,
          tokensIn: selection.tokens_in,
          tokensOut: selection.tokens_out,
          durationMs: selection.duration_ms,
        });

        if (clips.length === 0) {
          await logStep('select_clips', 'error', 'AI found no clip-worthy moments');
          send('error', { error: 'AI found no clip-worthy moments' });
          if (!streamClosed) try { controller.close(); } catch { /* already closed */ }
          return;
        }

        // Step 2: Insert clip records into DB
        send('progress', { step: 'Preparing clips', status: 'active' });
        await logStep('prepare_clips', 'active', `Inserting ${clips.length} clip records`);

        const clipIds: string[] = [];
        for (const clip of clips) {
          const res = await pool.query(
            `INSERT INTO clipping_clips
              (project_id, analysis_id, title, description, score, start_sec, end_sec, duration_sec, transcript, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
             RETURNING id`,
            [projectId, analysisId, clip.title, clip.description, clip.score,
             clip.start, clip.end, clip.end - clip.start, clip.transcript]
          );
          clipIds.push(res.rows[0].id);
        }

        send('progress', { step: 'Preparing clips', status: 'done', clipCount: clipIds.length });
        await logStep('prepare_clips', 'done', `Inserted ${clipIds.length} clip records`);

        // Step 3: Download source video
        send('progress', { step: 'Downloading source', status: 'active' });
        await logStep('download_source', 'active', `Downloading ${videoUrl.substring(0, 80)}`);
        const localVideoPath = await downloadVideo(videoUrl, projectId);
        send('progress', { step: 'Downloading source', status: 'done' });
        await logStep('download_source', 'done', `Source at ${localVideoPath}`);

        // Step 4: Cut clips with ffmpeg (sequential to avoid EAGAIN)
        send('progress', { step: 'Cutting clips', status: 'active', total: clips.length, completed: 0, progress: 0 });
        await logStep('cut_clips', 'active', `Cutting ${clips.length} clips from source`);

        let completedCuts = 0;

        for (let i = 0; i < clips.length; i++) {
          const clip = clips[i];
          const clipId = clipIds[i];

          try {
            await pool.query(
              `UPDATE clipping_clips SET status = 'cutting' WHERE id = $1`, [clipId]
            );

            const result = await cutClip({
              sourceVideoPath: localVideoPath,
              clipId,
              projectId,
              startSec: clip.start,
              endSec: clip.end,
            });

            await pool.query(
              `UPDATE clipping_clips SET
                status = 'done', file_path = $1, thumbnail_path = $2, file_size_bytes = $3
               WHERE id = $4`,
              [result.filePath, result.thumbnailPath, result.fileSizeBytes, clipId]
            );

            completedCuts++;
            await logStep('cut_clip', 'done', `Cut clip ${completedCuts}/${clips.length}: ${clip.title}`, {
              clipId, start: clip.start, end: clip.end, filePath: result.filePath, size: result.fileSizeBytes,
            });
            send('progress', {
              step: 'Cutting clips',
              status: 'active',
              total: clips.length,
              completed: completedCuts,
              progress: Math.round((completedCuts / clips.length) * 100),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            await pool.query(
              `UPDATE clipping_clips SET status = 'error' WHERE id = $1`, [clipId]
            );
            await logStep('cut_clip', 'error', `Cut failed for clip ${i + 1}: ${msg}`, { clipId, title: clip.title });
          }
        }

        send('progress', { step: 'Cutting clips', status: 'done', completed: completedCuts, total: clips.length });
        await logStep('cut_clips', 'done', `Cut ${completedCuts}/${clips.length} clips`);

        // Update project status
        await pool.query(
          `UPDATE clipping_projects SET status = 'done', updated_at = NOW() WHERE id = $1`,
          [projectId]
        );

        await logStep('complete', 'done', `Pipeline complete: ${completedCuts} clips generated`);

        // Send final result
        send('complete', {
          projectId,
          totalClips: clips.length,
          completedClips: completedCuts,
          clips: clips.map((c, i) => ({
            id: clipIds[i],
            title: c.title,
            score: c.score,
            start: c.start,
            end: c.end,
            duration: c.end - c.start,
          })),
        });

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await logStep('pipeline_error', 'error', errorMsg, {
          raw: error instanceof Error ? error.stack : String(error),
        });
        send('error', { error: errorMsg });
        console.error(`[generate-clips] Pipeline error: ${errorMsg}`);
      } finally {
        if (!streamClosed) try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Allow long processing time for clip generation
export const maxDuration = 300;
