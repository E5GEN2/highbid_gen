import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/distribution?keyword=X&minScore=80[&clusterId=Y]
 * Returns subscriber + views distribution buckets + lightweight scatter data.
 * All 3 queries run in parallel.
 *
 * If clusterId is provided, all three queries are scoped to videos assigned to
 * that cluster (via niche_cluster_assignments) — the keyword filter is skipped
 * because cluster membership already implies keyword.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const keyword = req.nextUrl.searchParams.get('keyword') || '';
  const minScore = parseInt(req.nextUrl.searchParams.get('minScore') || '80');
  const clusterIdRaw = req.nextUrl.searchParams.get('clusterId');
  const clusterId = clusterIdRaw ? parseInt(clusterIdRaw) : null;

  // When scoped to a cluster, join through the assignment table and filter by
  // cluster_id. Otherwise, filter by keyword as before.
  const scopeJoin = clusterId !== null
    ? 'FROM niche_cluster_assignments a JOIN niche_spy_videos ON niche_spy_videos.id = a.video_id'
    : 'FROM niche_spy_videos';
  const scopeWhere = clusterId !== null
    ? 'a.cluster_id = $1 AND score >= $2'
    : 'keyword = $1 AND score >= $2';
  const scopeParams: (string | number)[] = clusterId !== null ? [clusterId, minScore] : [keyword, minScore];

  const [subsRes, viewsRes, scatterRes] = await Promise.all([
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
      ${scopeJoin}
      WHERE ${scopeWhere} AND channel_name IS NOT NULL
      GROUP BY bucket
    `, scopeParams),

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
      ${scopeJoin}
      WHERE ${scopeWhere}
      GROUP BY bucket
    `, scopeParams),

    pool.query(`
      SELECT niche_spy_videos.id, channel_name as ch, subscriber_count as subs, view_count as views, score,
             channel_created_at, posted_at, embedded_at IS NOT NULL as has_embedding,
             c.first_upload_at, c.dormancy_days
      ${scopeJoin}
      LEFT JOIN niche_spy_channels c ON c.channel_id = niche_spy_videos.channel_id
      WHERE ${scopeWhere}
        AND subscriber_count > 0 AND view_count > 0
      ORDER BY view_count DESC NULLS LAST
    `, scopeParams),
  ]);

  const subsBucketOrder = ['0', '1-1K', '1K-10K', '10K-100K', '100K-1M', '1M+'];
  const subsColors = ['#555', '#888', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444'];
  const subsDist = subsBucketOrder.map((label, i) => {
    const row = subsRes.rows.find(r => r.bucket === label);
    return { label, count: parseInt(row?.count || '0'), color: subsColors[i] };
  });

  const viewsBucketOrder = ['0-100', '100-1K', '1K-10K', '10K-100K', '100K-1M', '1M-10M', '10M+'];
  const viewsColors = ['#555', '#888', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#ec4899'];
  const viewsDist = viewsBucketOrder.map((label, i) => {
    const row = viewsRes.rows.find(r => r.bucket === label);
    return { label, count: parseInt(row?.count || '0'), color: viewsColors[i] };
  });

  const scatter = scatterRes.rows.map(r => {
    const createdAt = r.channel_created_at ? new Date(r.channel_created_at) : null;
    const creationAgeDays = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86400000) : null;
    const firstUpload = r.first_upload_at ? new Date(r.first_upload_at) : null;
    const activeAgeDays = firstUpload ? Math.floor((Date.now() - firstUpload.getTime()) / 86400000) : null;
    // Prefer active age (first upload) for downstream opportunity/newcomer math.
    // Fall back to creation age when we haven't yet detected first_upload_at.
    const ageDays = activeAgeDays ?? creationAgeDays;
    const postedAt = r.posted_at ? new Date(r.posted_at) : null;
    const videoAgeDays = postedAt ? Math.floor((Date.now() - postedAt.getTime()) / 86400000) : null;
    return {
      id: r.id,
      ch: r.ch || '',
      s: parseInt(r.subs) || 0,
      v: parseInt(r.views) || 0,
      sc: parseInt(r.score) || 0,
      a: ageDays,                                   // active age (first upload) preferred
      ca: creationAgeDays,                          // creation age (raw channel_created_at)
      dm: r.dormancy_days !== null ? parseInt(r.dormancy_days) : null,   // days channel was dormant
      va: videoAgeDays,
      e: r.has_embedding || false,
    };
  });

  return NextResponse.json(
    { subsDist, viewsDist, scatter, clusterId },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } }
  );
}
