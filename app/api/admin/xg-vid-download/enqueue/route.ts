import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import {
  fetchPendingReviewTasks,
  enqueueReviewTasks,
  drainPending,
} from '@/lib/xg-vid-download';

/**
 * POST /api/admin/xg-vid-download/enqueue
 *
 * Body: { maxJobs?: number; parallel?: number }
 *   maxJobs  — how many pending review tasks to pull from xgodo this
 *              batch (1-50, default 10). Mirrors the Analyze Vids
 *              "Max jobs to create" input.
 *   parallel — how many workers to run concurrently while processing
 *              the freshly-inserted rows (1-10, default 5).
 *
 * Flow:
 *   1. fetchPendingReviewTasks(maxJobs) — pull the queue from xgodo.
 *   2. enqueueReviewTasks(...) — insert any we haven't seen before.
 *      Rows already in xg_video_downloads are skipped silently
 *      (idempotent — operator can mash this button without dups).
 *   3. drainPending(maxJobs * 2, parallel) — process anything claimable
 *      so the user sees rows move past 'queued' inside one click.
 *
 * Returns the per-row pipeline results + a fresh status snapshot.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { maxJobs?: number; parallel?: number };
  const maxJobs  = Math.min(50, Math.max(1, body.maxJobs ?? 10));
  const parallel = Math.min(10, Math.max(1, body.parallel ?? 5));

  let fetched: number;
  let inserted: number;
  let skipped: number;
  try {
    const tasks = await fetchPendingReviewTasks(maxJobs);
    fetched = tasks.length;
    const e = await enqueueReviewTasks(tasks);
    inserted = e.inserted;
    skipped = e.skipped;
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message?.slice(0, 500) || 'fetch failed' },
      { status: 502 },
    );
  }

  // Drain a bit more than we inserted — there may be older queued rows
  // from prior clicks that haven't finished yet. Cap at 50 so a single
  // click never tries to process the whole backlog.
  const drainLimit = Math.min(50, Math.max(inserted, 5) + 5);
  const drain = await drainPending(drainLimit, parallel);

  return NextResponse.json({
    ok: true,
    fetched, inserted, skipped,
    drained: drain.claimed,
    results: drain.results,
    at: new Date().toISOString(),
  });
}
