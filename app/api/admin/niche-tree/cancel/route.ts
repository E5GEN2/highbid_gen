import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { cancelGlobalRun } from '@/lib/niche-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/admin/niche-tree/cancel
 *
 * Cancels the currently-running global L1 + L2 baking pipeline.
 * SIGTERMs the active python child process and signals the L2
 * baking loop to break out before its next iteration.
 *
 * Body (optional): { runId?: number } — explicit run to cancel.
 * If omitted, cancels whatever global run currently has status='running'.
 *
 * Returns 404 if no active run was found, 200 with affectedRow=false
 * if the run was already complete by the time we got the click.
 */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  let body: { runId?: number } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const pool = await getPool();
  let runId = body.runId;
  if (!runId) {
    const inflight = await pool.query<{ id: number }>(
      `SELECT id FROM niche_tree_runs
         WHERE kind='global' AND status='running'
         ORDER BY started_at DESC LIMIT 1`,
    );
    runId = inflight.rows[0]?.id;
  }
  if (!runId) {
    return NextResponse.json({ error: 'No global clustering run is currently active' }, { status: 404 });
  }

  const result = await cancelGlobalRun(runId);
  return NextResponse.json({ ...result, runId });
}
