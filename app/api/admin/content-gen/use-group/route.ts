import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { markGroupUsed, invalidateContentGenSeedCache } from '@/lib/content-gen/content-gen-seeds';
import { consumePinnedGroup, freePinnedGroup } from '@/lib/content-gen/pinned-groups';

/**
 * Mark a Content Gen group as "used" (consumed into a produced video).
 *
 * POST /api/admin/content-gen/use-group
 *   Body: { pinnedGroupId, note? }   ← preferred: server looks up the pin's EXACT
 *                                       frozen channel set (immune to UI drift) and
 *                                       flips the pin to 'consumed' (kept greyed).
 *   Body: { draftId, draftTitle?, channelIds: string[], note? }  ← back-compat.
 *   Inserts the group's channels into content_gen_used_channels — discoverChannels()
 *   then excludes them, so a Regenerate won't re-surface them.
 *
 * DELETE /api/admin/content-gen/use-group
 *   Body: { pinnedGroupId }    ← un-consume the pin (flip back to active) + bring
 *                                its channels back.
 *   Body: { channelIds: string[] }  ← back-compat un-mark by channel.
 *
 * GET /api/admin/content-gen/use-group
 *   List used channels (most recent first).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const r = await pool.query(
    `SELECT channel_id, draft_id, draft_title, note, used_at
       FROM content_gen_used_channels ORDER BY used_at DESC LIMIT 500`,
  );
  return NextResponse.json({ ok: true, used: r.rows, count: r.rowCount });
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  // Preferred path: mark by pinned group id. The server resolves the pin's EXACT
  // frozen channel set, so a drifted client payload can never mark the wrong set.
  const pinnedGroupId = body.pinnedGroupId ? String(body.pinnedGroupId) : '';
  if (pinnedGroupId) {
    const { channelIds, draftId, title } = await consumePinnedGroup(pinnedGroupId);
    if (channelIds.length === 0) {
      return NextResponse.json({ error: 'pinned group not found or empty' }, { status: 404 });
    }
    const written = await markGroupUsed(draftId, title, channelIds, body.note);
    return NextResponse.json({ ok: true, marked: written, pinnedGroupId, channelIds });
  }

  // Back-compat: explicit channelIds.
  const draftId = String(body.draftId || '');
  const draftTitle = String(body.draftTitle || draftId);
  const channelIds: string[] = Array.isArray(body.channelIds) ? body.channelIds.map(String) : [];
  if (channelIds.length === 0) {
    return NextResponse.json({ error: 'pinnedGroupId or channelIds[] required' }, { status: 400 });
  }
  const written = await markGroupUsed(draftId, draftTitle, channelIds, body.note);
  return NextResponse.json({ ok: true, marked: written, draftId });
}

export async function DELETE(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  // Un-consume a pin → flip back to active and resolve its channels to free.
  const pinnedGroupId = body.pinnedGroupId ? String(body.pinnedGroupId) : '';
  let channelIds: string[] = Array.isArray(body.channelIds) ? body.channelIds.map(String) : [];
  if (pinnedGroupId) channelIds = await freePinnedGroup(pinnedGroupId);

  if (channelIds.length === 0) return NextResponse.json({ error: 'pinnedGroupId or channelIds[] required' }, { status: 400 });
  const pool = await getPool();
  const r = await pool.query(`DELETE FROM content_gen_used_channels WHERE channel_id = ANY($1::text[])`, [channelIds]);
  invalidateContentGenSeedCache(); // freed channels become eligible seeds again
  return NextResponse.json({ ok: true, removed: r.rowCount, channelIds });
}
