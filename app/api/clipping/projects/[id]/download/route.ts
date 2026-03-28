import { NextRequest, NextResponse } from 'next/server';
import { CLIPS_DIR } from '@/lib/clips-dir';
import { validateProject, setStepRunning, setStepProgress, setStepDone, setStepError, logStep } from '@/lib/clipping-pipeline';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);
const PROXY_URL = 'http://dce70f86-5501-4da9-a8c8-ea48f4418da6:QFZmMFWSWnQASZYy@xgodo.com:3008';

/**
 * POST /api/clipping/projects/{id}/download
 * Download a YouTube video via yt-dlp. Fire-and-forget.
 * Body: { url }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const validation = await validateProject(req, projectId);
  if (validation instanceof NextResponse) return validation;

  const { url } = await req.json();
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 });
  if (!url.match(/(?:youtube\.com|youtu\.be)/i)) {
    return NextResponse.json({ error: 'Not a valid YouTube URL' }, { status: 400 });
  }

  const started = await setStepRunning(projectId, 'download', { percent: 0 });
  if (!started) return NextResponse.json({ ok: true, step: 'download', status: 'already-running' });

  await logStep(projectId, 'download', 'active', 'Downloading from YouTube...');

  // Fire-and-forget
  runDownload(projectId, url).catch(async (err) => {
    await setStepError(projectId, err.message);
    await logStep(projectId, 'download', 'error', err.message);
  });

  return NextResponse.json({ ok: true, step: 'download', status: 'started' });
}

async function runDownload(projectId: string, url: string) {
  const dir = path.join(CLIPS_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const outputPath = path.join(dir, 'source.mp4');

  // Get video info
  const { stdout: infoJson } = await execFileAsync('yt-dlp', [
    '--dump-json', '--no-warnings', '--proxy', PROXY_URL, url,
  ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
  const info = JSON.parse(infoJson);
  await setStepProgress(projectId, { percent: 5, title: info.title, duration: info.duration });

  // Download with progress
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', outputPath, '--no-warnings', '--no-playlist', '--newline',
      '--proxy', PROXY_URL, url,
    ]);

    let lastPct = 5;
    proc.stdout.on('data', (data: Buffer) => {
      const match = data.toString().match(/(\d+(?:\.\d+)?)%/);
      if (match) {
        const pct = Math.round(parseFloat(match[1]));
        if (pct > lastPct + 4) {
          lastPct = pct;
          setStepProgress(projectId, { percent: pct, title: info.title }).catch(() => {});
        }
      }
    });
    proc.stderr.on('data', (data: Buffer) => {
      const match = data.toString().match(/(\d+(?:\.\d+)?)%/);
      if (match) {
        const pct = Math.round(parseFloat(match[1]));
        if (pct > lastPct + 4) {
          lastPct = pct;
          setStepProgress(projectId, { percent: pct }).catch(() => {});
        }
      }
    });

    const timeout = setTimeout(() => { proc.kill(); reject(new Error('Download timed out')); }, 600000);
    proc.on('close', (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}`)); });
    proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });

  // Get duration
  const { stdout: probeJson } = await execFileAsync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', outputPath,
  ], { timeout: 30000 });
  const duration = parseFloat(JSON.parse(probeJson).format.duration);

  const stats = fs.statSync(outputPath);
  await setStepDone(projectId, { source_path: outputPath, source_url: url, video_duration: duration });
  await logStep(projectId, 'download', 'done', `Downloaded ${(stats.size / 1e6).toFixed(0)}MB, ${Math.round(duration)}s`, {
    size: stats.size, duration, title: info.title,
  });
}

export const maxDuration = 600;
