import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { enrichSingleVideo } from '@/lib/yt-enrich';

/**
 * POST /api/niche-spy/enrich-one
 * Body: { videoId: number }
 *
 * Enrich a single video (refresh its data) using YT Data API via xgodo proxy.
 * Returns the updated video data.
 *
 * Public endpoint — anyone viewing the grid can refresh a card's data.
 */
export async function POST(req: NextRequest) {
  const pool = await getPool();
  const { videoId } = await req.json().catch(() => ({}));

  if (!videoId || typeof videoId !== 'number') {
    return NextResponse.json({ error: 'videoId (number) required' }, { status: 400 });
  }

  // Look up video URL
  const vidRes = await pool.query(
    'SELECT id, url FROM niche_spy_videos WHERE id = $1',
    [videoId]
  );
  if (vidRes.rows.length === 0) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const url = vidRes.rows[0].url as string | null;
  const ytIdMatch = url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!ytIdMatch) {
    return NextResponse.json({ error: 'Could not extract YouTube ID from URL' }, { status: 400 });
  }
  const ytVideoId = ytIdMatch[1];

  // Get YouTube API key (rotate by random pick to spread load)
  const multiKeyRes = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_yt_api_keys'");
  const singleKeyRes = await pool.query("SELECT value FROM admin_config WHERE key = 'youtube_api_key'");
  const ytApiKeys = (multiKeyRes.rows[0]?.value || '')
    .split('\n').map((k: string) => k.trim()).filter((k: string) => k.length > 10);
  if (ytApiKeys.length === 0 && singleKeyRes.rows[0]?.value) ytApiKeys.push(singleKeyRes.rows[0].value);
  if (ytApiKeys.length === 0) {
    return NextResponse.json({ error: 'No YouTube API keys configured' }, { status: 500 });
  }
  const ytApiKey = ytApiKeys[Math.floor(Math.random() * ytApiKeys.length)];

  try {
    const result = await enrichSingleVideo(pool, videoId, ytVideoId, ytApiKey);

    if (!result.ok) {
      return NextResponse.json({ error: result.error, proxy: result.proxy }, { status: 502 });
    }

    // Return the updated row
    const updatedRes = await pool.query(
      `SELECT id, keyword, url, title, view_count, channel_name, posted_date, posted_at, score,
              channel_created_at, embedded_at, subscriber_count, like_count, comment_count,
              top_comment, thumbnail, fetched_at
       FROM niche_spy_videos WHERE id = $1`,
      [videoId]
    );

    return NextResponse.json({
      ok: true,
      proxy: result.proxy,
      channelEnriched: result.channelEnriched,
      video: updatedRes.rows[0] || null,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
