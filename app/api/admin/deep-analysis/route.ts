import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';
import { runDeepAnalysis, resumeDeepAnalysis, DEFAULT_FILTERS, TriageFilters } from '../../../../lib/deep-analysis';

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

  // Parse filters from body
  let filters: TriageFilters = { ...DEFAULT_FILTERS };
  try {
    const body = await req.json();
    if (body.filters) {
      filters = {
        date: body.filters.date || DEFAULT_FILTERS.date,
        maxAgeDays: body.filters.maxAgeDays ?? DEFAULT_FILTERS.maxAgeDays,
        minSubs: body.filters.minSubs ?? DEFAULT_FILTERS.minSubs,
        maxSubs: body.filters.maxSubs ?? DEFAULT_FILTERS.maxSubs,
        language: body.filters.language ?? DEFAULT_FILTERS.language,
        triageCount: body.filters.triageCount ?? DEFAULT_FILTERS.triageCount,
        pickCount: body.filters.pickCount ?? DEFAULT_FILTERS.pickCount,
      };
    }
  } catch {
    // No body or invalid JSON — use defaults
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
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* stream closed */ }
      };

      runDeepAnalysis(pool, apiKey, (progressEvent) => {
        send('progress', progressEvent);
      }, filters)
        .then((runId) => {
          send('done', { runId });
          try { controller.close(); } catch {}
        })
        .catch((error) => {
          const errMsg = error instanceof Error ? error.message : String(error);
          send('error', { error: errMsg });
          try { controller.close(); } catch {}
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

// PATCH — Cancel a stuck run OR retry/resume a run
export async function PATCH(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { runId, action } = body as { runId: string; action: 'cancel' | 'retry' };

    if (!runId || !action) {
      return NextResponse.json({ error: 'Missing runId or action' }, { status: 400 });
    }

    const pool = await getPool();

    if (action === 'cancel') {
      await pool.query(
        `UPDATE deep_analysis_runs SET status = 'error', error = 'Cancelled by user', completed_at = NOW() WHERE id = $1`,
        [runId]
      );
      // Also mark any in-progress channels as error
      await pool.query(
        `UPDATE deep_analysis_channels SET status = 'error', error = 'Run cancelled' WHERE run_id = $1 AND status NOT IN ('done', 'error')`,
        [runId]
      );
      return NextResponse.json({ ok: true });
    }

    if (action === 'retry') {
      // Get API key
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
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            } catch { /* stream closed */ }
          };

          resumeDeepAnalysis(pool, apiKey, runId, (progressEvent) => {
            send('progress', progressEvent);
          })
            .then((id) => {
              send('done', { runId: id });
              try { controller.close(); } catch {}
            })
            .catch((error) => {
              const errMsg = error instanceof Error ? error.message : String(error);
              send('error', { error: errMsg });
              try { controller.close(); } catch {}
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

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Deep analysis PATCH error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}
