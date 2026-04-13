/**
 * Agent Thermostat — self-scheduling interval that maintains thread targets.
 * Runs inside the Next.js server process on Railway (always alive).
 * Directly queries DB + xgodo API — no HTTP roundtrip to self.
 */

import { getPool } from './db';

const XGODO_API = 'https://xgodo.com/api/v2';
const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';
const INTERVAL_MS = 30_000;  // Check every 30s
const COOLDOWN_MS = 60_000;  // 60s after deploy before next check

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
      "SELECT * FROM agent_thread_targets WHERE enabled = true AND target_threads > 0"
    );
    if (targetsRes.rows.length === 0) return;

    // Get xgodo token
    const configRes = await pool.query(
      "SELECT key, value FROM admin_config WHERE key IN ('xgodo_niche_spy_token', 'xgodo_api_token', 'agent_api_key', 'agent_rofe_api_key', 'agent_loop_number', 'agent_max_search_results', 'agent_max_suggested_results')"
    );
    const config: Record<string, string> = {};
    for (const r of configRes.rows) config[r.key] = r.value;
    const token = config.xgodo_niche_spy_token || config.xgodo_api_token;
    if (!token) return;

    // Fetch running tasks from xgodo
    const res = await fetch(`${XGODO_API}/jobs/applicants`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: NICHE_SPY_JOB_ID, status: 'running', limit: 100 }),
    });
    if (!res.ok) return;

    const data = await res.json();
    const tasks = data.job_tasks || [];

    // Count running per keyword + track task durations
    const running: Record<string, number> = {};
    const seenTaskIds = new Set<string>();

    for (const t of tasks) {
      let planned: Record<string, unknown> = {};
      if (typeof t.planned_task === 'string') {
        try { planned = JSON.parse(t.planned_task); } catch { /* ok */ }
      } else if (t.planned_task && typeof t.planned_task === 'object') {
        planned = t.planned_task;
      }
      const taskId = String(t._id || t.job_task_id || '');
      const kw = String(planned.keyword || 'unknown');
      const workerName = String(t.worker_name || '');
      running[kw] = (running[kw] || 0) + 1;

      if (taskId) {
        seenTaskIds.add(taskId);
        // Upsert: first_seen stays, last_seen updates
        await pool.query(`
          INSERT INTO agent_task_log (task_id, keyword, first_seen_at, last_seen_at, status, worker_name)
          VALUES ($1, $2, NOW(), NOW(), 'running', $3)
          ON CONFLICT (task_id) DO UPDATE SET last_seen_at = NOW(), status = 'running', worker_name = $3
        `, [taskId, kw, workerName]).catch(() => {});
      }
    }

    // Mark tasks no longer running as completed
    await pool.query(`
      UPDATE agent_task_log SET status = 'completed'
      WHERE status = 'running' AND last_seen_at < NOW() - INTERVAL '90 seconds'
    `).catch(() => {});

    // Process each target
    for (const target of targetsRes.rows) {
      const kw = target.keyword;
      const active = running[kw] || 0;
      const needed = target.target_threads - active;

      // Update active count
      await pool.query(
        "UPDATE agent_thread_targets SET active_threads = $1, last_checked_at = NOW() WHERE id = $2",
        [active, target.id]
      );

      if (needed <= 0) continue;

      // Check cooldown
      if (target.last_deployed_at) {
        const elapsed = Date.now() - new Date(target.last_deployed_at).getTime();
        if (elapsed < COOLDOWN_MS) continue;
      }

      // Deploy
      const taskInput = JSON.stringify({
        keyword: kw,
        apiKey: config.agent_api_key || '',
        loopNumber: parseInt(config.agent_loop_number) || 30,
        maxSearchResultsBeforeFallback: parseInt(config.agent_max_search_results) || 50,
        maxSuggestedResultsBeforeFallback: parseInt(config.agent_max_suggested_results) || 50,
        rofeAPIKey: config.agent_rofe_api_key || '',
      });

      const submitRes = await fetch(`${XGODO_API}/planned_tasks/submit`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: NICHE_SPY_JOB_ID, inputs: Array.from({ length: needed }, () => taskInput) }),
      });

      if (submitRes.ok) {
        await pool.query("UPDATE agent_thread_targets SET last_deployed_at = NOW() WHERE id = $1", [target.id]);
        console.log(`[thermostat] Deployed ${needed} for "${kw}" (was ${active}/${target.target_threads})`);
      }
    }
  } catch (err) {
    // Silent — don't crash
    console.error('[thermostat] Error:', (err as Error).message);
  }
}
