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
  const maxTicks = Math.min(Math.max(parseInt(body.ticks) || 200, 1), 2000);
  const mult = Math.min(Math.max(parseInt(body.mult) || 2, 1), 4);
  const delayMs = Math.min(Math.max(parseInt(body.delayMs) ?? 400, 0), 5000);

  // FIRE-AND-FORGET: a synchronous backfill loop hits Railway's request timeout
  // (502) on a 240K-channel table. Run detached and return immediately; poll GET
  // for progress. The advisory lock inside runCgSweepTick keeps this from
  // colliding with the 60s auto-sweep. A lock-skip (skipped=true) is NOT "done".
  void (async () => {
    let ran = 0;
    for (let i = 0; i < maxTicks; i++) {
      const r = await runCgSweepTick(mult).catch(() => null);
      if (!r) { await new Promise(res => setTimeout(res, 2000)); continue; }
      if (!r.enabled) break;                                   // sweep disabled
      if (!r.skipped) {
        ran++;
        if (r.discovered === 0 && r.evaluated === 0 && r.reevaluated === 0) break;  // genuinely done
      }
      await new Promise(res => setTimeout(res, delayMs));
    }
    console.log(`[cg-backfill] finished after ${ran} working ticks`);
  })();

  return NextResponse.json({ ok: true, started: true, maxTicks, mult, note: 'running in background — poll GET for progress' });
}
