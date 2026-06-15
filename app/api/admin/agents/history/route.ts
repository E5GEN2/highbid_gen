import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { fetchTasksByStatus } from '@/lib/xgodo-tasks';
import { snapshotTaskProofs, listTaskHistory, getTaskTrace } from '@/lib/agent-task-proof';

/**
 * Agent task HISTORY — the durable record of past niche-spy tasks and the
 * exact crawl path each one took.
 *
 * GET /api/admin/agents/history
 *   List mode. Snapshots the job_proof of every running + recently-completed
 *   task (so the ephemeral watch-order survives), then returns the last N
 *   tasks from the lifecycle ledger with seed/label + watched/scored counts.
 *   Query: ?limit=60&kind=all|seed|keyword&status=all|running|completed
 *
 * GET /api/admin/agents/history?taskId=<id>
 *   Detail mode. Returns the full ordered crawl trace for one task — the
 *   videos the bot watched (in orderNumber) merged with the candidates it
 *   scored (similarity + thumbnails from niche_seed_expansions).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';

async function getToken(): Promise<string> {
  const pool = await getPool();
  const r = await pool.query('SELECT key, value FROM admin_config WHERE key = ANY($1)', [[
    'xgodo_niche_spy_token', 'xgodo_api_token',
  ]]);
  const cfg: Record<string, string> = {};
  for (const row of r.rows) cfg[row.key] = row.value;
  return cfg.xgodo_niche_spy_token || cfg.xgodo_api_token
    || process.env.XGODO_NICHE_SPY_TOKEN || process.env.XGODO_API_TOKEN || '';
}

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const taskId = searchParams.get('taskId');

  // ── Detail mode ────────────────────────────────────────────────────────
  if (taskId) {
    try {
      const trace = await getTaskTrace(taskId);
      return NextResponse.json({ ok: true, ...trace });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  // ── List mode ──────────────────────────────────────────────────────────
  const limit = parseInt(searchParams.get('limit') || '60') || 60;
  const kind = (searchParams.get('kind') as 'all' | 'seed' | 'keyword') || 'all';
  const status = searchParams.get('status') || 'all';

  // Snapshot live proofs first (best-effort — never block the list on xgodo).
  let snapshot = { tasksWritten: 0, rowsWritten: 0 };
  try {
    const token = await getToken();
    if (token) {
      // 'running' is the only live status — finished niche-spy tasks drop off
      // the applicants list. The watch-path grows on the running task, so this
      // captures it (the thermostat also snapshots every tick continuously).
      const running = await fetchTasksByStatus(token, NICHE_SPY_JOB_ID, 'running', 100).catch(() => []);
      snapshot = await snapshotTaskProofs(running);
    }
  } catch (err) {
    console.error('[agents/history] snapshot skipped:', (err as Error).message);
  }

  try {
    const tasks = await listTaskHistory({ limit, kind, status });
    return NextResponse.json({ ok: true, snapshot, tasks });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
