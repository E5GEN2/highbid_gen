import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { resumeL2Baking } from '@/lib/niche-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * POST /api/admin/niche-tree/resume-l2
 *
 * Resumes the L2 baking phase for the most recent global L1 run.
 * Iterates L1 clusters that have no children + ≥50 videos, runs
 * subdivides sequentially. Used to recover from cancelled or
 * interrupted bakes without rebuilding L1 from scratch.
 *
 * Body (optional): { runId?: number } — explicit L1 run to resume.
 * Defaults to the latest 'global' run regardless of status.
 *
 * Concurrency: rejects with 409 if anything is currently running.
 */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  let body: { runId?: number } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const pool = await getPool();

  // Single-job-at-a-time guard, same as global + subdivide endpoints.
  const inflight = await pool.query<{ id: number; kind: string }>(
    `SELECT id, kind FROM niche_tree_runs WHERE status = 'running' LIMIT 1`,
  );
  if (inflight.rows.length > 0) {
    return NextResponse.json(
      {
        error: `A ${inflight.rows[0].kind} clustering run is already in progress. Cancel it first or wait for it to finish.`,
        runningRunId: inflight.rows[0].id,
      },
      { status: 409 },
    );
  }

  // Find the L1 run to resume — explicit override or the most recent.
  let l1RunId = body.runId;
  if (!l1RunId) {
    const r = await pool.query<{ id: number }>(
      `SELECT id FROM niche_tree_runs WHERE kind = 'global' ORDER BY started_at DESC LIMIT 1`,
    );
    l1RunId = r.rows[0]?.id;
  }
  if (!l1RunId) {
    return NextResponse.json({ error: 'No global clustering run found to resume' }, { status: 404 });
  }

  // Check there's actually something to bake — give a friendly error
  // if everything's already done or every L1 cluster is too small.
  const todoRes = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM niche_tree_clusters c
       WHERE c.run_id = $1
         AND c.parent_cluster_id IS NULL
         AND c.video_count >= 50
         AND NOT EXISTS (SELECT 1 FROM niche_tree_clusters child WHERE child.parent_cluster_id = c.id)`,
    [l1RunId],
  );
  const todo = parseInt(todoRes.rows[0]?.cnt ?? '0') || 0;
  if (todo === 0) {
    return NextResponse.json({ error: 'No L2 baking work needed — every eligible cluster already has children.' }, { status: 400 });
  }

  // Fire and forget — the helper updates the L1 row's status + progress
  // as it walks the eligible clusters.
  resumeL2Baking(l1RunId).catch(err => console.error('[niche-tree] resume L2 failed:', err));

  return NextResponse.json({ ok: true, l1RunId, eligibleClusters: todo });
}
