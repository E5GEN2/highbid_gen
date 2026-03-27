import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getPapaiApiKey } from '@/lib/config';
import { planChunks, extractChunks, analyzeVideoChunk, mergeChunkResults, VIDEO_ANALYSIS_PROMPT, type GeminiFilesResponse } from '@/lib/gemini-files';
import { selectClips } from '@/lib/gemini-clip-selector';
import { cutClip } from '@/lib/clip-cutter';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);
const CLIPS_DIR = '/tmp/clips';
const PROXY_URL = 'http://dce70f86-5501-4da9-a8c8-ea48f4418da6:QFZmMFWSWnQASZYy@xgodo.com:3008';

/**
 * POST /api/clipping/test-pipeline
 * Debug endpoint — no auth. Triggers the full YouTube → analyze → clips pipeline.
 * Body: { url, projectId? }
 * Returns JSON status after each step.
 */
export async function POST(req: NextRequest) {
  const { url, projectId: existingId, step: requestedStep, sourcePath: existingSourcePath } = await req.json();
  if (!url && !existingId) {
    return NextResponse.json({ error: 'url or projectId required' }, { status: 400 });
  }

  const dbLog = async (projectId: string, step: string, status: string, message: string) => {
    console.log(`[test-pipeline] ${step}: ${status} ${message}`);
    await pool.query(
      `INSERT INTO clipping_logs (project_id, step, status, message) VALUES ($1, $2, $3, $4)`,
      [projectId, step, status, message]
    ).catch(() => {});
  };

  try {
    // Step 1: Create project
    let projectId = existingId;
    if (!projectId) {
      const r = await pool.query(
        `INSERT INTO clipping_projects (title, status) VALUES ($1, 'draft') RETURNING id`,
        [`YT-test-${Date.now()}`]
      );
      projectId = r.rows[0].id;
    }

    // Step 2: Download via yt-dlp
    const dir = path.join(CLIPS_DIR, projectId);
    fs.mkdirSync(dir, { recursive: true });
    const outputPath = path.join(dir, 'source.mp4');

    if (existingSourcePath && fs.existsSync(existingSourcePath)) {
      // Copy from an existing downloaded file
      fs.copyFileSync(existingSourcePath, outputPath);
      await dbLog(projectId, 'download', 'done', `Copied from ${existingSourcePath}: ${(fs.statSync(outputPath).size / 1e6).toFixed(0)}MB`);
    } else if (fs.existsSync(outputPath)) {
      await dbLog(projectId, 'download', 'done', `Already exists: ${(fs.statSync(outputPath).size / 1e6).toFixed(0)}MB`);
    } else if (requestedStep === 'analyze') {
      return NextResponse.json({ error: 'Source file not found. Download first.', projectId }, { status: 400 });
    } else if (url && url.match(/(?:youtube\.com|youtu\.be)/i)) {
      await dbLog(projectId, 'download', 'active', 'Downloading from YouTube...');
      await execFileAsync('yt-dlp', [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', outputPath,
        '--no-warnings', '--no-playlist',
        '--proxy', PROXY_URL,
        url,
      ], { timeout: 600000 });
      const size = fs.statSync(outputPath).size;
      await dbLog(projectId, 'download', 'done', `Downloaded ${(size / 1e6).toFixed(0)}MB`);
    }

    const videoUrl = `file://${outputPath}`;

    // Step 3: Get video duration
    const { stdout: probeOut } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', outputPath,
    ], { timeout: 30000 });
    const duration = parseFloat(JSON.parse(probeOut).format.duration);

    // If step=download, return after download
    if (requestedStep === 'download') {
      return NextResponse.json({
        ok: true, projectId, videoUrl, duration, status: 'downloaded',
        next: `POST with {"projectId":"${projectId}","step":"analyze"}`,
      });
    }

    // Run analysis synchronously (within this request)
    {
      const bgProjectId = projectId;
      try {
        const apiKey = await getPapaiApiKey();
        if (!apiKey) throw new Error('No PAPAI_API_KEY configured');

        // Analyze
        const chunks = planChunks(duration);
        await dbLog(bgProjectId, 'analyze', 'active', `Analyzing ${chunks.length} chunks for ${duration.toFixed(0)}s video`);

        const analysisRes = await pool.query(
          `INSERT INTO clipping_analyses (project_id, video_url, status, prompt)
           VALUES ($1, $2, 'processing', $3) RETURNING id`,
          [bgProjectId, videoUrl, VIDEO_ANALYSIS_PROMPT]
        );
        const analysisId = analysisRes.rows[0].id;
        await pool.query(`UPDATE clipping_projects SET status='processing', updated_at=NOW() WHERE id=$1`, [bgProjectId]);

        const extractedChunks = await extractChunks(videoUrl, chunks);
        await dbLog(bgProjectId, 'extract', 'done', `Extracted ${extractedChunks.size} chunks`);

        let completed = 0;
        const chunkResults: (GeminiFilesResponse | null)[] = new Array(chunks.length).fill(null);
        await Promise.all(chunks.map(async (chunk) => {
          const result = await analyzeVideoChunk(videoUrl, apiKey, chunk, extractedChunks);
          chunkResults[chunk.index] = result;
          completed++;
          if (completed % 5 === 0 || completed === chunks.length) {
            await dbLog(bgProjectId, 'analyze', 'progress', `${completed}/${chunks.length} chunks done`);
          }
        }));

        const validResults = chunkResults.filter((r): r is GeminiFilesResponse => r !== null);
        const merged = mergeChunkResults(validResults);
        await dbLog(bgProjectId, 'analyze', 'done', `${merged.analysis.total_segments} segments`);

        await pool.query(
          `UPDATE clipping_analyses SET status='done', video_duration_seconds=$1, total_segments=$2, segments=$3,
           raw_response=$4, tokens_in=$5, tokens_out=$6, duration_ms=$7, completed_at=NOW() WHERE id=$8`,
          [merged.analysis.video_duration_seconds, merged.analysis.total_segments,
           JSON.stringify(merged.analysis.segments), merged.raw_response,
           merged.tokens_in, merged.tokens_out, merged.duration_ms, analysisId]
        );
        await pool.query(`UPDATE clipping_projects SET status='done', updated_at=NOW() WHERE id=$1`, [bgProjectId]);

        // Select clips
        await dbLog(bgProjectId, 'select_clips', 'active', 'Selecting clips...');
        const selection = await selectClips(merged.analysis.segments, apiKey, { clipLength: '60s-90s' });
        await dbLog(bgProjectId, 'select_clips', 'done', `${selection.clips.length} clips selected`);

        // Insert clip records and collect their DB IDs
        const clipDbIds: string[] = [];
        for (const c of selection.clips) {
          const r = await pool.query(
            `INSERT INTO clipping_clips (project_id, title, description, score, start_sec, end_sec, duration_sec, transcript, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id`,
            [bgProjectId, c.title, c.description, c.score, c.start, c.end, c.end - c.start, c.transcript]
          );
          clipDbIds.push(r.rows[0].id);
        }

        // Cut clips and update DB records
        await dbLog(bgProjectId, 'cut_clips', 'active', `Cutting ${selection.clips.length} clips...`);
        const sourcePath = videoUrl.replace('file://', '');
        let cutCount = 0;
        for (let i = 0; i < selection.clips.length; i++) {
          try {
            const result = await cutClip({
              sourceVideoPath: sourcePath,
              projectId: bgProjectId,
              clipId: `clip_${i + 1}`,
              startSec: selection.clips[i].start,
              endSec: selection.clips[i].end,
            });
            // Update DB with file info
            await pool.query(
              `UPDATE clipping_clips SET status='done', file_path=$1, thumbnail_path=$2, file_size_bytes=$3 WHERE id=$4`,
              [result.filePath, result.thumbnailPath, result.fileSizeBytes, clipDbIds[i]]
            );
            cutCount++;
          } catch (e) {
            await pool.query(
              `UPDATE clipping_clips SET status='error' WHERE id=$1`,
              [clipDbIds[i]]
            );
            await dbLog(bgProjectId, 'cut_clip', 'error', `Clip ${i + 1} failed: ${e instanceof Error ? e.message : ''}`);
          }
        }
        await dbLog(bgProjectId, 'pipeline', 'done', `Complete: ${merged.analysis.total_segments} segments, ${selection.clips.length} clips, ${cutCount} cut`);

        return NextResponse.json({
          ok: true, projectId, videoUrl, duration,
          segments: merged.analysis.total_segments,
          clips: selection.clips.length, clipsCut: cutCount,
          status: 'done',
          debug: `https://rofe.ai/api/clipping/debug?projectId=${projectId}`,
        });
      } catch (err) {
        const pipelineErr = err instanceof Error ? err.message : 'Unknown error';
        await dbLog(bgProjectId, 'pipeline', 'error', pipelineErr);
        return NextResponse.json({ ok: false, projectId, error: pipelineErr }, { status: 500 });
      }
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[test-pipeline] Error:', msg);
    return NextResponse.json({ ok: false, error: msg.substring(0, 500) }, { status: 500 });
  }
}

/**
 * GET /api/clipping/test-pipeline?projectId=xxx
 * Check pipeline status for a project.
 */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 });
  }

  const project = await pool.query(`SELECT * FROM clipping_projects WHERE id = $1`, [projectId]);
  const analyses = await pool.query(
    `SELECT id, status, total_segments, error, duration_ms, created_at, completed_at FROM clipping_analyses WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId]
  );
  const clips = await pool.query(
    `SELECT id, title, score, start_sec, end_sec, duration_sec, status FROM clipping_clips WHERE project_id = $1 ORDER BY score DESC`,
    [projectId]
  );
  const logs = await pool.query(
    `SELECT step, status, message, created_at FROM clipping_logs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [projectId]
  );

  // Check if source file exists
  const dir = path.join(CLIPS_DIR, projectId);
  const sourceExists = fs.existsSync(path.join(dir, 'source.mp4')) || fs.existsSync(path.join(dir, 'source.mov'));

  return NextResponse.json({
    project: project.rows[0] || null,
    sourceExists,
    analyses: analyses.rows,
    clips: clips.rows,
    recentLogs: logs.rows,
  });
}

export const maxDuration = 600;
