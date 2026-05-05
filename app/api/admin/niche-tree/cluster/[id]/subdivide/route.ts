import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { runSubdivideClusteringJob, type TreeSource } from '@/lib/niche-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * POST /api/admin/niche-tree/cluster/:id/subdivide
 *
 * Manually re-subdivide a cluster. Used when the operator wants to
 * re-bake an L2/L3 cluster with different params, or when the original
 * L2 baking pass failed. Body (all optional):
 *   { source?, minClusterSize?, minSamples?, umapDims? }
 *
 * Concurrency: rejects with 409 if any niche_tree_runs is currently
 * 'running' (regardless of kind) — only one Python clustering process
 * runs at a time across the system.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const { id } = await ctx.params;
  const parentClusterId = parseInt(id);
  if (Number.isNaN(parentClusterId)) {
    return NextResponse.json({ error: 'invalid cluster id' }, { status: 400 });
  }

  let body: { source?: TreeSource; minClusterSize?: number; minSamples?: number; umapDims?: number } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const pool = await getPool();

  // Single-job-at-a-time guard, same as the global path. Stuck >30min
  // gets force-failed so a dead worker doesn't block the next click.
  const inflight = await pool.query(
    `SELECT id, started_at, kind, parent_cluster_id FROM niche_tree_runs
       WHERE status = 'running' LIMIT 1`,
  );
  if (inflight.rows.length > 0) {
    const ageMin = (Date.now() - new Date(inflight.rows[0].started_at).getTime()) / 60_000;
    if (ageMin < 30) {
      return NextResponse.json(
        { error: `A ${inflight.rows[0].kind} clustering run is already in progress`, runningRunId: inflight.rows[0].id },
        { status: 409 },
      );
    }
    await pool.query(
      `UPDATE niche_tree_runs SET status='error', error_message='Timed out (stuck >30min)', completed_at=NOW() WHERE id=$1`,
      [inflight.rows[0].id],
    );
  }

  // Verify the parent exists and pull its level + source so the new
  // subrun row has the right metadata before we kick off.
  const parentRes = await pool.query<{
    id: number; level: number; video_count: number; run_source: TreeSource;
  }>(
    `SELECT c.id, c.level, c.video_count, r.source AS run_source
       FROM niche_tree_clusters c
       JOIN niche_tree_runs r ON r.id = c.run_id
       WHERE c.id = $1`,
    [parentClusterId],
  );
  if (parentRes.rows.length === 0) {
    return NextResponse.json({ error: 'cluster not found' }, { status: 404 });
  }
  const parent = parentRes.rows[0];
  if (parent.video_count < 50) {
    return NextResponse.json(
      { error: `Cluster has ${parent.video_count} videos — at least 50 needed to subdivide.` },
      { status: 400 },
    );
  }

  // Inherit source from parent's run by default; override only if
  // caller explicitly asked for a different one.
  const source: TreeSource = body.source ?? parent.run_source;
  const params = {
    source,
    minClusterSize: body.minClusterSize,
    minSamples:     body.minSamples,
    umapDims:       body.umapDims,
  };

  const runRes = await pool.query<{ id: number }>(
    `INSERT INTO niche_tree_runs (kind, parent_cluster_id, level, source, params, status)
     VALUES ('subdivide', $1, $2, $3, $4, 'running') RETURNING id`,
    [parentClusterId, parent.level + 1, source, JSON.stringify(params)],
  );
  const runId = runRes.rows[0].id;

  // Fire and forget — the job patches its own status row.
  runSubdivideClusteringJob({ runId, parentClusterId, params }).catch(err => {
    console.error('[niche-tree] manual subdivide failed:', err);
  });

  return NextResponse.json({ ok: true, runId, parentClusterId });
}
