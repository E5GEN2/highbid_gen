import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { runCgSweepTick } from '@/lib/content-gen/cg-sweep';
import { CG_EVAL_VERSION } from '@/lib/content-gen/cg-eligibility';

/**
 * CG-eligibility sweep control + status.
 *   GET  → progress snapshot (tracked / evaluated / eligible / backlog).
 *   POST → run N sweep ticks now with a batch multiplier, to accelerate the
 *          one-time backfill instead of waiting for the 60s instrumentation
 *          cadence. Body: { ticks?: number, mult?: number }.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const r = await pool.query<{
    tracked: string; evaluated: string; eligible: string; stale_version: string;
    total_channels: string; enriched_channels: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM channel_cg_status) AS tracked,
       (SELECT COUNT(*) FROM channel_cg_status WHERE cg_evaluated_at IS NOT NULL) AS evaluated,
       (SELECT COUNT(*) FROM channel_cg_status WHERE cg_eligible) AS eligible,
       (SELECT COUNT(*) FROM channel_cg_status WHERE cg_evaluated_at IS NOT NULL AND cg_eval_version IS DISTINCT FROM $1) AS stale_version,
       (SELECT COUNT(*) FROM niche_spy_channels) AS total_channels,
       (SELECT COUNT(*) FROM niche_spy_channels WHERE subscriber_count IS NOT NULL) AS enriched_channels`,
    [CG_EVAL_VERSION],
  );
  const row = r.rows[0];
  return NextResponse.json({
    eval_version: CG_EVAL_VERSION,
    tracked: parseInt(row.tracked),
    evaluated: parseInt(row.evaluated),
    eligible: parseInt(row.eligible),
    stale_version: parseInt(row.stale_version),
    total_channels: parseInt(row.total_channels),
    enriched_channels: parseInt(row.enriched_channels),
    discover_backlog: parseInt(row.total_channels) - parseInt(row.tracked),
    eval_backlog: parseInt(row.enriched_channels) - parseInt(row.evaluated),
  });
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const ticks = Math.min(Math.max(parseInt(body.ticks) || 1, 1), 40);
  const mult = Math.min(Math.max(parseInt(body.mult) || 1, 1), 8);
  const results = [];
  for (let i = 0; i < ticks; i++) {
    const r = await runCgSweepTick(mult);
    results.push(r);
    // Stop early once nothing left to do.
    if (r.enabled && r.discovered === 0 && r.evaluated === 0 && r.reevaluated === 0) break;
  }
  const totals = results.reduce(
    (a, r) => ({ discovered: a.discovered + r.discovered, evaluated: a.evaluated + r.evaluated, reevaluated: a.reevaluated + r.reevaluated }),
    { discovered: 0, evaluated: 0, reevaluated: 0 },
  );
  return NextResponse.json({ ok: true, ranTicks: results.length, mult, totals });
}
