import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);
const CLIPS_DIR = '/tmp/clips';

// Proxy config for yt-dlp to avoid YouTube bot detection
const PROXY_URL = 'http://dce70f86-5501-4da9-a8c8-ea48f4418da6:QFZmMFWSWnQASZYy@xgodo.com:3008';

/**
 * POST /api/clipping/download-yt
 * Download a YouTube video via yt-dlp and store locally.
 * Body: { projectId, url }
 * Returns: { url: string, path: string, size: number, title: string, duration: number }
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { projectId, url } = await req.json();
  if (!projectId || !url) {
    return NextResponse.json({ error: 'projectId and url required' }, { status: 400 });
  }

  // Validate it looks like a YouTube URL
  if (!url.match(/(?:youtube\.com|youtu\.be)/i)) {
    return NextResponse.json({ error: 'Not a valid YouTube URL' }, { status: 400 });
  }

  const dir = path.join(CLIPS_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const outputPath = path.join(dir, 'source.mp4');

  try {
    // Get video info first (title, duration)
    const { stdout: infoJson } = await execFileAsync('yt-dlp', [
      '--dump-json',
      '--no-warnings',
      '--proxy', PROXY_URL,
      url,
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });

    const info = JSON.parse(infoJson);
    const title = info.title || 'Untitled';
    const duration = info.duration || 0;

    // Download video (best quality mp4, merge if needed)
    await execFileAsync('yt-dlp', [
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      '--no-warnings',
      '--no-playlist',
      '--proxy', PROXY_URL,
      url,
    ], { timeout: 300000 }); // 5 min timeout

    const stats = fs.statSync(outputPath);

    return NextResponse.json({
      url: `file://${outputPath}`,
      path: outputPath,
      size: stats.size,
      title,
      duration,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Download failed';
    console.error('yt-dlp error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export const maxDuration = 300;
