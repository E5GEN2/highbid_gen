import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

const XGODO_BASE = 'https://xgodo.com/api/v2';

async function getConfig(pool: import('pg').Pool): Promise<Record<string, string>> {
  const result = await pool.query('SELECT key, value FROM admin_config');
  const config: Record<string, string> = {};
  for (const row of result.rows) config[row.key] = row.value;
  return config;
}

async function saveConfig(pool: import('pg').Pool, entries: Record<string, string>) {
  for (const [key, value] of Object.entries(entries)) {
    await pool.query(
      `INSERT INTO admin_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const pool = await getPool();
    const config = await getConfig(pool);

    // Auth: Bearer token must match cron_secret
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cronSecret = config.cron_secret;

    if (!cronSecret || !token || token !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (config.auto_schedule_enabled !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'disabled' });
    }

    const taskCount = parseInt(config.auto_schedule_task_count) || 10;
    const numVideos = parseInt(config.auto_schedule_num_videos) || 20;
    const fetchChannelAge = config.auto_schedule_fetch_age === 'true';
    const fetchChannelVideoCount = config.auto_schedule_fetch_video_count === 'true';

    const XGODO_TOKEN = config.xgodo_api_token || process.env.XGODO_API_TOKEN;
    const JOB_ID = config.xgodo_shorts_spy_job_id || process.env.XGODO_SHORTS_SPY_JOB_ID;

    if (!XGODO_TOKEN) {
      return NextResponse.json({ success: false, error: 'xgodo API token not configured' }, { status: 500 });
    }
    if (!JOB_ID) {
      return NextResponse.json({ success: false, error: 'xgodo job ID not configured' }, { status: 500 });
    }

    // Build task input
    const taskInput: Record<string, unknown> = {
      num_videos: numVideos,
      fetch_channel_age: fetchChannelAge,
      fetch_channel_video_count: fetchChannelVideoCount,
    };
    if (fetchChannelAge && config.youtube_api_key) {
      taskInput.youtube_api_key = config.youtube_api_key;
    }

    const inputStr = JSON.stringify(taskInput);
    const inputs = Array.from({ length: taskCount }, () => inputStr);

    const res = await fetch(`${XGODO_BASE}/planned_tasks/submit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${XGODO_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ job_id: JOB_ID, inputs }),
    });

    const now = new Date().toISOString();

    if (!res.ok) {
      const errText = await res.text();
      const errorResult = { scheduled: 0, error: `xgodo ${res.status}: ${errText}` };
      await saveConfig(pool, {
        last_auto_schedule_at: now,
        last_auto_schedule_result: JSON.stringify(errorResult),
      });
      return NextResponse.json({ success: false, ...errorResult }, { status: 502 });
    }

    const result = { scheduled: taskCount, numVideos, fetchChannelAge, fetchChannelVideoCount };
    await saveConfig(pool, {
      last_auto_schedule_at: now,
      last_auto_schedule_result: JSON.stringify(result),
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('Cron schedule error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cron schedule failed' },
      { status: 500 }
    );
  }
}
