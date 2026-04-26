import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { runVizardTick } from '@/lib/vizard-tick';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
// 60s upper bound — a single tick processes up to 10 projects, each costing
// one Vizard query call (~1s), plus the optional clip upsert. Even worst
// case is well under a minute.
export const maxDuration = 60;

/**
 * GET /api/cron/vizard
 *
 * Server-side cron entry point for the Vizard pipeline. Was previously
 * driven only by the admin UI's 30s setInterval, which silently stopped
 * working as soon as the user closed the tab — projects could sit in
 * 'processing' indefinitely with Vizard's clips ready and nothing pulling
 * them. This route fixes that by letting Railway's cron call us every
 * minute regardless of what the admin UI is doing.
 *
 * Auth: Bearer token must match admin_config.cron_secret (same pattern
 * as /api/cron/sync, /api/cron/agents, etc.). Returning 401 to anyone
 * without the secret prevents random external traffic from triggering
 * Vizard polls.
 *
 * Schedule (Railway cron config):
 *   path:     /api/cron/vizard
 *   schedule: every 1 minute
 *   header:   Authorization: Bearer <cron_secret>
 *
 * Polling cadence is governed by tick's own internal "last_polled_at >25s
 * ago" filter — calling this route twice in 30s won't double-hit Vizard
 * because the second call will see no projects due. Safe to schedule
 * aggressively.
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
    const result = await runVizardTick();
    return NextResponse.json({ ...result, ranAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
