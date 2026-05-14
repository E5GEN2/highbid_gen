import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { startSweep, getSweepState, type SweepTarget } from '@/lib/thumbnail-sweep';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * GET  /api/admin/tools/thumbnail-sweep
 *   → current sweep state (events newest-first, counts).
 *
 * POST /api/admin/tools/thumbnail-sweep
 *   body: { target?, limit?, concurrency?, dryRun? }
 *   → fire-and-forget sweep. Walks the unembedded v2/combined_v2 queue
 *     in score-DESC order, probes each thumbnail, marks the dead ones
 *     so the embedding worker skips them on subsequent runs. Default
 *     target = 'combined_v2', concurrency = 20.
 */

function publicState() {
  const s = getSweepState();
  return {
    running:    s.running,
    jobKey:     s.jobKey,
    startedAt:  s.startedAt,
    finishedAt: s.finishedAt,
    lastError:  s.lastError,
    counts: {
      total:             s.total,
      processed:         s.processed,
      alive:             s.alive,
      marked:            s.marked,
      noUrl:             s.noUrl,
      transientFailures: s.transientFailures,
    },
    events: s.events,
  };
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  return NextResponse.json(publicState());
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    target?: SweepTarget;
    limit?: number;
    concurrency?: number;
    dryRun?: boolean;
  };
  const r = startSweep(body);
  if (!r.started) {
    return NextResponse.json({ ok: true, started: false, reason: 'already_running', jobKey: r.jobKey });
  }
  return NextResponse.json({ ok: true, started: true, jobKey: r.jobKey });
}
