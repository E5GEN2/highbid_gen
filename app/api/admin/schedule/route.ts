import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

const XGODO_BASE = 'https://xgodo.com/api/v2';

async function getConfig(pool: import('pg').Pool): Promise<Record<string, string>> {
  const result = await pool.query('SELECT key, value FROM admin_config');
  const config: Record<string, string> = {};
  for (const row of result.rows) config[row.key] = row.value;
  return config;
}

export async function POST(req: NextRequest) {
  try {
    const { numVideos, fetchChannelAge, youtubeApiKey, fetchChannelVideoCount, taskCount } = await req.json();

    if (!numVideos || numVideos < 1) {
      return NextResponse.json({ error: 'Num videos is required (min 1)' }, { status: 400 });
    }
    if (taskCount < 1 || taskCount > 100) {
      return NextResponse.json({ error: 'Task count must be 1-100' }, { status: 400 });
    }
    if (fetchChannelAge && !youtubeApiKey) {
      return NextResponse.json({ error: 'YouTube API key is required when fetching channel age' }, { status: 400 });
    }

    const pool = await getPool();
    const config = await getConfig(pool);
    const XGODO_TOKEN = config.xgodo_api_token || process.env.XGODO_API_TOKEN;
    const JOB_ID = config.xgodo_shorts_spy_job_id || process.env.XGODO_SHORTS_SPY_JOB_ID;

    if (!XGODO_TOKEN) throw new Error('xgodo API token not configured');
    if (!JOB_ID) throw new Error('xgodo job ID not configured');

    // Build the task input object
    const taskInput: Record<string, unknown> = {
      num_videos: numVideos,
      fetch_channel_age: fetchChannelAge || false,
      fetch_channel_video_count: fetchChannelVideoCount || false,
    };
    if (fetchChannelAge && youtubeApiKey) {
      taskInput.youtube_api_key = youtubeApiKey;
    }

    // Create the inputs array — each element is a JSON string
    const inputStr = JSON.stringify(taskInput);
    const inputs = Array.from({ length: taskCount }, () => inputStr);

    const res = await fetch(`${XGODO_BASE}/planned_tasks/submit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${XGODO_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        job_id: JOB_ID,
        inputs,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`xgodo planned_tasks/submit failed: ${res.status} ${text}`);
    }

    const result = await res.json();

    return NextResponse.json({
      success: true,
      scheduled: taskCount,
      taskInput,
      xgodoResponse: result,
    });
  } catch (error) {
    console.error('Schedule tasks error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to schedule tasks' },
      { status: 500 }
    );
  }
}
