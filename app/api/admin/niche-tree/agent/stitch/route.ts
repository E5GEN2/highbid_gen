import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { stitchL1Run } from '@/lib/cluster-stitch';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * POST /api/admin/niche-tree/agent/stitch
 * Body: { runId?: number, dryRun?: boolean }
 *
 * Manually re-runs the stitcher for an L1 global run. Useful for:
 *   - Sanity tests: "stitch run 53 against itself" should produce all-same.
 *     (Pass {runId: 53, dryRun: true} — though dry-run isn't fully wired
 *     yet; with stable_ids already populated on 53, the stitcher will
 *     mostly no-op anyway.)
 *   - Re-stitching after a failed run, or after a code-side bug fix.
 *   - Backfilling stable_ids onto an existing run that pre-dates the
 *     stitcher.
 *
 * Returns the full StitchResult object (counts of same/grew/.../born/died).
 */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  const body = await req.json().catch(() => ({}));
  let runId: number = body.runId;
  if (!runId) {
    const r = await pool.query<{ id: number }>(
      `SELECT id FROM niche_tree_runs WHERE kind='global' AND level=1 ORDER BY started_at DESC LIMIT 1`,
    );
    if (!r.rows[0]) return NextResponse.json({ error: 'No global L1 run found' }, { status: 404 });
    runId = r.rows[0].id;
  }

  try {
    const result = await stitchL1Run(pool, runId);
    return NextResponse.json({ ok: true, runId, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message?.slice(0, 500) || 'unknown' },
      { status: 500 },
    );
  }
}
