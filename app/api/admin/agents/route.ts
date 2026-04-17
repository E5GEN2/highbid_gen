import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { fetchRunningTasks, fetchPlannedTasks, countInFlight } from '@/lib/xgodo-tasks';

const XGODO_API = 'https://xgodo.com/api/v2';
const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';

async function getConfig(): Promise<Record<string, string>> {
  const pool = await getPool();
  const result = await pool.query('SELECT key, value FROM admin_config');
  const config: Record<string, string> = {};
  for (const row of result.rows) config[row.key] = row.value;
  return config;
}

function getToken(config: Record<string, string>): string {
  return config.xgodo_niche_spy_token || config.xgodo_api_token || process.env.XGODO_NICHE_SPY_TOKEN || process.env.XGODO_API_TOKEN || '';
}

/**
 * GET /api/admin/agents
 * Fetch active (running) xgodo tasks, grouped by keyword.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const pool = await getPool();
    const config = await getConfig();
    const token = getToken(config);
    if (!token) return NextResponse.json({ error: 'xgodo token not configured' }, { status: 500 });

    // Fetch running + planned in parallel so the UI sees the same in-flight
    // numbers the thermostat uses to make decisions.
    const [running, planned] = await Promise.all([
      fetchRunningTasks(token, NICHE_SPY_JOB_ID),
      fetchPlannedTasks(token, NICHE_SPY_JOB_ID),
    ]);

    const inflight = countInFlight(running, planned);

    // Build grouped view — running + planned per keyword, sorted by in-flight
    const byKeyword = Object.entries(inflight)
      .map(([keyword, rec]) => ({
        keyword,
        active: rec.running,    // kept for backward compat with the UI
        running: rec.running,
        planned: rec.planned,
        inFlight: rec.inFlight,
        taskIds: running.filter(r => r.keyword === keyword).map(r => r.taskId),
      }))
      .sort((a, b) => b.inFlight - a.inFlight);

    // Fetch duration data for running tasks from task log
    const taskIds = running.map(r => r.taskId).filter(Boolean);
    const durationMap: Record<string, { firstSeen: string; duration: number }> = {};
    if (taskIds.length > 0) {
      const logRes = await pool.query(
        "SELECT task_id, first_seen_at, EXTRACT(EPOCH FROM (NOW() - first_seen_at))::integer as duration_sec FROM agent_task_log WHERE task_id = ANY($1)",
        [taskIds]
      );
      for (const r of logRes.rows) {
        durationMap[r.task_id] = { firstSeen: r.first_seen_at, duration: r.duration_sec };
      }
    }

    // Also fetch recently completed tasks (last 1 hour)
    const recentRes = await pool.query(
      "SELECT task_id, keyword, first_seen_at, last_seen_at, status, worker_name, EXTRACT(EPOCH FROM (last_seen_at - first_seen_at))::integer as duration_sec FROM agent_task_log WHERE status = 'completed' AND last_seen_at > NOW() - INTERVAL '1 hour' ORDER BY last_seen_at DESC LIMIT 50"
    );

    return NextResponse.json({
      totalActive: running.length,         // backward compat
      totalRunning: running.length,
      totalPlanned: planned.length,
      totalInFlight: running.length + planned.length,
      byKeyword,
      tasks: running.map(r => ({
        id: r.taskId,
        keyword: r.keyword,
        startedAt: r.startedAt,
        workerName: r.workerName,
        duration: durationMap[r.taskId]?.duration || null,
        firstSeen: durationMap[r.taskId]?.firstSeen || null,
      })),
      plannedTasks: planned.map(p => ({
        id: p.plannedTaskId,
        keyword: p.keyword,
        added: p.added,
      })),
      recentCompleted: recentRes.rows.map(r => ({
        id: r.task_id,
        keyword: r.keyword,
        duration: r.duration_sec,
        completedAt: r.last_seen_at,
        workerName: r.worker_name,
      })),
    });
  } catch (err) {
    console.error('[agents] Monitor error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/admin/agents
 * Deploy new agent threads for a keyword.
 * Body: { keyword, threads, numVideos?, fetchChannelAge?, youtubeApiKey? }
 */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const body = await req.json();
    const { keyword, threads = 1, apiKey, loopNumber = 30,
            maxSearchResultsBeforeFallback = 50, maxSuggestedResultsBeforeFallback = 50,
            rofeAPIKey } = body;

    if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 });
    if (threads < 1 || threads > 20) return NextResponse.json({ error: 'threads must be 1-20' }, { status: 400 });

    const config = await getConfig();
    const token = getToken(config);
    if (!token) return NextResponse.json({ error: 'xgodo token not configured' }, { status: 500 });

    // Build task input matching xgodo planned task format
    const taskInput: Record<string, unknown> = {
      keyword,
      apiKey: apiKey || config.agent_api_key || '',
      loopNumber: loopNumber,
      maxSearchResultsBeforeFallback: maxSearchResultsBeforeFallback,
      maxSuggestedResultsBeforeFallback: maxSuggestedResultsBeforeFallback,
      rofeAPIKey: rofeAPIKey || config.agent_rofe_api_key || '',
    };

    const inputStr = JSON.stringify(taskInput);
    const inputs = Array.from({ length: threads }, () => inputStr);

    const res = await fetch(`${XGODO_API}/planned_tasks/submit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        job_id: NICHE_SPY_JOB_ID,
        inputs,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `xgodo submit failed: ${res.status} ${text}` }, { status: 502 });
    }

    const result = await res.json();

    return NextResponse.json({
      ok: true,
      deployed: threads,
      keyword,
      xgodoResponse: result,
    });
  } catch (err) {
    console.error('[agents] Deploy error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
