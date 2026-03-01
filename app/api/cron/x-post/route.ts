import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';
import { executeAutoPost } from '../../../../lib/autoPost';

async function getConfig(pool: import('pg').Pool): Promise<Record<string, string>> {
  const result = await pool.query('SELECT key, value FROM admin_config');
  const config: Record<string, string> = {};
  for (const row of result.rows) config[row.key] = row.value;
  return config;
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

    // Check if auto-post is enabled
    if (config.auto_post_enabled !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'disabled' });
    }

    // Interval guard: check if enough hours have passed since last post
    const intervalHours = parseInt(config.auto_post_interval_hours) || 24;
    if (config.last_auto_post_at) {
      const elapsed = Date.now() - new Date(config.last_auto_post_at).getTime();
      if (elapsed < intervalHours * 60 * 60 * 1000) {
        const nextIn = Math.round((intervalHours * 60 * 60 * 1000 - elapsed) / 60000);
        return NextResponse.json({ skipped: true, reason: 'interval_not_reached', nextInMinutes: nextIn });
      }
    }

    // Execute the posting
    const result = await executeAutoPost(pool);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[cron/x-post] error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to auto-post' },
      { status: 500 }
    );
  }
}
