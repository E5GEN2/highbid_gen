import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { stitchL1Run } from '@/lib/cluster-stitch';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * POST /api/admin/niche-tree/agent/stitch
 * Body: { runId?: number, force?: boolean }
 *
 * Manually re-runs the stitcher for an L1 global run. Useful for:
 *   - Re-stitching after the matching algorithm has been improved
 *     (pass force=true to clear existing events + stable_ids on the run
 *     first, otherwise duplicate events accumulate).
 *   - Re-stitching after a failed run, or after a code-side bug fix.
 *   - Backfilling stable_ids onto an existing run that pre-dates the
 *     stitcher.
 *
 * force=true performs:
 *   1. DELETE FROM niche_cluster_events WHERE run_id = $1 AND level = 1
 *   2. UPDATE niche_tree_clusters SET stable_id=NULL, parent_stable_id=NULL
 *      WHERE run_id = $1 AND level = 1
 *   3. stitchL1Run(pool, runId)
 *
 * Returns the full StitchResult object (counts of same/grew/.../born/died).
 */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  const body = await req.json().catch(() => ({}));
  let runId: number = body.runId;
  const force: boolean = !!body.force;
  if (!runId) {
    const r = await pool.query<{ id: number }>(
      `SELECT id FROM niche_tree_runs WHERE kind='global' AND level=1 ORDER BY started_at DESC LIMIT 1`,
    );
    if (!r.rows[0]) return NextResponse.json({ error: 'No global L1 run found' }, { status: 404 });
    runId = r.rows[0].id;
  }

  try {
    let cleared: { events: number; clusters: number } | null = null;
    if (force) {
      const evDel = await pool.query(
        `DELETE FROM niche_cluster_events WHERE run_id = $1 AND level = 1`,
        [runId],
      );
      const clrUpd = await pool.query(
        `UPDATE niche_tree_clusters SET stable_id = NULL, parent_stable_id = NULL
          WHERE run_id = $1 AND level = 1`,
        [runId],
      );
      cleared = { events: evDel.rowCount || 0, clusters: clrUpd.rowCount || 0 };
    }
    const result = await stitchL1Run(pool, runId);
    return NextResponse.json({ ok: true, runId, force, cleared, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message?.slice(0, 500) || 'unknown' },
      { status: 500 },
    );
  }
}
