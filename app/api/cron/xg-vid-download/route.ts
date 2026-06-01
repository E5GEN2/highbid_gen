import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import {
  fetchPendingReviewTasks,
  enqueueReviewTasks,
  drainPending,
} from '@/lib/xg-vid-download';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

/**
 * GET /api/cron/xg-vid-download
 *
 * Background drain for the XG vid download pipeline.
 *
 *   1. Pull up to 10 pending review tasks from xgodo.
 *   2. Insert any new ones into xg_video_downloads.
 *   3. drainPending(25, 3) — process up to 25 in-flight rows with at
 *      most 3 workers concurrently. The cap matches the conservative
 *      end of the Analyze Vids defaults; if the cron is firing every
 *      minute we'd rather under-claim than burn through xgodo's rate
 *      limits.
 *
 * Auth: Bearer admin_config.cron_secret (same pattern as
 * /api/cron/vizard-upload, /api/cron/sync, /api/cron/vizard).
 *
 * Wire up in Railway cron with:
 *   path:     /api/cron/xg-vid-download
 *   schedule: * * * * *    (every minute)
 *   header:   Authorization: Bearer <admin_config.cron_secret>
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const cfg = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'cron_secret' LIMIT 1`,
  );
  const cronSecret = cfg.rows[0]?.value;

  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!cronSecret || !token || token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let fetched = 0, inserted = 0, skipped = 0;
  try {
    const tasks = await fetchPendingReviewTasks(10);
    fetched = tasks.length;
    const e = await enqueueReviewTasks(tasks);
    inserted = e.inserted;
    skipped  = e.skipped;
  } catch (err) {
    // Soft-fail the fetch leg — still try to drain whatever's already
    // queued. The cron's drain is what actually moves work forward,
    // pulling new tasks is a nice-to-have that shouldn't block it.
    console.warn('[xg-vid-download cron] fetch leg failed:', (err as Error).message);
  }

  const drain = await drainPending(25, 3);
  const summary = {
    ok: true,
    fetched, inserted, skipped,
    drained: drain.claimed,
    confirmed: drain.results.filter(r => r.finalStatus === 'confirmed').length,
    failed:    drain.results.filter(r => r.finalStatus === 'failed').length,
    ranAt: new Date().toISOString(),
  };
  // Single-line log so the existing Railway log tail surfaces it next
  // to [vizard-upload] / [niche-tree] etc.
  console.log(`[xg-vid-download] fetched=${summary.fetched} inserted=${summary.inserted} drained=${summary.drained} confirmed=${summary.confirmed} failed=${summary.failed}`);
  return NextResponse.json(summary);
}
