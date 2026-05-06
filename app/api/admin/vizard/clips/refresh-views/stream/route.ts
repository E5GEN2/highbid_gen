import { NextRequest } from 'next/server';
import { refreshClipViewCounts, type RefreshClipViewsProgress } from '@/lib/yt-clip-views';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * POST /api/admin/vizard/clips/refresh-views/stream
 *
 * SSE variant of the refresh-views endpoint. Streams `progress` events
 * after each videos.list batch (one per 50 clips) so the admin UI can
 * drive a live progress bar, then a final `done` event.
 *
 * Body: same shape as the non-streaming endpoint
 *   { clipIds?: number[], force?: boolean, staleMinutes?: number }
 *
 * Output (SSE):
 *   event: progress  data: { totalBatches, completedBatches, totalClips, updated, errors, calls }
 *   event: done      data: { ok: true, totalClips, updated, errors, calls }
 *   event: error     data: { error: string }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    clipIds?: number[];
    force?: boolean;
    staleMinutes?: number;
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        const result = await refreshClipViewCounts({
          clipIds: body.clipIds,
          force: body.force,
          staleMinutes: body.staleMinutes,
          onProgress: (p: RefreshClipViewsProgress) => send('progress', p),
        });
        if (result.ok === false) {
          send('error', { error: result.error });
        } else {
          send('done', result);
        }
      } catch (err) {
        send('error', { error: (err as Error).message });
      } finally {
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Prevent proxies from buffering the stream
      'X-Accel-Buffering': 'no',
    },
  });
}
