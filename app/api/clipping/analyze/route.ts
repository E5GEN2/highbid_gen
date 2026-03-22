import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { pool } from '@/lib/db';
import {
  analyzeVideoChunk,
  planChunks,
  mergeChunkResults,
  VIDEO_ANALYSIS_PROMPT,
  type GeminiFilesResponse,
} from '@/lib/gemini-files';

// Helper to log a step to clipping_logs
async function log(
  projectId: string,
  analysisId: string,
  step: string,
  status: string,
  message: string,
  data?: Record<string, unknown>,
) {
  await pool.query(
    `INSERT INTO clipping_logs (project_id, analysis_id, step, status, message, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [projectId, analysisId, step, status, message, data ? JSON.stringify(data) : null]
  );
}

/**
 * POST /api/clipping/analyze
 * Start video analysis for a clipping project.
 * Body: { projectId, videoUrl, videoDuration? }
 *
 * If videoDuration is provided and > 5min, the video is analyzed in 5-min chunks.
 * Each chunk is a separate Gemini API call, and results are merged at the end.
 *
 * Returns SSE stream with progress updates, then final result.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { projectId, videoUrl, videoDuration } = await req.json();
  if (!projectId || !videoUrl) {
    return NextResponse.json({ error: 'projectId and videoUrl required' }, { status: 400 });
  }

  // Verify project belongs to user
  const projectCheck = await pool.query(
    `SELECT id FROM clipping_projects WHERE id = $1 AND user_id = $2`,
    [projectId, session.user.id]
  );
  if (projectCheck.rows.length === 0) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const apiKey = process.env.PAPAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'PAPAI_API_KEY not configured' }, { status: 500 });
  }

  // Create analysis record
  const analysisResult = await pool.query(
    `INSERT INTO clipping_analyses (project_id, video_url, status, prompt)
     VALUES ($1, $2, 'processing', $3)
     RETURNING id`,
    [projectId, videoUrl, VIDEO_ANALYSIS_PROMPT]
  );
  const analysisId = analysisResult.rows[0].id;

  // Update project status
  await pool.query(
    `UPDATE clipping_projects SET status = 'processing', updated_at = NOW() WHERE id = $1`,
    [projectId]
  );

  // Plan chunks based on video duration
  const durationSec = videoDuration || 300; // Default to 5min if unknown
  const chunks = planChunks(durationSec);
  const totalChunks = chunks.length;

  // SSE stream for progress
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Step 1: Upload done
        send('progress', { step: 'Upload', status: 'done' });
        await log(projectId, analysisId, 'upload', 'done', 'Video URL received', { videoUrl });

        // Step 2: Create project done
        send('progress', { step: 'Create project', status: 'done' });
        await log(projectId, analysisId, 'create_project', 'done', 'Analysis record created', {
          analysisId, totalChunks, durationSec,
          chunks: chunks.map(c => c.label),
        });

        // Step 3: Process video — fire all chunks in parallel (semaphore limits to 10 global)
        send('progress', { step: 'Process video', status: 'active', totalChunks, completedChunks: 0, detail: `Extracting ${totalChunks} chunks...` });
        await log(projectId, analysisId, 'process_video', 'active',
          `Starting parallel analysis: ${totalChunks} chunk(s) for ${Math.round(durationSec)}s video`);

        let completedChunks = 0;
        const chunkResults: (GeminiFilesResponse | null)[] = new Array(totalChunks).fill(null);

        // Launch all chunks in parallel — global semaphore handles concurrency
        const chunkPromises = chunks.map(async (chunk) => {
          await log(projectId, analysisId, 'process_chunk', 'queued',
            `Chunk ${chunk.index + 1}/${totalChunks} queued: ${chunk.label}`, {
              chunkIndex: chunk.index,
              startSec: chunk.startSec,
              endSec: chunk.endSec,
            });

          const result = await analyzeVideoChunk(videoUrl, apiKey, chunk);
          chunkResults[chunk.index] = result;
          completedChunks++;

          send('progress', {
            step: 'Process video',
            status: 'active',
            totalChunks,
            completedChunks,
            chunkLabel: chunk.label,
            progress: Math.round((completedChunks / totalChunks) * 100),
          });

          await log(projectId, analysisId, 'process_chunk', 'done',
            `Chunk ${chunk.index + 1}/${totalChunks} complete: ${result.analysis.total_segments} segments in ${result.duration_ms}ms`, {
              chunkIndex: chunk.index,
              segments: result.analysis.total_segments,
              duration_ms: result.duration_ms,
              tokens_in: result.tokens_in,
              tokens_out: result.tokens_out,
            });
        });

        await Promise.all(chunkPromises);

        send('progress', { step: 'Process video', status: 'done' });
        await log(projectId, analysisId, 'process_video', 'done',
          `All ${totalChunks} chunks analyzed in parallel`);

        // Step 4: Finding best parts — merge chunks
        send('progress', { step: 'Finding best parts', status: 'active', progress: 0 });
        await log(projectId, analysisId, 'finding_parts', 'active', 'Merging chunk results');

        const validResults = chunkResults.filter((r): r is GeminiFilesResponse => r !== null);
        const merged = mergeChunkResults(validResults);

        await log(projectId, analysisId, 'finding_parts', 'done',
          `Merged: ${merged.analysis.total_segments} total segments, ${merged.analysis.video_duration_seconds}s`, {
            total_segments: merged.analysis.total_segments,
            video_duration: merged.analysis.video_duration_seconds,
            total_tokens_in: merged.tokens_in,
            total_tokens_out: merged.tokens_out,
            total_duration_ms: merged.duration_ms,
          });

        // Store merged analysis in DB
        await pool.query(
          `UPDATE clipping_analyses SET
            status = 'done',
            video_duration_seconds = $1,
            total_segments = $2,
            segments = $3,
            raw_response = $4,
            tokens_in = $5,
            tokens_out = $6,
            duration_ms = $7,
            completed_at = NOW()
          WHERE id = $8`,
          [
            merged.analysis.video_duration_seconds,
            merged.analysis.total_segments,
            JSON.stringify(merged.analysis.segments),
            merged.raw_response,
            merged.tokens_in,
            merged.tokens_out,
            merged.duration_ms,
            analysisId,
          ]
        );

        send('progress', { step: 'Finding best parts', status: 'done' });

        // Step 5: Edit clips (placeholder for now)
        send('progress', { step: 'Edit clips', status: 'done' });

        // Step 6: Finalize
        await pool.query(
          `UPDATE clipping_projects SET status = 'done', updated_at = NOW() WHERE id = $1`,
          [projectId]
        );
        send('progress', { step: 'Finalize', status: 'done' });
        await log(projectId, analysisId, 'finalize', 'done', 'Project marked as done');

        // Send final result
        send('complete', {
          analysisId,
          videoUrl,
          videoDuration: merged.analysis.video_duration_seconds,
          totalSegments: merged.analysis.total_segments,
          totalChunks,
          durationMs: merged.duration_ms,
        });

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';

        await log(projectId, analysisId, 'error', 'error', errorMsg);

        await pool.query(
          `UPDATE clipping_analyses SET status = 'error', error = $1 WHERE id = $2`,
          [errorMsg, analysisId]
        );
        await pool.query(
          `UPDATE clipping_projects SET status = 'draft', updated_at = NOW() WHERE id = $1`,
          [projectId]
        );

        send('error', { error: errorMsg });
      } finally {
        controller.close();
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

/**
 * GET /api/clipping/analyze?projectId=xxx
 * Get analysis status/results for a project.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const projectId = req.nextUrl.searchParams.get('projectId');
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

  const result = await pool.query(
    `SELECT id, status, video_url, video_duration_seconds, total_segments, segments,
            error, tokens_in, tokens_out, duration_ms, created_at, completed_at
     FROM clipping_analyses
     WHERE project_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [projectId]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ analysis: null });
  }

  return NextResponse.json({ analysis: result.rows[0] });
}
