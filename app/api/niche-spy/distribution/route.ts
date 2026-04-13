import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/distribution?keyword=X&minScore=80
 * Returns subscriber + views distribution buckets + lightweight scatter data.
 * All 3 queries run in parallel. Scatter sends only dot data (x,y,score,age).
 * Full video details are fetched on-demand via /api/niche-spy/distribution/video?id=X
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const keyword = req.nextUrl.searchParams.get('keyword') || '';
  const minScore = parseInt(req.nextUrl.searchParams.get('minScore') || '80');

  // Run all 3 queries in parallel
  const [subsRes, viewsRes, scatterRes] = await Promise.all([
    // Subscriber distribution
    pool.query(`
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
    `, [keyword, minScore]),

    // Views distribution
    pool.query(`
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
    `, [keyword, minScore]),

    // Scatter — LIGHTWEIGHT: use MAX subs per channel (not per-video, which can be 0 if not enriched)
    pool.query(`
      SELECT v.id, v.channel_name as ch, COALESCE(cs.max_subs, v.subscriber_count, 0) as subs,
             v.view_count as views, v.score, v.channel_created_at,
             v.embedded_at IS NOT NULL as has_embedding
      FROM niche_spy_videos v
      LEFT JOIN (
        SELECT channel_name, MAX(subscriber_count) as max_subs
        FROM niche_spy_videos
        WHERE keyword = $1 AND score >= $2
        GROUP BY channel_name
      ) cs ON cs.channel_name = v.channel_name
      WHERE v.keyword = $1 AND v.score >= $2
        AND (COALESCE(cs.max_subs, v.subscriber_count, 0) > 0 OR v.view_count > 0)
      ORDER BY v.view_count DESC NULLS LAST
    `, [keyword, minScore]),
  ]);

  // Process subs distribution
  const subsBucketOrder = ['0', '1-1K', '1K-10K', '10K-100K', '100K-1M', '1M+'];
  const subsColors = ['#555', '#888', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444'];
  const subsDist = subsBucketOrder.map((label, i) => {
    const row = subsRes.rows.find(r => r.bucket === label);
    return { label, count: parseInt(row?.count || '0'), color: subsColors[i] };
  });

  // Process views distribution
  const viewsBucketOrder = ['0-100', '100-1K', '1K-10K', '10K-100K', '100K-1M', '1M-10M', '10M+'];
  const viewsColors = ['#555', '#888', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#ec4899'];
  const viewsDist = viewsBucketOrder.map((label, i) => {
    const row = viewsRes.rows.find(r => r.bucket === label);
    return { label, count: parseInt(row?.count || '0'), color: viewsColors[i] };
  });

  // Process scatter — minimal payload per dot
  const scatter = scatterRes.rows.map(r => {
    const createdAt = r.channel_created_at ? new Date(r.channel_created_at) : null;
    const ageDays = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86400000) : null;
    return {
      id: r.id,
      ch: r.ch || '',                 // channel name (for per-channel filter)
      s: parseInt(r.subs) || 0,      // subs
      v: parseInt(r.views) || 0,      // views
      sc: parseInt(r.score) || 0,     // score
      a: ageDays,                     // ageDays (null if unknown)
      e: r.has_embedding || false,    // has embedding
    };
  });

  return NextResponse.json(
    { subsDist, viewsDist, scatter },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } }
  );
}
