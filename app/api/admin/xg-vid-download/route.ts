import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { listRecent } from '@/lib/xg-vid-download';

/**
 * GET /api/admin/xg-vid-download
 *
 * One-shot snapshot for the XG vid download admin tab. Returns the
 * recent rows + a status-keyed counts object so the tiles up top can
 * render without a second roundtrip.
 *
 * Query params:
 *   status  one of queued | submitted | running | downloaded | confirmed
 *           | failed | gone | all (default all)
 *   limit   default 100, max 500
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status') || 'all';
  const limit = Math.min(500, Math.max(1, parseInt(sp.get('limit') || '100') || 100));

  const data = await listRecent({ limit, status });
  return NextResponse.json({ ok: true, ...data, at: new Date().toISOString() });
}
