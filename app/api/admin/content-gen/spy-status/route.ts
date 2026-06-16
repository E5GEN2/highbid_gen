import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { spyStatusForGroups } from '@/lib/content-gen/content-gen-seeds';

/**
 * Lightweight spy-completion refresh for the Content Gen GUI.
 *
 * POST /api/admin/content-gen/spy-status
 *   Body: { groups: [{ draft_id, channels: [{ channel_id, top_video_id }] }] }
 *   Returns { spy_status: { draft_id: DraftSpyStatus } } by re-reading the
 *   ledger only — no discovery re-run, so the badges update live without the
 *   cards shifting.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const groups = Array.isArray(body.groups) ? body.groups : [];
  const spy_status = await spyStatusForGroups(groups).catch(() => ({}));
  return NextResponse.json({ ok: true, spy_status });
}
