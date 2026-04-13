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
    SELECT id, channel_name, channel_id, subscriber_count, view_count, score,
           channel_created_at, url, title, like_count, comment_count,
           posted_at, posted_date, keyword, embedded_at, top_comment
    FROM niche_spy_videos WHERE id = $1
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
