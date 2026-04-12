import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

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
    const config = await getConfig();
    const token = getToken(config);
    if (!token) return NextResponse.json({ error: 'xgodo token not configured' }, { status: 500 });

    // Fetch running tasks from xgodo
    const res = await fetch(`${XGODO_API}/jobs/applicants`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        job_id: NICHE_SPY_JOB_ID,
        status: 'running',
        limit: 100,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `xgodo API error: ${res.status} ${text}` }, { status: 502 });
    }

    const data = await res.json();
    const tasks = data.job_tasks || [];

    // Extract keyword from each task
    interface TaskInfo {
      id: string;
      keyword: string;
      startedAt: string | null;
    }

    const taskList: TaskInfo[] = tasks.map((t: Record<string, unknown>) => {
      const planned = (t.planned_task || {}) as Record<string, unknown>;
      const proof = (t.job_proof || {}) as Record<string, unknown>;
      const keyword = (planned.keyword || proof.keyword || proof.searchQuery || proof.search_query || 'unknown') as string;
      return {
        id: (t._id || t.job_task_id || '') as string,
        keyword,
        startedAt: (t.created_at || t.started_at || null) as string | null,
      };
    });

    // Group by keyword
    const byKeyword: Record<string, { keyword: string; active: number; taskIds: string[] }> = {};
    for (const task of taskList) {
      if (!byKeyword[task.keyword]) {
        byKeyword[task.keyword] = { keyword: task.keyword, active: 0, taskIds: [] };
      }
      byKeyword[task.keyword].active++;
      byKeyword[task.keyword].taskIds.push(task.id);
    }

    const keywordList = Object.values(byKeyword).sort((a, b) => b.active - a.active);

    return NextResponse.json({
      totalActive: taskList.length,
      byKeyword: keywordList,
      tasks: taskList,
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
    const { keyword, threads = 1, numVideos = 20, fetchChannelAge = true, youtubeApiKey } = await req.json();

    if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 });
    if (threads < 1 || threads > 20) return NextResponse.json({ error: 'threads must be 1-20' }, { status: 400 });

    const config = await getConfig();
    const token = getToken(config);
    if (!token) return NextResponse.json({ error: 'xgodo token not configured' }, { status: 500 });

    // Build task input — keyword goes into the task params
    const taskInput: Record<string, unknown> = {
      keyword,
      num_videos: numVideos,
      fetch_channel_age: fetchChannelAge,
    };
    if (fetchChannelAge) {
      taskInput.youtube_api_key = youtubeApiKey || config.niche_yt_api_keys?.split(',')[0]?.trim() || config.youtube_api_key || '';
    }

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
