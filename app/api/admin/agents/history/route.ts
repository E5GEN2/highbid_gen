import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { listTaskHistory, getTaskTrace } from '@/lib/agent-task-proof';

/**
 * Agent task HISTORY — the durable record of past niche-spy tasks and the
 * exact crawl path each one took.
 *
 * Pure reader. The agent_task_proof watch-order is captured continuously by
 * the thermostat (every 30s), so this endpoint never touches xgodo and stays
 * fast.
 *
 * GET /api/admin/agents/history
 *   List mode. Returns the last N tasks from the lifecycle ledger with
 *   seed/label + watched/scored counts.
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

  try {
    const tasks = await listTaskHistory({ limit, kind, status });
    return NextResponse.json({ ok: true, tasks });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
