import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { auth } from '@/lib/auth';

/**
 * Favourites — PER-USER starred-video list (scoped by session user_id;
 * was a single global list before 2026-07-14). GET degrades to empty when
 * logged out (so pages render); writes require a session.
 *
 * GET    /api/niche-spy/favourites           → this user's video rows, JOINed with channels
 * GET    /api/niche-spy/favourites?onlyIds=1 → just this user's ids (light, for star state)
 * POST   /api/niche-spy/favourites  body {videoId} → star (for this user)
 * DELETE /api/niche-spy/favourites  body {videoId} → unstar (for this user)
 */

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  const onlyIds = req.nextUrl.searchParams.get('onlyIds') === '1';
  const pool = await getPool();

  if (!userId) {
    // Logged out → no favourites (don't 401 a GET; let the page render empty).
    return onlyIds ? NextResponse.json({ ids: [] }) : NextResponse.json({ videos: [], total: 0, similaritySource: 'title_v1' });
  }

  if (onlyIds) {
    const res = await pool.query(`SELECT video_id FROM niche_spy_favourites WHERE user_id = $1 ORDER BY added_at DESC`, [userId]);
    return NextResponse.json({ ids: res.rows.map((r: { video_id: number }) => r.video_id) });
  }

  const res = await pool.query(`
    SELECT v.id, v.keyword, v.url, v.title, v.view_count, v.channel_name,
           v.posted_date, v.posted_at, v.score, v.subscriber_count, v.like_count,
           v.comment_count, v.top_comment, v.thumbnail, v.fetched_at,
           v.channel_created_at,
           v.embedded_at,
           v.title_embedded_v2_at,
           v.thumbnail_embedded_v2_at,
           c.first_upload_at, c.dormancy_days,
           f.added_at
    FROM niche_spy_favourites f
    JOIN niche_spy_videos v ON v.id = f.video_id
    LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
    WHERE f.user_id = $1
    ORDER BY f.added_at DESC
  `, [userId]);

  const simSrcRes = await pool.query(
    "SELECT value FROM admin_config WHERE key = 'niche_similarity_source'"
  );
  const similaritySource = (simSrcRes.rows[0]?.value || 'title_v1') as
    'title_v1' | 'title_v2' | 'thumbnail_v2';

  return NextResponse.json({ videos: res.rows, total: res.rows.length, similaritySource });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const pool = await getPool();
  const { videoId } = await req.json().catch(() => ({}));
  if (!videoId || typeof videoId !== 'number') {
    return NextResponse.json({ error: 'videoId (number) required' }, { status: 400 });
  }
  const check = await pool.query('SELECT 1 FROM niche_spy_videos WHERE id = $1', [videoId]);
  if (check.rows.length === 0) return NextResponse.json({ error: 'Video not found' }, { status: 404 });

  await pool.query(
    `INSERT INTO niche_spy_favourites (user_id, video_id) VALUES ($1, $2) ON CONFLICT (user_id, video_id) DO NOTHING`,
    [session.user.id, videoId]
  );
  return NextResponse.json({ ok: true, starred: true });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const pool = await getPool();
  const { videoId } = await req.json().catch(() => ({}));
  if (!videoId || typeof videoId !== 'number') {
    return NextResponse.json({ error: 'videoId (number) required' }, { status: 400 });
  }
  await pool.query(`DELETE FROM niche_spy_favourites WHERE user_id = $1 AND video_id = $2`, [session.user.id, videoId]);
  return NextResponse.json({ ok: true, starred: false });
}
