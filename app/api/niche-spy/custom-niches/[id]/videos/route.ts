import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * Videos inside a single custom niche, hydrated with the same row
 * shape /api/niche-spy/favourites returns so the favourites Videos
 * grid renders without conversion.
 *
 * GET /api/niche-spy/custom-niches/[id]/videos
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
