import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
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

    return NextResponse.json({
      ok: true,
      projectId,
      videoUrl,
      duration,
      steps,
      next: `Now call POST /api/clipping/analyze (needs auth) or check /api/clipping/debug?projectId=${projectId}`,
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
