import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import {
  startValidate,
  getValidateState,
} from '@/lib/ai-studio-key-validate';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * GET  /api/admin/tools/ai-studio-keys/validate-pool
 *   → current re-validation state (events newest-first, counts).
 *
 * POST /api/admin/tools/ai-studio-keys/validate-pool
 *   body: { limit?, concurrency?, dryRun? }
 *   → kicks off the fire-and-forget pool revalidation. Walks every
 *     row in xgodo_api_keys where service='google_ai_studio' AND
 *     status='active', probes each key against the real
 *     gemini-embedding-2-preview endpoint, and DELETEs anything
 *     classified as terminally dead. Idempotent — once a key's gone
 *     a re-run just re-confirms the rest of the pool.
 */
function publicState() {
  const s = getValidateState();
  return {
    running:     s.running,
    jobKey:      s.jobKey,
    startedAt:   s.startedAt,
    finishedAt:  s.finishedAt,
    lastError:   s.lastError,
    counts: {
      total:     s.total,
      processed: s.processed,
      valid:     s.valid,
      invalid:   s.invalid,
      errors:    s.errors,
      deleted:   s.deleted,
    },
    events: s.events,  // already masked at construction
  };
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  return NextResponse.json(publicState());
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    limit?: number;
    concurrency?: number;
    dryRun?: boolean;
  };
  const r = startValidate({
    limit:       body.limit,
    concurrency: body.concurrency,
    dryRun:      body.dryRun,
  });
  if (!r.started) {
    return NextResponse.json({ ok: true, started: false, reason: 'already_running', jobKey: r.jobKey });
  }
  return NextResponse.json({ ok: true, started: true, jobKey: r.jobKey });
}
