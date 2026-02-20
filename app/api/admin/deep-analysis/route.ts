import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';
import { runDeepAnalysis } from '../../../../lib/deep-analysis';

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get('admin_token')?.value;
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    return decoded.startsWith('admin:') && decoded.endsWith(':rofe_admin_secret');
  } catch {
    return false;
  }
}

// GET — List all runs with summary stats
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const pool = await getPool();

    const { rows: runs } = await pool.query(`
      SELECT r.id, r.status, r.channel_count, r.started_at, r.completed_at, r.error, r.created_at
      FROM deep_analysis_runs r
      ORDER BY r.created_at DESC
      LIMIT 50
    `);

    // Fetch channels for each run
    const runsWithChannels = await Promise.all(
      runs.map(async (run) => {
        const { rows: channels } = await pool.query(
          `SELECT id, channel_name, status, post_tweet FROM deep_analysis_channels WHERE run_id = $1 ORDER BY priority`,
          [run.id]
        );
        return { ...run, channels };
      })
    );

    return NextResponse.json({ runs: runsWithChannels });
  } catch (error) {
    console.error('Deep analysis GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch runs' },
      { status: 500 }
    );
  }
}

// POST — Start a new deep analysis run (returns SSE stream)
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pool = await getPool();

  // Get API key from config or env
  const { rows: configRows } = await pool.query(
    `SELECT value FROM admin_config WHERE key = 'papai_api_key'`
  );
  const apiKey = configRows[0]?.value || process.env.PAPAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'PAPAI_API_KEY not configured' }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      runDeepAnalysis(pool, apiKey, (progressEvent) => {
        send('progress', progressEvent);
      })
        .then((runId) => {
          send('done', { runId });
          controller.close();
        })
        .catch((error) => {
          const errMsg = error instanceof Error ? error.message : String(error);
          send('error', { error: errMsg });
          controller.close();
        });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
