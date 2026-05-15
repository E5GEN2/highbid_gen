import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { getLatestGlobalRun, runGlobalClusteringJob, type TreeSource } from '@/lib/niche-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * GET /api/admin/niche-tree
 *   Returns the latest global L1 clustering run + its clusters with
 *   representative video info (title, thumbnail, url) joined.
 *
 * POST /api/admin/niche-tree
 *   Starts a new global L1 clustering job. Body (all optional):
 *     {
 *       source?:          'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined',
 *       minClusterSize?:  number  (default 80 — bigger = fewer, broader niches),
 *       minSamples?:      number  (default 10),
 *       umapDims?:        number  (default 50),
 *       minScore?:        number  (default 0 — L1 spans all niches incl. low-score)
 *     }
 *
 * Both routes are admin-only. Sandboxed in /api/admin/* so the existing
 * user-facing /api/niche-spy/clusters endpoints stay untouched until
 * we're satisfied with the tree.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const result = await getLatestGlobalRun();
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  let body: {
    source?: TreeSource;
    minClusterSize?: number;
    minSamples?: number;
    umapDims?: number;
    nNeighbors?: number;
    outlierIqrMult?: number;
    minParentSize?: number;
    minScore?: number;
    executionMode?: 'cpu' | 'gpu';
  } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  // One job at a time across the whole tree (global L1 OR any subdivide).
  // The chained L1+L2 baking pipeline is stateful — letting a manual
  // subdivide start mid-bake would race on parent_cluster_id rows.
  // Stuck >2h means a worker died; force-fail so the next click works.
  const inflight = await pool.query(
    `SELECT id, started_at, kind FROM niche_tree_runs
       WHERE status = 'running' LIMIT 1`,
  );
  if (inflight.rows.length > 0) {
    const ageMin = (Date.now() - new Date(inflight.rows[0].started_at).getTime()) / 60_000;
    if (ageMin < 120) {
      return NextResponse.json(
        { error: `A ${inflight.rows[0].kind} clustering run is already in progress`, runningRunId: inflight.rows[0].id },
        { status: 409 },
      );
    }
    await pool.query(
      `UPDATE niche_tree_runs
         SET status='error', error_message='Timed out (stuck >2h)', completed_at=NOW()
         WHERE id=$1`,
      [inflight.rows[0].id],
    );
  }

  const params = {
    source:         body.source         ?? 'thumbnail_v2',
    minClusterSize: body.minClusterSize ?? 40,    // lowered from 80 — more clusters survive
    minSamples:     body.minSamples     ?? 5,     // lowered from 10 — more permissive density floor
    umapDims:       body.umapDims       ?? 50,
    nNeighbors:     body.nNeighbors     ?? 15,    // bumped from 5 — biggest noise-reduction lever
    outlierIqrMult: body.outlierIqrMult ?? 3.0,   // Tukey fence for HDBSCAN outlier cleanup
    minParentSize:  body.minParentSize  ?? 200,   // L2 baking floor — skip subdivides on tiny parents
    minScore:       body.minScore       ?? 0,
    // Persisted into niche_tree_runs.params so resumeL2Baking can
    // inherit it later without the caller having to remember.
    executionMode:  body.executionMode === 'gpu' ? 'gpu' as const : undefined,
  };

  const runRes = await pool.query<{ id: number }>(
    `INSERT INTO niche_tree_runs (kind, parent_cluster_id, level, source, params, status)
     VALUES ('global', NULL, 1, $1, $2, 'running')
     RETURNING id`,
    [params.source, JSON.stringify(params)],
  );
  const runId = runRes.rows[0].id;

  // Fire and forget — the job patches its own status row.
  runGlobalClusteringJob(runId, params).catch(err => {
    console.error('[niche-tree] global run failed:', err);
  });

  return NextResponse.json({ ok: true, runId, params, status: 'started' });
}
