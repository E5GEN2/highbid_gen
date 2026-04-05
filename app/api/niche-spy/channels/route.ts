import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/channels
 * Aggregated channel data for a niche.
 * Params: keyword, sort (views|videos|subs|newest), limit, offset, maxAge (days)
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const sp = req.nextUrl.searchParams;

  const keyword = sp.get('keyword');
  const sort = sp.get('sort') || 'views';
  const limit = Math.min(parseInt(sp.get('limit') || '60'), 200);
  const offset = parseInt(sp.get('offset') || '0');
  const maxAge = sp.get('maxAge'); // filter channels created within N days
  const minScore = parseInt(sp.get('minScore') || '0');

  const conditions: string[] = ['channel_name IS NOT NULL', "channel_name != ''"];
  const params: (string | number)[] = [];
  let idx = 1;

  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $${idx}`);
    params.push(keyword);
    idx++;
  }
  if (minScore > 0) {
    conditions.push(`score >= $${idx}`);
    params.push(minScore);
    idx++;
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  // Channel age filter (applied in HAVING since it uses aggregate)
  let havingClause = '';
  if (maxAge) {
    havingClause = `HAVING MAX(channel_created_at) > NOW() - INTERVAL '${parseInt(maxAge)} days'`;
  }

  let orderBy: string;
  switch (sort) {
    case 'videos': orderBy = 'video_count DESC'; break;
    case 'subs': orderBy = 'max_subs DESC NULLS LAST'; break;
    case 'newest': orderBy = 'channel_age_days ASC NULLS LAST'; break;
    case 'score': orderBy = 'avg_score DESC'; break;
    default: orderBy = 'total_views DESC NULLS LAST';
  }

  const limitIdx = idx;
  const offsetIdx = idx + 1;
  params.push(limit, offset);

  const [channelsRes, countRes, statsRes] = await Promise.all([
    pool.query(`
      SELECT
        channel_name,
        MAX(channel_avatar) as channel_avatar,
        MAX(channel_id) as channel_id,
        COUNT(*) as video_count,
        SUM(view_count) as total_views,
        ROUND(AVG(view_count)) as avg_views,
        MAX(view_count) as max_views,
        ROUND(AVG(score)) as avg_score,
        MAX(score) as max_score,
        MAX(subscriber_count) as max_subs,
        SUM(like_count) as total_likes,
        SUM(comment_count) as total_comments,
        MAX(channel_created_at) as channel_created_at,
        EXTRACT(DAY FROM NOW() - MAX(channel_created_at)) as channel_age_days,
        MAX(posted_at) as latest_video_at,
        MIN(posted_at) as earliest_video_at,
        ARRAY_AGG(DISTINCT keyword) FILTER (WHERE keyword IS NOT NULL) as keywords
      FROM niche_spy_videos
      ${where}
      GROUP BY channel_name
      ${havingClause}
      ORDER BY ${orderBy}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, params),

    pool.query(`
      SELECT COUNT(*) as cnt FROM (
        SELECT channel_name FROM niche_spy_videos ${where}
        GROUP BY channel_name ${havingClause}
      ) sub
    `, params.slice(0, -2)),

    pool.query(`
      SELECT
        COUNT(DISTINCT channel_name) as total_channels,
        COUNT(DISTINCT channel_name) FILTER (WHERE channel_created_at > NOW() - INTERVAL '180 days') as new_channels,
        COUNT(DISTINCT channel_name) FILTER (WHERE channel_created_at > NOW() - INTERVAL '30 days') as very_new_channels,
        COUNT(DISTINCT channel_name) FILTER (WHERE channel_created_at <= NOW() - INTERVAL '180 days' OR channel_created_at IS NULL) as established_channels,
        ROUND(AVG(subscriber_count) FILTER (WHERE channel_created_at > NOW() - INTERVAL '180 days'), 0) as new_avg_subs,
        ROUND(AVG(subscriber_count) FILTER (WHERE channel_created_at <= NOW() - INTERVAL '180 days'), 0) as est_avg_subs
      FROM niche_spy_videos
      ${where} AND channel_name IS NOT NULL
    `, params.slice(0, -2)),
  ]);

  return NextResponse.json({
    channels: channelsRes.rows.map(r => ({
      channelName: r.channel_name,
      channelAvatar: r.channel_avatar || null,
      channelId: r.channel_id || null,
      videoCount: parseInt(r.video_count),
      totalViews: parseInt(r.total_views) || 0,
      avgViews: parseInt(r.avg_views) || 0,
      maxViews: parseInt(r.max_views) || 0,
      avgScore: parseInt(r.avg_score) || 0,
      maxScore: parseInt(r.max_score) || 0,
      subscribers: parseInt(r.max_subs) || 0,
      totalLikes: parseInt(r.total_likes) || 0,
      totalComments: parseInt(r.total_comments) || 0,
      channelCreatedAt: r.channel_created_at,
      channelAgeDays: r.channel_age_days ? Math.round(parseFloat(r.channel_age_days)) : null,
      latestVideoAt: r.latest_video_at,
      earliestVideoAt: r.earliest_video_at,
      keywords: r.keywords || [],
    })),
    total: parseInt(countRes.rows[0].cnt),
    stats: {
      totalChannels: parseInt(statsRes.rows[0].total_channels),
      newChannels: parseInt(statsRes.rows[0].new_channels),
      veryNewChannels: parseInt(statsRes.rows[0].very_new_channels),
      establishedChannels: parseInt(statsRes.rows[0].established_channels),
      newAvgSubs: parseInt(statsRes.rows[0].new_avg_subs) || 0,
      estAvgSubs: parseInt(statsRes.rows[0].est_avg_subs) || 0,
    },
  });
}
