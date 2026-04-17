import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { fetchRunningTasks, fetchPlannedTasks, deletePlannedTasks, countInFlight } from '@/lib/xgodo-tasks';

const XGODO_API = 'https://xgodo.com/api/v2';
const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';
const SHORT_COOLDOWN_MS = 15_000;

/**
 * GET /api/cron/agents
 * HTTP-accessible version of the thermostat — kept around as a fallback if you
 * want an external cron (Railway cron, etc.) instead of the in-process interval.
 * Mirrors the logic of lib/agent-thermostat.ts: counts running + planned,
 * deploys if under, deletes oldest planned if over.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const pool = await getPool();

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    const tokenRes = await pool.query(
      "SELECT id FROM api_tokens WHERE token = $1 AND scopes = 'admin'",
      [authHeader?.replace('Bearer ', '') || '']
    );
    if (tokenRes.rows.length === 0) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const configRes = await pool.query(
    "SELECT key, value FROM admin_config WHERE key IN ('xgodo_niche_spy_token', 'xgodo_api_token', 'agent_api_key', 'agent_rofe_api_key', 'agent_loop_number', 'agent_max_search_results', 'agent_max_suggested_results')"
  );
  const config: Record<string, string> = {};
  for (const r of configRes.rows) config[r.key] = r.value;
  const xgodoToken = config.xgodo_niche_spy_token || config.xgodo_api_token || process.env.XGODO_API_TOKEN || '';
  if (!xgodoToken) return NextResponse.json({ error: 'No xgodo token' }, { status: 500 });

  const targetsRes = await pool.query(
    "SELECT * FROM agent_thread_targets WHERE enabled = true"
  );
  const targets = targetsRes.rows;
  if (targets.length === 0) return NextResponse.json({ message: 'No active targets', actions: [] });

  let running, planned;
  try {
    [running, planned] = await Promise.all([
      fetchRunningTasks(xgodoToken, NICHE_SPY_JOB_ID),
      fetchPlannedTasks(xgodoToken, NICHE_SPY_JOB_ID),
    ]);
  } catch (err) {
    console.error('[cron/agents] xgodo fetch failed:', err);
    return NextResponse.json({ error: 'Failed to fetch xgodo tasks' }, { status: 502 });
  }

  const inflight = countInFlight(running, planned);

  const actions: Array<{
    keyword: string; target: number; running: number; planned: number;
    deployed: number; deleted: number; reason: string;
  }> = [];

  for (const target of targets) {
    const kw = target.keyword;
    const rec = inflight[kw] || { running: 0, planned: 0, inFlight: 0, plannedIds: [] };
    const diff = target.target_threads - rec.inFlight;

    await pool.query(
      "UPDATE agent_thread_targets SET active_threads = $1, last_checked_at = NOW() WHERE id = $2",
      [rec.running, target.id]
    );

    // At target
    if (diff === 0) {
      actions.push({ keyword: kw, target: target.target_threads, running: rec.running, planned: rec.planned, deployed: 0, deleted: 0, reason: 'at target' });
      continue;
    }

    // Under target — deploy
    if (diff > 0) {
      if (target.target_threads === 0) {
        actions.push({ keyword: kw, target: 0, running: rec.running, planned: rec.planned, deployed: 0, deleted: 0, reason: 'target=0' });
        continue;
      }
      if (target.last_deployed_at) {
        const elapsed = Date.now() - new Date(target.last_deployed_at).getTime();
        if (elapsed < SHORT_COOLDOWN_MS) {
          actions.push({ keyword: kw, target: target.target_threads, running: rec.running, planned: rec.planned, deployed: 0, deleted: 0, reason: `cooldown (${Math.round((SHORT_COOLDOWN_MS - elapsed) / 1000)}s)` });
          continue;
        }
      }
      try {
        const taskInput = JSON.stringify({
          keyword: kw,
          apiKey: config.agent_api_key || '',
          loopNumber: parseInt(config.agent_loop_number) || 30,
          maxSearchResultsBeforeFallback: parseInt(config.agent_max_search_results) || 50,
          maxSuggestedResultsBeforeFallback: parseInt(config.agent_max_suggested_results) || 50,
          rofeAPIKey: config.agent_rofe_api_key || '',
        });
        const res = await fetch(`${XGODO_API}/planned_tasks/submit`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${xgodoToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_id: NICHE_SPY_JOB_ID, inputs: Array.from({ length: diff }, () => taskInput) }),
        });
        if (res.ok) {
          await pool.query("UPDATE agent_thread_targets SET last_deployed_at = NOW() WHERE id = $1", [target.id]);
          actions.push({ keyword: kw, target: target.target_threads, running: rec.running, planned: rec.planned, deployed: diff, deleted: 0, reason: 'deployed' });
        } else {
          const text = await res.text().catch(() => '');
          actions.push({ keyword: kw, target: target.target_threads, running: rec.running, planned: rec.planned, deployed: 0, deleted: 0, reason: `xgodo error: ${res.status} ${text.slice(0, 80)}` });
        }
      } catch (err) {
        actions.push({ keyword: kw, target: target.target_threads, running: rec.running, planned: rec.planned, deployed: 0, deleted: 0, reason: `error: ${(err as Error).message}` });
      }
      continue;
    }

    // Over target — delete excess planned (oldest first). Running tasks are never touched.
    const excess = -diff;
    const toDelete = rec.plannedIds.slice(0, Math.min(excess, rec.plannedIds.length));
    if (toDelete.length === 0) {
      actions.push({ keyword: kw, target: target.target_threads, running: rec.running, planned: rec.planned, deployed: 0, deleted: 0, reason: 'over target but all excess already running' });
      continue;
    }
    const delResult = await deletePlannedTasks(xgodoToken, toDelete);
    if (delResult.ok) {
      actions.push({ keyword: kw, target: target.target_threads, running: rec.running, planned: rec.planned, deployed: 0, deleted: toDelete.length, reason: 'deleted excess planned' });
    } else {
      actions.push({ keyword: kw, target: target.target_threads, running: rec.running, planned: rec.planned, deployed: 0, deleted: 0, reason: `delete failed: ${delResult.error?.slice(0, 80) || delResult.status}` });
    }
  }

  return NextResponse.json({
    totalRunning: running.length,
    totalPlanned: planned.length,
    totalInFlight: running.length + planned.length,
    targets: targets.length,
    actions,
  });
}
