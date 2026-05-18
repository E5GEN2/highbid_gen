import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * Videos inside a single custom niche.
 *
 * GET  /api/niche-spy/custom-niches/[id]/videos
 *   → hydrated rows in the same shape /api/niche-spy/favourites
 *     returns so the favourites Videos grid renders without
 *     conversion.
 *
 * POST /api/niche-spy/custom-niches/[id]/videos
 *   body: { videoIds: number[] }
 *   → bulk-add the supplied videos to this niche. Existing
 *     memberships are left alone (ON CONFLICT DO NOTHING) so it's
 *     idempotent. Used by the "Add from Favourites" modal on the
 *     niche detail page.
 *
 * Pattern lives here (not on the membership endpoint) because that
 * endpoint is per-video — replacing the full membership set for
 * one video at a time. Bulk-add is the inverse axis: one niche,
 * many videos.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const pool = await getPool();
  // Defence: refuse if the niche doesn't exist (404 is more useful than
  // an empty list when the caller passed a bad id).
  const exists = await pool.query('SELECT 1 FROM custom_niches WHERE id = $1', [nicheId]);
  if (exists.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const r = await pool.query(`
    SELECT v.id, v.keyword, v.url, v.title, v.view_count, v.channel_name,
           v.posted_date, v.posted_at, v.score, v.subscriber_count, v.like_count,
           v.comment_count, v.top_comment, v.thumbnail, v.fetched_at,
           v.channel_created_at,
           v.embedded_at, v.title_embedded_v2_at, v.thumbnail_embedded_v2_at,
           c.first_upload_at, c.dormancy_days,
           m.added_at
      FROM custom_niche_videos m
      JOIN niche_spy_videos v ON v.id = m.video_id
      LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
     WHERE m.custom_niche_id = $1
     ORDER BY m.added_at DESC
  `, [nicheId]);

  return NextResponse.json({ videos: r.rows, total: r.rows.length });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const body = await req.json().catch(() => ({})) as { videoIds?: unknown };
  const videoIds = Array.isArray(body.videoIds)
    ? body.videoIds.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  if (videoIds.length === 0) {
    return NextResponse.json({ error: 'videoIds (number[]) required' }, { status: 400 });
  }
  // Cap the batch size — keeps the SQL parameter list bounded and
  // prevents accidental "select all my favourites" runs that
  // wouldn't be useful anyway. 500 is generous; the favourites
  // surface tops out at ~hundreds in practice.
  if (videoIds.length > 500) {
    return NextResponse.json({ error: 'max 500 videos per request' }, { status: 400 });
  }

  const pool = await getPool();
  const exists = await pool.query('SELECT 1 FROM custom_niches WHERE id = $1', [nicheId]);
  if (exists.rows.length === 0) return NextResponse.json({ error: 'niche not found' }, { status: 404 });

  // VALUES (..., ..., $N) ... — one row per video id, plus the
  // niche id at the end (re-used across all rows).
  const placeholders = videoIds.map((_, i) => `($${videoIds.length + 1}, $${i + 1})`).join(',');
  const r = await pool.query(
    `INSERT INTO custom_niche_videos (custom_niche_id, video_id) VALUES ${placeholders}
     ON CONFLICT DO NOTHING
     RETURNING video_id`,
    [...videoIds, nicheId],
  );
  // Bump updated_at so the niche surfaces at the top of My Niches.
  if (r.rowCount && r.rowCount > 0) {
    await pool.query('UPDATE custom_niches SET updated_at = NOW() WHERE id = $1', [nicheId]);
  }

  return NextResponse.json({
    ok: true,
    added: r.rowCount ?? 0,
    skipped: videoIds.length - (r.rowCount ?? 0),
  });
}
