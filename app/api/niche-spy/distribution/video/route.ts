import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/distribution/video?id=123
 * Returns full video + channel details for the scatter hover card.
 * JOINs niche_spy_channels so consumers get first_upload_at / dormancy_days
 * without a second query.
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const pool = await getPool();
  const res = await pool.query(`
    SELECT v.id, v.channel_name, v.channel_id, v.subscriber_count, v.view_count, v.score,
           v.channel_created_at, v.url, v.title, v.like_count, v.comment_count,
           v.posted_at, v.posted_date, v.keyword, v.embedded_at, v.top_comment,
           c.first_upload_at, c.dormancy_days
    FROM niche_spy_videos v
    LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
    WHERE v.id = $1
  `, [id]);

  if (res.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const r = res.rows[0];
  const vidMatch = r.url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  const createdAt = r.channel_created_at ? new Date(r.channel_created_at) : null;
  const firstUpload = r.first_upload_at ? new Date(r.first_upload_at) : null;
  // Active age (first upload) wins; fallback to creation age so cards always have a number.
  const activeAge = firstUpload ? Math.floor((Date.now() - firstUpload.getTime()) / 86400000) : null;
  const creationAge = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86400000) : null;
  const ageDays = activeAge ?? creationAge;

  return NextResponse.json({
    id: r.id,
    name: r.channel_name,
    channelId: r.channel_id || null,
    subs: parseInt(r.subscriber_count) || 0,
    views: parseInt(r.view_count) || 0,
    avgScore: parseInt(r.score) || 0,
    ageDays,
    creationAgeDays: creationAge,
    firstUploadAt: r.first_upload_at || null,
    dormancyDays: r.dormancy_days !== null ? parseInt(r.dormancy_days) : null,
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
