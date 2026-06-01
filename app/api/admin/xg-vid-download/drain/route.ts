import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { drainPending } from '@/lib/xg-vid-download';

/**
 * POST /api/admin/xg-vid-download/drain
 *
 * Process up to `limit` already-queued rows, capping concurrency at
 * `parallel`. Doesn't pull anything new from xgodo — that's what
 * /enqueue does. Use this when the operator wants to push existing
 * rows further through the pipeline (e.g. poll once for everyone
 * who's been waiting on the worker) without enlarging the queue.
 *
 * Body: { limit?: number; parallel?: number }
 *   limit    default 20, max 100
 *   parallel default 5, max 10
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { limit?: number; parallel?: number };
  const limit    = Math.min(100, Math.max(1, body.limit ?? 20));
  const parallel = Math.min(10, Math.max(1, body.parallel ?? 5));

  const r = await drainPending(limit, parallel);
  return NextResponse.json({ ok: true, ...r, at: new Date().toISOString() });
}
