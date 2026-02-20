import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../../lib/db';

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

// GET — Full run detail including channels, storyboards, synthesis, posts
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

    // Get run
    const { rows: runRows } = await pool.query(
      `SELECT * FROM deep_analysis_runs WHERE id = $1`,
      [runId]
    );
    if (runRows.length === 0) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }
    const run = runRows[0];

    // Get channels
    const { rows: channelRows } = await pool.query(
      `SELECT * FROM deep_analysis_channels WHERE run_id = $1 ORDER BY priority`,
      [runId]
    );

    // Get storyboards for each channel
    const channels = await Promise.all(
      channelRows.map(async (ch) => {
        const { rows: storyboards } = await pool.query(
          `SELECT * FROM deep_analysis_storyboards WHERE channel_entry_id = $1 ORDER BY created_at`,
          [ch.id]
        );
        return {
          ...ch,
          storyboards,
          post: ch.post_tweet ? { tweet: ch.post_tweet, hook_category: ch.post_hook_category } : null,
        };
      })
    );

    return NextResponse.json({ run, channels });
  } catch (error) {
    console.error('Deep analysis run detail error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch run detail' },
      { status: 500 }
    );
  }
}
