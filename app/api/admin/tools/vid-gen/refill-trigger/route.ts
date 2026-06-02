import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { triggerAutoRefillIfNeeded } from '@/lib/vid-gen-runner';

/**
 * POST /api/admin/tools/vid-gen/refill-trigger
 *
 * Manually invoke the auto-refill check from outside the
 * /api/video_prompt path. Same idempotent semantics — skips when:
 *   - auto_refill_enabled is false
 *   - a vid_gen_runs row is already in status='running' (after the
 *     10-min stale sweep that lives inside the trigger itself)
 *   - available count is still above auto_refill_threshold
 *
 * Useful for:
 *   - Operator wants to top up the queue without waiting for a client
 *     to pop and trigger the check naturally.
 *   - Claude wants to verify the trigger path is alive without firing
 *     a real generation through /generate (which clutters the runs
 *     log with manual entries).
 *
 * Response shape mirrors triggerAutoRefillIfNeeded's return:
 *   { ok: true, triggered: boolean, reason: string, runId?: string }
 *
 * Where reason is one of:
 *   'no_settings_row' | 'disabled' | 'in_flight' |
 *   'above_threshold(N >= T)' | 'below_threshold(N < T)'
 *
 * Auth: admin Bearer token.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const result = await triggerAutoRefillIfNeeded();
  return NextResponse.json({ ok: true, ...result });
}
