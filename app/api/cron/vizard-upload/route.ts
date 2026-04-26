import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { tickVizardUploads } from '@/lib/xgodo-vizard-upload';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

/**
 * GET /api/cron/vizard-upload
 *
 * Server-side cron for the Vizard → YouTube upload pipeline. Polls each
 * in-flight clip's xgodo task BY ID (not by scanning the queue), so each
 * cron tick costs one xgodo call per clip currently queued/running/uploaded.
 *
 * Auth: Bearer cron_secret — same pattern as /api/cron/sync,
 * /api/cron/vizard, etc.
 *
 * Schedule (Railway cron):
 *   path:     /api/cron/vizard-upload
 *   schedule: every 1 minute (* * * * *)
 *   header:   Authorization: Bearer <admin_config.cron_secret>
 *
 * Per-clip rate limit (last_polled_at >30s ago) means scheduling more
 * aggressively than 1/min won't double-poll any individual task.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const cfg = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'cron_secret' LIMIT 1`
  );
  const cronSecret = cfg.rows[0]?.value;

  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!cronSecret || !token || token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await tickVizardUploads();
    return NextResponse.json({ ...result, ranAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
