import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { markGroupUsed } from '@/lib/content-gen/content-gen-seeds';

/**
 * Mark a Content Gen group as "used" (consumed into a produced video).
 *
 * POST /api/admin/content-gen/use-group
 *   Body: { draftId, draftTitle?, channelIds: string[], note? }
 *   Inserts the group's channels into content_gen_used_channels — discoverChannels()
 *   then excludes them, so the used group disappears and a fresh group takes its
 *   place (the next batch of priority spy seeds).
 *
 * DELETE /api/admin/content-gen/use-group
 *   Body: { channelIds: string[] }  — un-mark (bring channels back).
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
  const draftId = String(body.draftId || '');
  const draftTitle = String(body.draftTitle || draftId);
  const channelIds: string[] = Array.isArray(body.channelIds) ? body.channelIds.map(String) : [];
  if (channelIds.length === 0) {
    return NextResponse.json({ error: 'channelIds[] required' }, { status: 400 });
  }
  const written = await markGroupUsed(draftId, draftTitle, channelIds, body.note);
  return NextResponse.json({ ok: true, marked: written, draftId });
}

export async function DELETE(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const channelIds: string[] = Array.isArray(body.channelIds) ? body.channelIds.map(String) : [];
  if (channelIds.length === 0) return NextResponse.json({ error: 'channelIds[] required' }, { status: 400 });
  const pool = await getPool();
  const r = await pool.query(`DELETE FROM content_gen_used_channels WHERE channel_id = ANY($1::text[])`, [channelIds]);
  return NextResponse.json({ ok: true, removed: r.rowCount });
}
