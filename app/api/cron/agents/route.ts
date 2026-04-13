import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

const XGODO_API = 'https://xgodo.com/api/v2';
const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';
const COOLDOWN_MS = 60_000; // 60s cooldown after deploying before checking again

/**
 * GET /api/cron/agents
 * Thermostat: maintains target thread count per keyword.
 * Called every 30-60s by external cron or Railway cron.
 * For each keyword with a target:
 *   - Check running tasks on xgodo
 *   - If active < target AND cooldown elapsed → deploy more
 */
export async function GET(req: NextRequest) {
  // Auth: cron secret or admin token
  const authHeader = req.headers.get('authorization');
  const pool = await getPool();

  // Check cron secret
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // Also allow admin tokens
    const tokenRes = await pool.query(
      "SELECT id FROM api_tokens WHERE token = $1 AND scopes = 'admin'",
      [authHeader?.replace('Bearer ', '') || '']
    );
    if (tokenRes.rows.length === 0) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Get xgodo token
  const configRes = await pool.query("SELECT key, value FROM admin_config WHERE key IN ('xgodo_niche_spy_token', 'xgodo_api_token', 'agent_api_key', 'agent_rofe_api_key', 'agent_loop_number', 'agent_max_search_results', 'agent_max_suggested_results')");
  const config: Record<string, string> = {};
  for (const r of configRes.rows) config[r.key] = r.value;
  const xgodoToken = config.xgodo_niche_spy_token || config.xgodo_api_token || process.env.XGODO_API_TOKEN || '';

  if (!xgodoToken) return NextResponse.json({ error: 'No xgodo token' }, { status: 500 });

  // Get all enabled targets
  const targetsRes = await pool.query(
    "SELECT * FROM agent_thread_targets WHERE enabled = true AND target_threads > 0"
  );
  const targets = targetsRes.rows;

  if (targets.length === 0) return NextResponse.json({ message: 'No active targets', actions: [] });

  // Fetch ALL running tasks from xgodo
  let runningTasks: Array<{ keyword: string }> = [];
  try {
    const res = await fetch(`${XGODO_API}/jobs/applicants`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${xgodoToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: NICHE_SPY_JOB_ID, status: 'running', limit: 100 }),
    });
    if (res.ok) {
      const data = await res.json();
      runningTasks = (data.job_tasks || []).map((t: Record<string, unknown>) => {
        let planned: Record<string, unknown> = {};
        if (typeof t.planned_task === 'string') {
          try { planned = JSON.parse(t.planned_task); } catch { /* ok */ }
        } else if (t.planned_task && typeof t.planned_task === 'object') {
          planned = t.planned_task as Record<string, unknown>;
        }
        let proof: Record<string, unknown> = {};
        if (typeof t.job_proof === 'string') {
          try { proof = JSON.parse(t.job_proof); } catch { /* ok */ }
        } else if (t.job_proof && typeof t.job_proof === 'object') {
          proof = t.job_proof as Record<string, unknown>;
        }
        return {
          keyword: String(planned.keyword || planned.search_query || proof.keyword || proof.searchQuery || 'unknown'),
        };
      });
    }
  } catch (err) {
    console.error('[cron/agents] Failed to fetch running tasks:', err);
    return NextResponse.json({ error: 'Failed to fetch xgodo tasks' }, { status: 502 });
  }

  // Count running per keyword
  const runningByKeyword: Record<string, number> = {};
  for (const t of runningTasks) {
    runningByKeyword[t.keyword] = (runningByKeyword[t.keyword] || 0) + 1;
  }

  const actions: Array<{ keyword: string; target: number; active: number; deployed: number; reason: string }> = [];

  for (const target of targets) {
    const keyword = target.keyword;
    const active = runningByKeyword[keyword] || 0;
    const needed = target.target_threads - active;

    // Update active count in DB
    await pool.query(
      "UPDATE agent_thread_targets SET active_threads = $1, last_checked_at = NOW() WHERE id = $2",
      [active, target.id]
    );

    if (needed <= 0) {
      actions.push({ keyword, target: target.target_threads, active, deployed: 0, reason: 'at target' });
      continue;
    }

    // Check cooldown — don't deploy if we deployed less than 60s ago
    if (target.last_deployed_at) {
      const elapsed = Date.now() - new Date(target.last_deployed_at).getTime();
      if (elapsed < COOLDOWN_MS) {
        actions.push({ keyword, target: target.target_threads, active, deployed: 0, reason: `cooldown (${Math.round((COOLDOWN_MS - elapsed) / 1000)}s remaining)` });
        continue;
      }
    }

    // Deploy the needed tasks
    try {
      const taskInput = {
        keyword,
        apiKey: config.agent_api_key || '',
        loopNumber: parseInt(config.agent_loop_number) || 30,
        maxSearchResultsBeforeFallback: parseInt(config.agent_max_search_results) || 50,
        maxSuggestedResultsBeforeFallback: parseInt(config.agent_max_suggested_results) || 50,
        rofeAPIKey: config.agent_rofe_api_key || '',
      };
      const inputStr = JSON.stringify(taskInput);
      const inputs = Array.from({ length: needed }, () => inputStr);

      const res = await fetch(`${XGODO_API}/planned_tasks/submit`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${xgodoToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: NICHE_SPY_JOB_ID, inputs }),
      });

      if (res.ok) {
        await pool.query(
          "UPDATE agent_thread_targets SET last_deployed_at = NOW() WHERE id = $1",
          [target.id]
        );
        actions.push({ keyword, target: target.target_threads, active, deployed: needed, reason: 'deployed' });
        console.log(`[cron/agents] Deployed ${needed} tasks for "${keyword}" (was ${active}/${target.target_threads})`);
      } else {
        const text = await res.text();
        actions.push({ keyword, target: target.target_threads, active, deployed: 0, reason: `xgodo error: ${res.status}` });
        console.error(`[cron/agents] Deploy failed for "${keyword}": ${res.status} ${text}`);
      }
    } catch (err) {
      actions.push({ keyword, target: target.target_threads, active, deployed: 0, reason: `error: ${(err as Error).message}` });
    }
  }

  return NextResponse.json({
    totalRunning: runningTasks.length,
    targets: targets.length,
    actions,
  });
}
