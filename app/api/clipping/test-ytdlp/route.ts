import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PROXY_URL = 'http://dce70f86-5501-4da9-a8c8-ea48f4418da6:QFZmMFWSWnQASZYy@xgodo.com:3008';

/**
 * GET /api/clipping/test-ytdlp?url=...&action=info|download
 * Debug endpoint — test yt-dlp on Railway. No auth required.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url') || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const action = req.nextUrl.searchParams.get('action') || 'info';

  try {
    // Check yt-dlp version
    const { stdout: version } = await execFileAsync('yt-dlp', ['--version'], { timeout: 5000 });

    if (action === 'info') {
      const { stdout, stderr } = await execFileAsync('yt-dlp', [
        '--dump-json', '--proxy', PROXY_URL, url,
      ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });

      const info = JSON.parse(stdout);
      return NextResponse.json({
        ok: true,
        ytdlp_version: version.trim(),
        title: info.title,
        duration: info.duration,
        filesize_approx: info.filesize_approx,
        formats_count: info.formats?.length,
      });
    }

    if (action === 'download') {
      const outputPath = `/tmp/clips/test-ytdlp-${Date.now()}.mp4`;
      const { stdout, stderr } = await execFileAsync('yt-dlp', [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', outputPath,
        '--no-warnings', '--no-playlist',
        '--proxy', PROXY_URL,
        url,
      ], { timeout: 300000, maxBuffer: 10 * 1024 * 1024 });

      const fs = await import('fs');
      const exists = fs.existsSync(outputPath);
      const size = exists ? fs.statSync(outputPath).size : 0;

      return NextResponse.json({
        ok: true,
        ytdlp_version: version.trim(),
        outputPath,
        exists,
        size,
        stdout: stdout.substring(0, 500),
        stderr: stderr.substring(0, 500),
      });
    }

    // Version check only
    return NextResponse.json({ ok: true, ytdlp_version: version.trim() });

  } catch (err) {
    const error = err as { message?: string; stderr?: string; stdout?: string };
    return NextResponse.json({
      ok: false,
      error: error.message?.substring(0, 500),
      stderr: error.stderr?.substring(0, 1000),
      stdout: error.stdout?.substring(0, 500),
    }, { status: 500 });
  }
}

export const maxDuration = 300;
