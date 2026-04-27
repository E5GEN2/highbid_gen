import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { fetchPlannedTasks, deletePlannedTasks } from '@/lib/xgodo-tasks';

const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';

/**
 * GET /api/admin/agents/targets — List all thread targets
 * POST /api/admin/agents/targets — Set target for a keyword
 * DELETE /api/admin/agents/targets — Remove target for a keyword
 *   Also drops any unassigned planned tasks for that keyword in xgodo so
 *   we don't leave orphan tasks running once the user has indicated they
 *   no longer want this niche scheduled. Running tasks are NOT cancelled
 *   — they finish on their own (xgodo doesn't expose a cancel-running).
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const res = await pool.query("SELECT * FROM agent_thread_targets ORDER BY keyword");
  return NextResponse.json({ targets: res.rows });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const { keyword, targetThreads, enabled } = await req.json();

  if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 });

  await pool.query(`
    INSERT INTO agent_thread_targets (keyword, target_threads, enabled)
    VALUES ($1, $2, $3)
    ON CONFLICT (keyword) DO UPDATE SET
      target_threads = EXCLUDED.target_threads,
      enabled = EXCLUDED.enabled
  `, [keyword, targetThreads || 0, enabled !== false]);

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const { keyword } = await req.json();
  if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 });

  // Drop the target row first so the thermostat stops iterating it on
  // the next tick — even if the planned-task cleanup below fails, the
  // user's intent ("don't schedule this anymore") takes effect.
  await pool.query("DELETE FROM agent_thread_targets WHERE keyword = $1", [keyword]);

  // Best-effort cleanup of orphan planned tasks. Without this, anything
  // we'd already submitted for this keyword stays in xgodo's queue and
  // gets picked up later — the worker would then run a 2-hour task on
  // a niche the user just said they didn't want.
  let plannedDeleted = 0;
  let cleanupError: string | null = null;
  try {
    const tokenRes = await pool.query<{ value: string }>(
      `SELECT value FROM admin_config
        WHERE key IN ('xgodo_niche_spy_token', 'xgodo_api_token')
        ORDER BY (key = 'xgodo_niche_spy_token') DESC
        LIMIT 1`,
    );
    const token = tokenRes.rows[0]?.value?.trim();
    if (token) {
      const planned = await fetchPlannedTasks(token, NICHE_SPY_JOB_ID);
      const ours = planned
        .filter(p => p.keyword.toLowerCase() === keyword.toLowerCase())
        .map(p => p.plannedTaskId);
      if (ours.length > 0) {
        const r = await deletePlannedTasks(token, ours);
        if (r.ok) {
          plannedDeleted = ours.length;
          // Drop pin records for the deleted planned tasks too — keeps
          // the pin table from accumulating stale rows the next sweep
          // would have to scan.
          await pool.query(
            `DELETE FROM agent_planned_pins WHERE planned_task_id = ANY($1::text[])`,
            [ours],
          ).catch(() => {});
        } else {
          cleanupError = r.error || `xgodo delete ${r.status}`;
        }
      }
    }
  } catch (err) {
    cleanupError = err instanceof Error ? err.message : 'unknown';
  }

  return NextResponse.json({
    ok: true,
    keyword,
    plannedDeleted,
    cleanupError,
  });
}
