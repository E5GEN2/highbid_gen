/**
 * Agent Thermostat — self-scheduling interval that maintains thread targets.
 * Runs inside the Next.js server process on Railway (always alive).
 *
 * Logic:
 *   For each enabled target (keyword, target_threads):
 *     inFlight = running + planned      ← crucial: count planned too, not just running
 *     if inFlight < target: deploy (target - inFlight) planned tasks
 *     if inFlight > target: delete (inFlight - target) oldest UNASSIGNED planned tasks
 *                          (we never cancel running tasks — only unassigned planned)
 *
 * Without the planned-count, the thermostat would over-deploy every tick while
 * devices took their time picking up queued tasks — queue bloat. Cooldown was a
 * band-aid; counting planned makes it unnecessary but we keep a small cooldown
 * for submit→list visibility race on xgodo's side.
 */

import { getPool } from './db';
import {
  fetchRunningTasks,
  fetchPlannedTasks,
  deletePlannedTasks,
  countInFlight,
  type RunningTaskInfo,
} from './xgodo-tasks';

const XGODO_API = 'https://xgodo.com/api/v2';
const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';
const INTERVAL_MS = 30_000;  // Check every 30s
const SHORT_COOLDOWN_MS = 15_000;  // 15s after deploy before next action — covers xgodo's submit→list visibility race

let started = false;

export function ensureThermostatRunning() {
  if (started) return;
  started = true;
  // Delay first run to let server boot
  setTimeout(() => {
    console.log('[thermostat] Started — checking every 30s');
    runCheck();
    setInterval(runCheck, INTERVAL_MS);
  }, 15_000);
}

async function runCheck() {
  try {
    const pool = await getPool();

    // Get enabled targets
    const targetsRes = await pool.query(
      "SELECT * FROM agent_thread_targets WHERE enabled = true"
    );
    if (targetsRes.rows.length === 0) return;

    // Get xgodo token + task input defaults
    const configRes = await pool.query(
      "SELECT key, value FROM admin_config WHERE key IN ('xgodo_niche_spy_token', 'xgodo_api_token', 'agent_api_key', 'agent_rofe_api_key', 'agent_loop_number', 'agent_max_search_results', 'agent_max_suggested_results')"
    );
    const config: Record<string, string> = {};
    for (const r of configRes.rows) config[r.key] = r.value;
    const token = config.xgodo_niche_spy_token || config.xgodo_api_token;
    if (!token) return;

    // Fetch running + planned in parallel — both needed for accurate in-flight count
    let running: RunningTaskInfo[] = [];
    let planned: Awaited<ReturnType<typeof fetchPlannedTasks>> = [];
    try {
      [running, planned] = await Promise.all([
        fetchRunningTasks(token, NICHE_SPY_JOB_ID),
        fetchPlannedTasks(token, NICHE_SPY_JOB_ID),
      ]);
    } catch (err) {
      console.error('[thermostat] xgodo fetch failed:', (err as Error).message);
      return;
    }

    // Task-log bookkeeping: upsert running, mark stale ones completed
    for (const r of running) {
      if (!r.taskId) continue;
      await pool.query(`
        INSERT INTO agent_task_log (task_id, keyword, first_seen_at, last_seen_at, status, worker_name)
        VALUES ($1, $2, NOW(), NOW(), 'running', $3)
        ON CONFLICT (task_id) DO UPDATE SET last_seen_at = NOW(), status = 'running', worker_name = $3
      `, [r.taskId, r.keyword, r.workerName || '']).catch(() => {});
    }
    await pool.query(`
      UPDATE agent_task_log SET status = 'completed'
      WHERE status = 'running' AND last_seen_at < NOW() - INTERVAL '90 seconds'
    `).catch(() => {});

    // Count in-flight per keyword
    const inflight = countInFlight(running, planned);

    // Iterate targets — deploy if short, delete planned if over
    for (const target of targetsRes.rows) {
      const kw: string = target.keyword;
      const rec = inflight[kw] || { running: 0, planned: 0, inFlight: 0, plannedIds: [] };
      const diff = target.target_threads - rec.inFlight;

      // Update observability fields
      await pool.query(
        `UPDATE agent_thread_targets
           SET active_threads = $1, last_checked_at = NOW()
         WHERE id = $2`,
        [rec.running, target.id]
      );

      // ── AT TARGET ────────────────────────────────────────────────
      if (diff === 0) continue;

      // ── UNDER TARGET: deploy more ─────────────────────────────────
      if (diff > 0) {
        if (target.target_threads === 0) continue;  // disabled but not deleted

        // Short cooldown to cover the submit→list visibility race on xgodo's side.
        // If we just deployed and the newly-planned tasks haven't appeared in the
        // listing yet, we'd re-deploy them on next tick. 15s is plenty for xgodo.
        if (target.last_deployed_at) {
          const elapsed = Date.now() - new Date(target.last_deployed_at).getTime();
          if (elapsed < SHORT_COOLDOWN_MS) continue;
        }

        const taskInput = JSON.stringify({
          keyword: kw,
          apiKey: config.agent_api_key || '',
          loopNumber: parseInt(config.agent_loop_number) || 30,
          maxSearchResultsBeforeFallback: parseInt(config.agent_max_search_results) || 50,
          maxSuggestedResultsBeforeFallback: parseInt(config.agent_max_suggested_results) || 50,
          rofeAPIKey: config.agent_rofe_api_key || '',
        });
        try {
          const submitRes = await fetch(`${XGODO_API}/planned_tasks/submit`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: NICHE_SPY_JOB_ID, inputs: Array.from({ length: diff }, () => taskInput) }),
          });
          if (submitRes.ok) {
            await pool.query("UPDATE agent_thread_targets SET last_deployed_at = NOW() WHERE id = $1", [target.id]);
            console.log(`[thermostat] Deployed ${diff} for "${kw}" (running=${rec.running}, planned=${rec.planned}, target=${target.target_threads})`);
          }
        } catch (err) {
          console.error(`[thermostat] Deploy failed for "${kw}":`, (err as Error).message);
        }
        continue;
      }

      // ── OVER TARGET: delete excess planned tasks (never touches running) ─
      // diff < 0 here. excess = -diff. But we can only remove up to rec.planned.
      const excess = -diff;
      const toDelete = rec.plannedIds.slice(0, Math.min(excess, rec.plannedIds.length));
      if (toDelete.length === 0) continue;  // all excess is already running; nothing to do

      const delResult = await deletePlannedTasks(token, toDelete);
      if (delResult.ok) {
        console.log(`[thermostat] Over-provisioned "${kw}" — deleted ${toDelete.length} planned task(s) (running=${rec.running}, planned=${rec.planned}, target=${target.target_threads})`);
      } else {
        console.error(`[thermostat] Delete failed for "${kw}":`, delResult.error);
      }
    }
  } catch (err) {
    console.error('[thermostat] Error:', (err as Error).message);
  }
}
