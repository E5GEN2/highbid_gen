import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/keywords
 * Returns keyword cards with aggregated stats for the niche selector.
 * Params: search?, sort? (videos|score|views|channels), limit?
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const sp = req.nextUrl.searchParams;
  const search = sp.get('search') || '';
  const sort = sp.get('sort') || 'videos';
  const limit = Math.min(parseInt(sp.get('limit') || '100'), 500);

  const conditions = ["keyword IS NOT NULL", "keyword != ''"];
  const params: (string | number)[] = [];
  let idx = 1;

  if (search) {
    conditions.push(`keyword ILIKE $${idx}`);
    params.push(`%${search}%`);
    idx++;
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  let orderBy: string;
  switch (sort) {
    case 'score': orderBy = 'avg_score DESC'; break;
    case 'views': orderBy = 'total_views DESC'; break;
    case 'channels': orderBy = 'channel_count DESC'; break;
    case 'newest': orderBy = 'newest_video DESC NULLS LAST'; break;
    default: orderBy = 'video_count DESC';
  }

  params.push(limit);

  const result = await pool.query(`
    SELECT
      keyword,
      COUNT(*) as video_count,
      COUNT(DISTINCT channel_name) as channel_count,
      ROUND(AVG(score)) as avg_score,
      SUM(view_count) as total_views,
      ROUND(AVG(view_count)) as avg_views,
      MAX(view_count) as max_views,
      COUNT(*) FILTER (WHERE score >= 80) as high_score_count,
      COUNT(*) FILTER (WHERE channel_created_at > NOW() - INTERVAL '180 days') as new_channel_videos,
      COUNT(DISTINCT channel_name) FILTER (WHERE channel_created_at > NOW() - INTERVAL '180 days') as new_channel_count,
      MAX(posted_at) as newest_video,
      MIN(posted_at) as oldest_video
    FROM niche_spy_videos
    ${where}
    GROUP BY keyword
    ORDER BY ${orderBy}
    LIMIT $${idx}
  `, params);

  // Also get saturation data
  const satResult = await pool.query(`
    SELECT DISTINCT ON (keyword) keyword, global_saturation_pct, run_saturation_pct
    FROM niche_saturation_runs
    ORDER BY keyword, run_at DESC
  `);
  const satMap = new Map(satResult.rows.map(r => [r.keyword, {
    globalSaturation: parseFloat(r.global_saturation_pct),
    runSaturation: parseFloat(r.run_saturation_pct),
  }]));

  return NextResponse.json({
    keywords: result.rows.map(r => ({
      keyword: r.keyword,
      videoCount: parseInt(r.video_count),
      channelCount: parseInt(r.channel_count),
      avgScore: parseInt(r.avg_score) || 0,
      totalViews: parseInt(r.total_views) || 0,
      avgViews: parseInt(r.avg_views) || 0,
      maxViews: parseInt(r.max_views) || 0,
      highScoreCount: parseInt(r.high_score_count),
      newChannelVideos: parseInt(r.new_channel_videos),
      newChannelCount: parseInt(r.new_channel_count),
      newestVideo: r.newest_video,
      oldestVideo: r.oldest_video,
      saturation: satMap.get(r.keyword) || null,
    })),
    total: result.rows.length,
  });
}
