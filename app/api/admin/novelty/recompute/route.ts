import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { recomputeAllNovelty } from '@/lib/vector-db';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/admin/novelty/recompute
 *
 * Recomputes novelty_score for every video with any v2 embedding. Writes
 * the result to niche_spy_videos.novelty_score. See lib/vector-db.ts
 * computeCombinedNovelty for the scoring math (short version: mean cosine
 * distance to K=10 nearest neighbors, averaged across title_v2 +
 * thumbnail_v2 spaces).
 *
 * Returns a distribution summary so the admin UI can see whether the
 * scores are well-spread (good) or bunched near the mean (bad).
 *
 * Body (optional): { k?: number, limit?: number }
 *   k     — KNN neighbors per video (default 10, clamped 1..50)
 *   limit — max videos to score this run (default 50000)
 */
export async function POST(req: NextRequest) {
  const started = Date.now();
  const body = await req.json().catch(() => ({})) as { k?: number; limit?: number };

  try {
    const r = await recomputeAllNovelty({
      k: body.k,
      limit: body.limit,
    });

    // Quick distribution summary — p50/p90/p99 on the freshly-written
    // novelty scores so the caller can eyeball whether the metric has
    // meaningful spread before trusting the ranking.
    const pool = await getPool();
    const distRes = await pool.query<{
      p50: number | null; p90: number | null; p99: number | null;
      min_score: number | null; max_score: number | null; total: string;
    }>(`
      SELECT
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY novelty_score) AS p50,
        PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY novelty_score) AS p90,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY novelty_score) AS p99,
        MIN(novelty_score) AS min_score,
        MAX(novelty_score) AS max_score,
        COUNT(*) AS total
      FROM niche_spy_videos
      WHERE novelty_score IS NOT NULL
    `);
    const d = distRes.rows[0];

    return NextResponse.json({
      ok: true,
      scored: r.scored,
      titleCovered: r.titleCovered,
      thumbCovered: r.thumbCovered,
      durationMs: Date.now() - started,
      distribution: {
        p50: d.p50 ?? null,
        p90: d.p90 ?? null,
        p99: d.p99 ?? null,
        min: d.min_score ?? null,
        max: d.max_score ?? null,
        total: parseInt(d.total || '0'),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    );
  }
}

// GET returns just the distribution summary without recomputing. Handy for
// the tab to show current stats on open.
export async function GET() {
  const pool = await getPool();
  const distRes = await pool.query<{
    p50: number | null; p90: number | null; p99: number | null;
    min_score: number | null; max_score: number | null;
    total: string; last_updated: string | null;
  }>(`
    SELECT
      PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY novelty_score) AS p50,
      PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY novelty_score) AS p90,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY novelty_score) AS p99,
      MIN(novelty_score) AS min_score,
      MAX(novelty_score) AS max_score,
      COUNT(*) AS total,
      MAX(novelty_updated_at)::text AS last_updated
    FROM niche_spy_videos
    WHERE novelty_score IS NOT NULL
  `);
  const d = distRes.rows[0];
  return NextResponse.json({
    distribution: {
      p50: d.p50 ?? null,
      p90: d.p90 ?? null,
      p99: d.p99 ?? null,
      min: d.min_score ?? null,
      max: d.max_score ?? null,
      total: parseInt(d.total || '0'),
      lastUpdated: d.last_updated,
    },
  });
}
