import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/listeners/feed?id=1&limit=50
 * What a listener has heard: newest uploads first, with channel context.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  const limit = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('limit') || '50'), 1), 200);
  const pool = await getPool();
  const r = await pool.query(
    `SELECT lv.detected_at, lv.yt_video_id, v.title, v.url, v.view_count,
            c.channel_name, c.subscriber_count, lv.channel_id
       FROM listener_videos lv
       LEFT JOIN niche_spy_videos v ON v.id = lv.video_id
       LEFT JOIN niche_spy_channels c ON c.channel_id = lv.channel_id
      WHERE lv.listener_id = $1
      ORDER BY lv.detected_at DESC LIMIT $2`,
    [parseInt(id), limit],
  );
  return NextResponse.json({ ok: true, count: r.rows.length, videos: r.rows });
}
