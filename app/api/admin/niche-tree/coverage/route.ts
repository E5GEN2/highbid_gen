import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/niche-tree/coverage
 *
 * Answers "how much of our embedded video corpus is reflected in the
 * latest clustering run?" — i.e. how stale is the niche tree?
 *
 * Returns:
 *   embedded             — videos with combined_v2 embedding (eligible
 *                          to cluster)
 *   latestRun            — { id, source, status, startedAt, completedAt }
 *                          for the most recent global L1 run (any status)
 *   inLatestRun          — videos referenced by niche_tree_assignments
 *                          for that run
 *      .assigned         — got a cluster id
 *      .noise            — ran but didn't form a cluster
 *   newSinceLatestRun    — embedded videos NOT in that run's assignments
 *                          (i.e. embedded after the run started, or
 *                          missed by the snapshot for some other reason)
 *   coveragePct          — 100 × inLatestRun / embedded, two decimals
 *
 * Cheap: one count per metric, all indexed. Safe to poll from the
 * Cluster Lifecycle tab as a freshness indicator.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();

  // Embedded total — single source of truth for "could in principle
  // be clustered right now".
  const embRes = await pool.query<{ embedded: string }>(
    `SELECT COUNT(*)::text AS embedded
       FROM niche_spy_videos
      WHERE combined_embedded_v2_at IS NOT NULL`,
  );
  const embedded = parseInt(embRes.rows[0]?.embedded ?? '0', 10) || 0;

  // Latest L1 run regardless of status — operators want to see "still
  // running" runs surfaced here too. The done check happens in the UI
  // ("Latest done" vs "Latest").
  const runRes = await pool.query<{
    id: number; source: string; status: string;
    started_at: Date; completed_at: Date | null;
  }>(
    `SELECT id, source, status, started_at, completed_at
       FROM niche_tree_runs
      WHERE kind = 'global'
      ORDER BY started_at DESC
      LIMIT 1`,
  );

  if (runRes.rows.length === 0) {
    return NextResponse.json({
      embedded,
      latestRun: null,
      inLatestRun: { total: 0, assigned: 0, noise: 0 },
      newSinceLatestRun: embedded,
      coveragePct: 0,
    });
  }

  const r = runRes.rows[0];

  // Per-cluster-id breakdown for the run — same query the niche-tree
  // GET endpoint runs for its run header, kept here so the coverage
  // endpoint can stand alone.
  const stats = await pool.query<{ assigned: string; noise: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE cluster_id IS NOT NULL)::text AS assigned,
       COUNT(*) FILTER (WHERE cluster_id IS NULL)::text     AS noise
       FROM niche_tree_assignments
      WHERE run_id = $1`,
    [r.id],
  );
  const assigned = parseInt(stats.rows[0]?.assigned ?? '0', 10) || 0;
  const noise    = parseInt(stats.rows[0]?.noise    ?? '0', 10) || 0;
  const inLatest = assigned + noise;
  const newSince = Math.max(0, embedded - inLatest);
  const pct = embedded > 0 ? Math.round((inLatest / embedded) * 10000) / 100 : 0;

  return NextResponse.json({
    embedded,
    latestRun: {
      id: r.id,
      source: r.source,
      status: r.status,
      startedAt: r.started_at?.toISOString?.() ?? null,
      completedAt: r.completed_at?.toISOString?.() ?? null,
    },
    inLatestRun: { total: inLatest, assigned, noise },
    newSinceLatestRun: newSince,
    coveragePct: pct,
  });
}
