import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

// Dynamic — we stream upstream bytes through per-request, no caching.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/vizard/clips/:id/video
 *
 * Streams a Vizard clip's mp4 bytes back with content-disposition rewritten
 * to "inline". Vizard's CloudFront URL is signed with Expires+Signature query
 * params and serves `content-disposition: attachment`, which blocks inline
 * <video> playback in several browsers. We can't override via a query param
 * (the signature is computed over the full URL and would reject it), so we
 * proxy instead.
 *
 * Forwards the Range header so <video> seek / scrub / preload still works —
 * without Range passthrough, the browser would redownload the whole file on
 * every scrub and metadata load would be slow on large clips.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const clipId = parseInt(id);
  if (Number.isNaN(clipId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  const pool = await getPool();
  const res = await pool.query<{ video_url: string | null }>(
    `SELECT video_url FROM vizard_clips WHERE id = $1`,
    [clipId]
  );
  const videoUrl = res.rows[0]?.video_url;
  if (!videoUrl) {
    return NextResponse.json({ error: 'clip not found or missing url' }, { status: 404 });
  }

  // Forward Range so <video> seek/scrub keeps working.
  const upstreamHeaders: Record<string, string> = {};
  const range = req.headers.get('range');
  if (range) upstreamHeaders['range'] = range;

  const upstream = await fetch(videoUrl, { headers: upstreamHeaders });
  if (!upstream.ok && upstream.status !== 206) {
    return NextResponse.json(
      { error: `upstream ${upstream.status}` },
      { status: upstream.status }
    );
  }

  // Propagate status (206 Partial Content on Range requests), media headers,
  // Range headers — but rewrite content-disposition to 'inline' so the
  // browser renders it in the <video> element instead of downloading.
  const outHeaders = new Headers();
  const passthrough = [
    'content-type',
    'content-length',
    'accept-ranges',
    'content-range',
    'cache-control',
    'etag',
    'last-modified',
  ];
  for (const h of passthrough) {
    const v = upstream.headers.get(h);
    if (v) outHeaders.set(h, v);
  }
  outHeaders.set('content-disposition', 'inline');

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}
