import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * Favourites — a single global starred-video list (no per-user scoping).
 *
 * GET    /api/niche-spy/favourites           → full video rows, JOINed with channels
 * GET    /api/niche-spy/favourites?onlyIds=1 → just the array of ids (light, for star state)
 * POST   /api/niche-spy/favourites  body {videoId} → star
 * DELETE /api/niche-spy/favourites  body {videoId} → unstar
 */

export async function GET(req: NextRequest) {
  const pool = await getPool();
  const onlyIds = req.nextUrl.searchParams.get('onlyIds') === '1';

  if (onlyIds) {
    const res = await pool.query(`SELECT video_id FROM niche_spy_favourites ORDER BY added_at DESC`);
    return NextResponse.json({ ids: res.rows.map((r: { video_id: number }) => r.video_id) });
  }

  const res = await pool.query(`
    SELECT v.id, v.keyword, v.url, v.title, v.view_count, v.channel_name,
           v.posted_date, v.posted_at, v.score, v.subscriber_count, v.like_count,
           v.comment_count, v.top_comment, v.thumbnail, v.fetched_at,
           v.channel_created_at,
           -- All three embedding flags so the client can show the Similar
           -- button based on the currently-active similarity source.
           v.embedded_at,
           v.title_embedded_v2_at,
           v.thumbnail_embedded_v2_at,
           c.first_upload_at, c.dormancy_days,
           f.added_at
    FROM niche_spy_favourites f
    JOIN niche_spy_videos v ON v.id = f.video_id
    LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
    ORDER BY f.added_at DESC
  `);

  // Active similarity source — same reason as /api/niche-spy. Lets the
  // client check the right embedded_at flag for the Similar button.
  const simSrcRes = await pool.query(
    "SELECT value FROM admin_config WHERE key = 'niche_similarity_source'"
  );
  const similaritySource = (simSrcRes.rows[0]?.value || 'title_v1') as
    'title_v1' | 'title_v2' | 'thumbnail_v2';

  return NextResponse.json({
    videos: res.rows,
    total: res.rows.length,
    similaritySource,
  });
}

export async function POST(req: NextRequest) {
  const pool = await getPool();
  const { videoId } = await req.json().catch(() => ({}));
  if (!videoId || typeof videoId !== 'number') {
    return NextResponse.json({ error: 'videoId (number) required' }, { status: 400 });
  }
  // Defence: refuse if the video doesn't exist
  const check = await pool.query('SELECT 1 FROM niche_spy_videos WHERE id = $1', [videoId]);
  if (check.rows.length === 0) return NextResponse.json({ error: 'Video not found' }, { status: 404 });

  await pool.query(
    `INSERT INTO niche_spy_favourites (video_id) VALUES ($1) ON CONFLICT (video_id) DO NOTHING`,
    [videoId]
  );
  return NextResponse.json({ ok: true, starred: true });
}

export async function DELETE(req: NextRequest) {
  const pool = await getPool();
  const { videoId } = await req.json().catch(() => ({}));
  if (!videoId || typeof videoId !== 'number') {
    return NextResponse.json({ error: 'videoId (number) required' }, { status: 400 });
  }
  await pool.query(`DELETE FROM niche_spy_favourites WHERE video_id = $1`, [videoId]);
  return NextResponse.json({ ok: true, starred: false });
}
