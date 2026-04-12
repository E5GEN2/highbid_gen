import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/distribution?keyword=X&minScore=80
 * Returns subscriber + views distribution buckets in a single fast query.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const keyword = req.nextUrl.searchParams.get('keyword') || '';
  const minScore = parseInt(req.nextUrl.searchParams.get('minScore') || '80');

  // Subscriber distribution — bucketed in SQL, returns 6 rows max
  const subsRes = await pool.query(`
    SELECT
      CASE
        WHEN subscriber_count IS NULL OR subscriber_count = 0 THEN '0'
        WHEN subscriber_count < 1000 THEN '1-1K'
        WHEN subscriber_count < 10000 THEN '1K-10K'
        WHEN subscriber_count < 100000 THEN '10K-100K'
        WHEN subscriber_count < 1000000 THEN '100K-1M'
        ELSE '1M+'
      END as bucket,
      COUNT(DISTINCT channel_name) as count
    FROM niche_spy_videos
    WHERE keyword = $1 AND score >= $2 AND channel_name IS NOT NULL
    GROUP BY bucket
  `, [keyword, minScore]);

  const subsBucketOrder = ['0', '1-1K', '1K-10K', '10K-100K', '100K-1M', '1M+'];
  const subsColors = ['#555', '#888', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444'];
  const subsDist = subsBucketOrder.map((label, i) => {
    const row = subsRes.rows.find(r => r.bucket === label);
    return { label, count: parseInt(row?.count || '0'), color: subsColors[i] };
  });

  // Views distribution — bucketed in SQL
  const viewsRes = await pool.query(`
    SELECT
      CASE
        WHEN view_count IS NULL OR view_count < 100 THEN '0-100'
        WHEN view_count < 1000 THEN '100-1K'
        WHEN view_count < 10000 THEN '1K-10K'
        WHEN view_count < 100000 THEN '10K-100K'
        WHEN view_count < 1000000 THEN '100K-1M'
        WHEN view_count < 10000000 THEN '1M-10M'
        ELSE '10M+'
      END as bucket,
      COUNT(*) as count
    FROM niche_spy_videos
    WHERE keyword = $1 AND score >= $2
    GROUP BY bucket
  `, [keyword, minScore]);

  const viewsBucketOrder = ['0-100', '100-1K', '1K-10K', '10K-100K', '100K-1M', '1M-10M', '10M+'];
  const viewsColors = ['#555', '#888', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#ec4899'];
  const viewsDist = viewsBucketOrder.map((label, i) => {
    const row = viewsRes.rows.find(r => r.bucket === label);
    return { label, count: parseInt(row?.count || '0'), color: viewsColors[i] };
  });

  // Channel scatter data — subs vs views, ALL channels, no limit
  const scatterRes = await pool.query(`
    SELECT
      channel_name,
      MAX(channel_id) as channel_id,
      MAX(subscriber_count) as subs,
      SUM(view_count) as total_views,
      COUNT(*) as video_count,
      ROUND(AVG(score)) as avg_score,
      MAX(channel_created_at) as channel_created_at
    FROM niche_spy_videos
    WHERE keyword = $1 AND score >= $2 AND channel_name IS NOT NULL
    GROUP BY channel_name
    HAVING MAX(subscriber_count) > 0 OR SUM(view_count) > 0
    ORDER BY SUM(view_count) DESC
  `, [keyword, minScore]);

  const scatter = scatterRes.rows.map(r => {
    const createdAt = r.channel_created_at ? new Date(r.channel_created_at) : null;
    const ageDays = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86400000) : null;
    return {
      name: r.channel_name,
      channelId: r.channel_id || null,
      subs: parseInt(r.subs) || 0,
      views: parseInt(r.total_views) || 0,
      videos: parseInt(r.video_count) || 0,
      avgScore: parseInt(r.avg_score) || 0,
      ageDays,
    };
  });

  return NextResponse.json({ subsDist, viewsDist, scatter });
}
