import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/timeline
 * Returns video counts aggregated by time period for timeline chart.
 * Params:
 *   keyword — filter by keyword (optional)
 *   granularity — 'day' | 'week' | 'month' (default: auto based on range)
 *   from — start date ISO string (optional)
 *   to — end date ISO string (optional)
 *   minScore / maxScore — score filter (optional)
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const sp = req.nextUrl.searchParams;

  const keyword = sp.get('keyword');
  const treeClusterIdRaw = sp.get('treeClusterId');
  const treeClusterId = treeClusterIdRaw ? parseInt(treeClusterIdRaw) : null;
  const from = sp.get('from');
  const to = sp.get('to');
  const minScore = parseInt(sp.get('minScore') || '0');
  const maxScore = parseInt(sp.get('maxScore') || '100');
  let granularity = sp.get('granularity') || 'auto';

  // When scoped to a tree cluster, all queries below need to read
  // through niche_tree_assignments. We swap the FROM clause + add a
  // join condition; everything else (date trunc, score filter, etc.)
  // is unchanged.
  const fromTable = treeClusterId !== null
    ? 'FROM niche_tree_assignments a JOIN niche_spy_videos v ON v.id = a.video_id'
    : 'FROM niche_spy_videos';
  const colPrefix = treeClusterId !== null ? 'v.' : '';

  // Build WHERE
  const conditions = [`${colPrefix}posted_at IS NOT NULL`];
  const params: (string | number)[] = [];
  let idx = 1;

  if (treeClusterId !== null) {
    conditions.push(`a.cluster_id = $${idx}`);
    params.push(treeClusterId);
    idx++;
  } else if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $${idx}`);
    params.push(keyword);
    idx++;
  }
  if (from) {
    conditions.push(`${colPrefix}posted_at >= $${idx}`);
    params.push(from);
    idx++;
  }
  if (to) {
    conditions.push(`${colPrefix}posted_at <= $${idx}`);
    params.push(to);
    idx++;
  }
  if (minScore > 0) {
    conditions.push(`${colPrefix}score >= $${idx}`);
    params.push(minScore);
    idx++;
  }
  if (maxScore < 100) {
    conditions.push(`${colPrefix}score <= $${idx}`);
    params.push(maxScore);
    idx++;
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  // Auto granularity based on date range
  if (granularity === 'auto') {
    const rangeRes = await pool.query(
      `SELECT MIN(${colPrefix}posted_at) as earliest, MAX(${colPrefix}posted_at) as latest ${fromTable} ${where}`,
      params
    );
    const earliest = rangeRes.rows[0]?.earliest;
    const latest = rangeRes.rows[0]?.latest;
    if (earliest && latest) {
      const days = (new Date(latest).getTime() - new Date(earliest).getTime()) / (1000 * 60 * 60 * 24);
      if (days <= 90) granularity = 'day';
      else if (days <= 730) granularity = 'week';
      else granularity = 'month';
    } else {
      granularity = 'month';
    }
  }

  // Date truncation
  let trunc: string;
  switch (granularity) {
    case 'day': trunc = `DATE_TRUNC('day', ${colPrefix}posted_at)`; break;
    case 'week': trunc = `DATE_TRUNC('week', ${colPrefix}posted_at)`; break;
    default: trunc = `DATE_TRUNC('month', ${colPrefix}posted_at)`; break;
  }

  // Main timeline query
  const timelineRes = await pool.query(
    `SELECT ${trunc} as period,
            COUNT(*) as count,
            ROUND(AVG(${colPrefix}score)) as avg_score,
            SUM(${colPrefix}view_count) as total_views,
            COUNT(DISTINCT ${colPrefix}keyword) as keywords,
            COUNT(DISTINCT ${colPrefix}channel_name) as channels
     ${fromTable} ${where}
     GROUP BY period
     ORDER BY period`,
    params
  );

  // Overall stats for the filtered range
  const statsRes = await pool.query(
    `SELECT COUNT(*) as total, ROUND(AVG(${colPrefix}score)) as avg_score,
            MIN(${colPrefix}posted_at) as earliest, MAX(${colPrefix}posted_at) as latest,
            COUNT(DISTINCT ${colPrefix}keyword) as keywords,
            COUNT(DISTINCT ${colPrefix}channel_name) as channels
     ${fromTable} ${where}`,
    params
  );

  // Top keywords in range — only meaningful in the keyword-scoped /
  // unfiltered branches. Tree-cluster scope still surfaces which
  // keywords contributed to the cluster, just with the JOIN.
  const topKeywords = await pool.query(
    `SELECT ${colPrefix}keyword AS keyword, COUNT(*) as count, ROUND(AVG(${colPrefix}score)) as avg_score
     ${fromTable} ${where} AND ${colPrefix}keyword IS NOT NULL
     GROUP BY ${colPrefix}keyword ORDER BY count DESC LIMIT 10`,
    params
  );

  return NextResponse.json({
    timeline: timelineRes.rows.map(r => ({
      period: r.period,
      count: parseInt(r.count),
      avgScore: parseInt(r.avg_score) || 0,
      totalViews: parseInt(r.total_views) || 0,
      keywords: parseInt(r.keywords),
      channels: parseInt(r.channels),
    })),
    granularity,
    stats: {
      total: parseInt(statsRes.rows[0].total),
      avgScore: parseInt(statsRes.rows[0].avg_score) || 0,
      earliest: statsRes.rows[0].earliest,
      latest: statsRes.rows[0].latest,
      keywords: parseInt(statsRes.rows[0].keywords),
      channels: parseInt(statsRes.rows[0].channels),
    },
    topKeywords: topKeywords.rows,
  });
}
