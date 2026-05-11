import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { recomputeAllNovelty } from '@/lib/vector-db';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Novelty recompute.
 *
 *   GET  → current distribution summary + in-flight state.
 *          Shape: { distribution: { p50, p90, p99, min, max, total,
 *                                   lastUpdated }, running, last }
 *
 *   POST → kick off a fire-and-forget recompute over the combined_v2
 *          embedding space (99% coverage vs the legacy title_v2 +
 *          thumbnail_v2 path that capped at ~11%).
 *          Body: { k?, limit?, mode?: 'missing'|'all', threads? }
 *          - mode='missing' (default): only score nulls
 *          - mode='all': re-score everything
 *          Returns immediately. Poll GET for distribution / running.
 *
 * Why fire-and-forget: scoring 390K videos × 1 KNN per video at 20
 * threads is ~10-15 min. Sync would blow past the route's 30s budget.
 * inFlight is in-memory — Railway container restarts clear it, which is
 * fine because mode='missing' lets a fresh trigger pick up where the
 * killed run left off.
 */

let inFlight = false;
let lastJobKey: string | null = null;
let lastResult: { scored: number; total: number; mode: string; durationMs: number } | null = null;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    k?: number; limit?: number; mode?: 'missing' | 'all'; threads?: number;
  };

  if (inFlight) {
    return NextResponse.json(
      { ok: true, started: false, reason: 'already_running', jobKey: lastJobKey },
      { status: 200 },
    );
  }

  const jobKey = `novelty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  lastJobKey = jobKey;
  inFlight = true;
  lastResult = null;

  // Detached promise. The handler returns immediately; the work
  // continues until done or the container recycles.
  (async () => {
    const startedAt = Date.now();
    console.log(`[novelty] starting jobKey=${jobKey} mode=${body.mode ?? 'missing'} threads=${body.threads ?? 20}`);
    try {
      const r = await recomputeAllNovelty({
        k: body.k,
        limit: body.limit,
        mode: body.mode,
        threads: body.threads,
      });
      lastResult = r;
      console.log(`[novelty] jobKey=${jobKey} done in ${((Date.now() - startedAt) / 1000).toFixed(0)}s — scored=${r.scored}/${r.total} mode=${r.mode}`);
    } catch (err) {
      console.error(`[novelty] jobKey=${jobKey} failed:`, err);
    } finally {
      inFlight = false;
    }
  })();

  return NextResponse.json({
    ok: true,
    started: true,
    jobKey,
    mode: body.mode ?? 'missing',
    threads: body.threads ?? 8,
  });
}

// GET returns distribution + in-flight state.
export async function GET() {
  const pool = await getPool();
  const distRes = await pool.query<{
    p50: number | null; p90: number | null; p99: number | null;
    min_score: number | null; max_score: number | null;
    total: string; last_updated: string | null;
    candidate_total: string;
  }>(`
    SELECT
      PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY novelty_score) FILTER (WHERE novelty_score IS NOT NULL) AS p50,
      PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY novelty_score) FILTER (WHERE novelty_score IS NOT NULL) AS p90,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY novelty_score) FILTER (WHERE novelty_score IS NOT NULL) AS p99,
      MIN(novelty_score) FILTER (WHERE novelty_score IS NOT NULL) AS min_score,
      MAX(novelty_score) FILTER (WHERE novelty_score IS NOT NULL) AS max_score,
      COUNT(*) FILTER (WHERE novelty_score IS NOT NULL) AS total,
      COUNT(*) FILTER (WHERE combined_embedded_v2_at IS NOT NULL) AS candidate_total,
      MAX(novelty_updated_at)::text AS last_updated
    FROM niche_spy_videos
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
      candidateTotal: parseInt(d.candidate_total || '0'),
      lastUpdated: d.last_updated,
    },
    running: inFlight,
    jobKey: lastJobKey,
    lastResult,
  });
}
