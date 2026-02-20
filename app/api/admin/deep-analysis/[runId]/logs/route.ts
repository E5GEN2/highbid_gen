import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../../../lib/db';

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

// GET — All AI call logs for a run
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { runId } = await params;
    const pool = await getPool();
    const searchParams = req.nextUrl.searchParams;
    const stepFilter = searchParams.get('step');
    const channelEntryIdFilter = searchParams.get('channel_entry_id');

    const conditions = ['run_id = $1'];
    const queryParams: string[] = [runId];
    let paramIdx = 2;

    if (stepFilter) {
      conditions.push(`step = $${paramIdx}`);
      queryParams.push(stepFilter);
      paramIdx++;
    }

    if (channelEntryIdFilter) {
      conditions.push(`channel_entry_id = $${paramIdx}`);
      queryParams.push(channelEntryIdFilter);
      paramIdx++;
    }

    const { rows: logs } = await pool.query(
      `SELECT id, step, channel_entry_id, prompt, response, model, duration_ms, status, error, tokens_in, tokens_out, created_at
       FROM deep_analysis_logs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at`,
      queryParams
    );

    return NextResponse.json({ logs });
  } catch (error) {
    console.error('Deep analysis logs error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch logs' },
      { status: 500 }
    );
  }
}
