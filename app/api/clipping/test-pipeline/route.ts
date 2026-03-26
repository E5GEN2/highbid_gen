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
  const { url, projectId: existingId } = await req.json();
  if (!url) {
    return NextResponse.json({ error: 'url required' }, { status: 400 });
  }

  const steps: { step: string; status: string; detail?: string; duration_ms?: number }[] = [];
  const log = (step: string, status: string, detail?: string, duration_ms?: number) => {
    steps.push({ step, status, detail, duration_ms });
    console.log(`[test-pipeline] ${step}: ${status} ${detail || ''}`);
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
    log('create_project', 'done', projectId);

    // Step 2: Download via yt-dlp
    const dir = path.join(CLIPS_DIR, projectId);
    fs.mkdirSync(dir, { recursive: true });
    const outputPath = path.join(dir, 'source.mp4');

    if (fs.existsSync(outputPath)) {
      log('download', 'done', `Already exists: ${(fs.statSync(outputPath).size / 1e6).toFixed(0)}MB`);
    } else {
      const t0 = Date.now();
      // Get info first
      const { stdout: infoJson } = await execFileAsync('yt-dlp', [
        '--dump-json', '--no-warnings', '--proxy', PROXY_URL, url,
      ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
      const info = JSON.parse(infoJson);
      log('info', 'done', `${info.title} | ${info.duration}s | ~${Math.round((info.filesize_approx || 0) / 1e6)}MB`);

      // Download
      await execFileAsync('yt-dlp', [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', outputPath,
        '--no-warnings', '--no-playlist',
        '--proxy', PROXY_URL,
        url,
      ], { timeout: 600000 });

      const size = fs.statSync(outputPath).size;
      log('download', 'done', `${(size / 1e6).toFixed(0)}MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`, Date.now() - t0);
    }

    const videoUrl = `file://${outputPath}`;

    // Step 3: Get video duration
    const { stdout: probeOut } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', outputPath,
    ], { timeout: 30000 });
    const duration = parseFloat(JSON.parse(probeOut).format.duration);
    log('probe', 'done', `${duration.toFixed(0)}s (${(duration / 60).toFixed(1)}min)`);

    // Step 4: Analyze video (chunked)
    const apiKey = await getPapaiApiKey();
    if (!apiKey) throw new Error('No PAPAI_API_KEY configured');

    const chunks = planChunks(duration);
    log('plan_chunks', 'done', `${chunks.length} chunks for ${duration.toFixed(0)}s`);

    // Create analysis record
    const analysisRes = await pool.query(
      `INSERT INTO clipping_analyses (project_id, video_url, status, prompt)
       VALUES ($1, $2, 'processing', $3) RETURNING id`,
      [projectId, videoUrl, VIDEO_ANALYSIS_PROMPT]
    );
    const analysisId = analysisRes.rows[0].id;
    await pool.query(`UPDATE clipping_projects SET status = 'processing', updated_at = NOW() WHERE id = $1`, [projectId]);

    // Extract chunks sequentially
    const t1 = Date.now();
    const extractedChunks = await extractChunks(videoUrl, chunks);
    log('extract_chunks', 'done', `${extractedChunks.size} chunks extracted`, Date.now() - t1);

    // Analyze in parallel
    const t2 = Date.now();
    let completed = 0;
    const chunkResults: (GeminiFilesResponse | null)[] = new Array(chunks.length).fill(null);

    await Promise.all(chunks.map(async (chunk) => {
      const result = await analyzeVideoChunk(videoUrl, apiKey, chunk, extractedChunks);
      chunkResults[chunk.index] = result;
      completed++;
      if (completed % 5 === 0 || completed === chunks.length) {
        log('analyze', 'progress', `${completed}/${chunks.length} chunks done`);
      }
    }));

    const validResults = chunkResults.filter((r): r is GeminiFilesResponse => r !== null);
    const merged = mergeChunkResults(validResults);
    log('analyze', 'done', `${merged.analysis.total_segments} segments in ${((Date.now() - t2) / 1000).toFixed(0)}s`, Date.now() - t2);

    // Store in DB
    await pool.query(
      `UPDATE clipping_analyses SET status='done', video_duration_seconds=$1, total_segments=$2, segments=$3,
       raw_response=$4, tokens_in=$5, tokens_out=$6, duration_ms=$7, completed_at=NOW() WHERE id=$8`,
      [merged.analysis.video_duration_seconds, merged.analysis.total_segments,
       JSON.stringify(merged.analysis.segments), merged.raw_response,
       merged.tokens_in, merged.tokens_out, merged.duration_ms, analysisId]
    );
    await pool.query(`UPDATE clipping_projects SET status='done', updated_at=NOW() WHERE id=$1`, [projectId]);

    // Step 5: Select clips
    const t3 = Date.now();
    const selection = await selectClips(merged.analysis.segments, apiKey, { clipLength: '60s-90s' });
    log('select_clips', 'done', `${selection.clips.length} clips selected in ${((Date.now() - t3) / 1000).toFixed(0)}s`, Date.now() - t3);

    // Store clips in DB
    for (let i = 0; i < selection.clips.length; i++) {
      const c = selection.clips[i];
      await pool.query(
        `INSERT INTO clipping_clips (project_id, title, description, score, start_sec, end_sec, duration_sec, transcript, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
        [projectId, c.title, c.description, c.score, c.start, c.end, c.end - c.start, c.transcript]
      );
    }
    log('store_clips', 'done', `${selection.clips.length} clip records inserted`);

    // Step 6: Cut clips with ffmpeg
    const t4 = Date.now();
    const sourcePath = videoUrl.replace('file://', '');
    let cutCount = 0;
    for (let i = 0; i < selection.clips.length; i++) {
      const c = selection.clips[i];
      try {
        await cutClip({ sourceVideoPath: sourcePath, projectId, clipId: `clip_${i + 1}`, startSec: c.start, endSec: c.end });
        cutCount++;
      } catch (e) {
        log('cut_clip', 'error', `Clip ${i + 1} failed: ${e instanceof Error ? e.message : 'unknown'}`);
      }
    }
    log('cut_clips', 'done', `${cutCount}/${selection.clips.length} clips cut in ${((Date.now() - t4) / 1000).toFixed(0)}s`, Date.now() - t4);

    return NextResponse.json({
      ok: true,
      projectId,
      videoUrl,
      duration,
      segments: merged.analysis.total_segments,
      clips: selection.clips.length,
      clipsCut: cutCount,
      steps,
      debug: `https://rofe.ai/api/clipping/debug?projectId=${projectId}`,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    log('error', 'failed', msg.substring(0, 300));
    return NextResponse.json({ ok: false, steps, error: msg.substring(0, 500) }, { status: 500 });
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
