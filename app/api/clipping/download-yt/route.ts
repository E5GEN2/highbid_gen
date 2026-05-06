import { NextRequest, NextResponse } from 'next/server';
import { getApiUser } from '@/lib/api-auth';
import { CLIPS_DIR } from '@/lib/clips-dir';
import { getProxy } from '@/lib/xgodo-proxy';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * POST /api/clipping/download-yt
 * Download a YouTube video via yt-dlp with SSE progress reporting.
 * Body: { projectId, url }
 * Returns SSE stream: progress events, then complete event with file info.
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { projectId, url } = await req.json();
  if (!projectId || !url) {
    return NextResponse.json({ error: 'projectId and url required' }, { status: 400 });
  }

  if (!url.match(/(?:youtube\.com|youtu\.be)/i)) {
    return NextResponse.json({ error: 'Not a valid YouTube URL' }, { status: 400 });
  }

  const dir = path.join(CLIPS_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const outputPath = path.join(dir, 'source.mp4');

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { closed = true; }
      };

      try {
        // Pick a fresh proxy from the dealer pool. Same one is reused
        // for the dump-json + download below so the YouTube session
        // stays consistent across calls.
        const proxy = await getProxy();
        if (!proxy) {
          send('error', { error: 'No proxy available — check xgodo dealer config' });
          controller.close();
          return;
        }
        const proxyUrl = proxy.url;

        // Step 1: Get video info
        send('progress', { step: 'info', message: 'Fetching video info...' });

        const { stdout: infoJson } = await execFileAsync('yt-dlp', [
          '--dump-json', '--no-warnings', '--proxy', proxyUrl, url,
        ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });

        const info = JSON.parse(infoJson);
        const title = info.title || 'Untitled';
        const duration = info.duration || 0;
        const filesize = info.filesize_approx || 0;

        send('progress', {
          step: 'info',
          message: `Found: ${title}`,
          title, duration, filesize,
        });

        // Step 2: Download with progress tracking
        send('progress', { step: 'download', message: 'Starting download...', percent: 0 });

        await new Promise<void>((resolve, reject) => {
          const proc = spawn('yt-dlp', [
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--merge-output-format', 'mp4',
            '-o', outputPath,
            '--no-warnings',
            '--no-playlist',
            '--newline',  // Force progress on new lines
            '--proxy', proxyUrl,
            url,
          ]);

          let lastPct = 0;
          let stderrBuf = '';

          proc.stderr.on('data', (data: Buffer) => {
            const line = data.toString();
            stderrBuf += line;
            // Parse yt-dlp progress: [download]  45.2% of ~111.00MiB at 2.50MiB/s ETA 00:25
            const pctMatch = line.match(/(\d+(?:\.\d+)?)%/);
            if (pctMatch) {
              const pct = Math.round(parseFloat(pctMatch[1]));
              if (pct > lastPct) {
                lastPct = pct;
                const etaMatch = line.match(/ETA\s+(\S+)/);
                send('progress', {
                  step: 'download',
                  message: `Downloading...${pct}%`,
                  percent: pct,
                  eta: etaMatch ? etaMatch[1] : undefined,
                });
              }
            }
          });

          proc.stdout.on('data', (data: Buffer) => {
            const line = data.toString();
            const pctMatch = line.match(/(\d+(?:\.\d+)?)%/);
            if (pctMatch) {
              const pct = Math.round(parseFloat(pctMatch[1]));
              if (pct > lastPct) {
                lastPct = pct;
                send('progress', { step: 'download', message: `Downloading...${pct}%`, percent: pct });
              }
            }
          });

          const timeout = setTimeout(() => {
            proc.kill();
            reject(new Error('Download timed out after 5 minutes'));
          }, 300000);

          proc.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) resolve();
            else reject(new Error(`yt-dlp exited with code ${code}: ${stderrBuf.substring(stderrBuf.length - 500)}`));
          });

          proc.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        const stats = fs.statSync(outputPath);

        send('complete', {
          url: `file://${outputPath}`,
          path: outputPath,
          size: stats.size,
          title,
          duration,
        });

      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Download failed';
        console.error('yt-dlp error:', msg);
        send('error', { error: msg });
      } finally {
        if (!closed) try { controller.close(); } catch { /* already closed */ }
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

export const maxDuration = 300;
