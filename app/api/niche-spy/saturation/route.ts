import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/saturation
 * Returns saturation data for all keywords or a specific one.
 * Params: keyword? (optional), limit? (default 10 runs per keyword)
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const keyword = req.nextUrl.searchParams.get('keyword');
  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '10');

  if (keyword && keyword !== 'all') {
    // Single keyword — return run history (sparkline data)
    const runs = await pool.query(
      `SELECT run_at, known_before, run_total, new_count, overlap_count, missed_count,
              run_saturation_pct, global_saturation_pct, niche_universe_size
       FROM niche_saturation_runs
       WHERE keyword = $1
       ORDER BY run_at DESC
       LIMIT $2`,
      [keyword, limit]
    );

    const latest = runs.rows[0];

    return NextResponse.json({
      keyword,
      runs: runs.rows.reverse(), // chronological order for sparkline
      latest: latest ? {
        runSaturation: parseFloat(latest.run_saturation_pct),
        globalSaturation: parseFloat(latest.global_saturation_pct),
        universeSize: latest.niche_universe_size,
        knownBefore: latest.known_before,
        lastNew: latest.new_count,
        lastOverlap: latest.overlap_count,
      } : null,
    });
  }

  // All keywords — summary table with latest saturation per keyword
  const summary = await pool.query(`
    SELECT DISTINCT ON (keyword)
      keyword,
      run_at,
      known_before,
      new_count,
      overlap_count,
      run_saturation_pct,
      global_saturation_pct,
      niche_universe_size,
      (SELECT COUNT(*) FROM niche_saturation_runs r2 WHERE r2.keyword = niche_saturation_runs.keyword) as run_count
    FROM niche_saturation_runs
    ORDER BY keyword, run_at DESC
  `);

  // Also get video counts per keyword from niche_spy_videos
  const videoCounts = await pool.query(`
    SELECT keyword, COUNT(*) as video_count, ROUND(AVG(score)) as avg_score
    FROM niche_spy_videos
    WHERE keyword IS NOT NULL
    GROUP BY keyword
  `);
  const countMap = new Map(videoCounts.rows.map(r => [r.keyword, { videoCount: parseInt(r.video_count), avgScore: parseInt(r.avg_score) || 0 }]));

  const keywords = summary.rows.map(r => ({
    keyword: r.keyword,
    videoCount: countMap.get(r.keyword)?.videoCount || 0,
    avgScore: countMap.get(r.keyword)?.avgScore || 0,
    runSaturation: parseFloat(r.run_saturation_pct),
    globalSaturation: parseFloat(r.global_saturation_pct),
    universeSize: r.niche_universe_size,
    lastNew: r.new_count,
    lastOverlap: r.overlap_count,
    runCount: parseInt(r.run_count),
    lastRunAt: r.run_at,
  }));

  return NextResponse.json({ keywords });
}
