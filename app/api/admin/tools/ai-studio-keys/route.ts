import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import {
  startKeyImport,
  getKeyImportState,
  DEFAULT_AI_STUDIO_KEY_JOB_ID,
} from '@/lib/ai-studio-key-import';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * GET  /api/admin/tools/ai-studio-keys
 *   → current import state (events newest-first, running flag, counts)
 *   Always strips `keyFull` before returning — only `key` (masked) goes
 *   over the wire.
 *
 * POST /api/admin/tools/ai-studio-keys
 *   body: { jobId?, limit?, concurrency?, dryRun?, commentSuffix? }
 *   → kicks off the fire-and-forget import. Returns immediately with
 *     `{ ok, started, jobKey }`. inFlight gate prevents double kicks.
 *
 * The job pulls tasks awaiting employer review (status='processing')
 * from the xgodo AI Studio key job, tests each candidate key via
 * residential proxy, inserts the good ones into xgodo_api_keys, and
 * confirms / declines the xgodo task accordingly.
 */

function publicState() {
  const s = getKeyImportState();
  return {
    running: s.running,
    jobKey: s.jobKey,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    lastError: s.lastError,
    counts: {
      total:     s.total,
      processed: s.processed,
      valid:     s.valid,
      invalid:   s.invalid,
      duplicate: s.duplicate,
      noKey:     s.noKey,
      errors:    s.errors,
    },
    events: s.events.map(e => {
      // Strip the full key from the wire — only the masked form goes
      // out. keyFull stays in process memory for log forensics only.
      const { keyFull: _drop, ...rest } = e;
      void _drop;
      return rest;
    }),
    defaultJobId: DEFAULT_AI_STUDIO_KEY_JOB_ID,
  };
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  return NextResponse.json(publicState());
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    jobId?: string;
    limit?: number;
    concurrency?: number;
    dryRun?: boolean;
    commentSuffix?: string;
  };
  const r = startKeyImport({
    jobId: body.jobId,
    limit: body.limit,
    concurrency: body.concurrency,
    dryRun: body.dryRun,
    commentSuffix: body.commentSuffix,
  });
  if (!r.started) {
    return NextResponse.json({ ok: true, started: false, reason: 'already_running', jobKey: r.jobKey }, { status: 200 });
  }
  return NextResponse.json({ ok: true, started: true, jobKey: r.jobKey });
}
