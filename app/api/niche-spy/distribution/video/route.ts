import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/distribution/video?id=123
 * Returns full video details for a single video (on-demand, when dot is hovered/clicked).
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const pool = await getPool();
  const res = await pool.query(`
    SELECT v.id, v.channel_name, v.channel_id,
           COALESCE(cs.max_subs, v.subscriber_count, 0) as subscriber_count,
           v.view_count, v.score, v.channel_created_at, v.url, v.title,
           v.like_count, v.comment_count, v.posted_at, v.posted_date,
           v.keyword, v.embedded_at, v.top_comment
    FROM niche_spy_videos v
    LEFT JOIN (
      SELECT channel_name, MAX(subscriber_count) as max_subs
      FROM niche_spy_videos WHERE channel_name = (SELECT channel_name FROM niche_spy_videos WHERE id = $1)
      GROUP BY channel_name
    ) cs ON cs.channel_name = v.channel_name
    WHERE v.id = $1
  `, [id]);

  if (res.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const r = res.rows[0];
  const vidMatch = r.url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  const createdAt = r.channel_created_at ? new Date(r.channel_created_at) : null;

  return NextResponse.json({
    id: r.id,
    name: r.channel_name,
    channelId: r.channel_id || null,
    subs: parseInt(r.subscriber_count) || 0,
    views: parseInt(r.view_count) || 0,
    avgScore: parseInt(r.score) || 0,
    ageDays: createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86400000) : null,
    videoUrl: r.url || null,
    videoTitle: r.title || null,
    thumbnail: vidMatch ? `https://img.youtube.com/vi/${vidMatch[1]}/hqdefault.jpg` : null,
    likeCount: parseInt(r.like_count) || 0,
    commentCount: parseInt(r.comment_count) || 0,
    postedAt: r.posted_at || null,
    postedDate: r.posted_date || null,
    keyword: r.keyword || null,
    embeddedAt: r.embedded_at || null,
    topComment: r.top_comment || null,
  });
}
