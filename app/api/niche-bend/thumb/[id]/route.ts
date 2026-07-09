import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { readImageFile } from '@/lib/xgodo-imagegen';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/niche-bend/thumb/{taskId} — serve a baked bend thumbnail.
 *
 * The generic /api/admin/imagegen/file route is admin-only, but the Niche
 * Finder (incl. this page) is open to Google-authed users, so their <img>
 * requests 403 there. This route serves the same file WITHOUT the admin
 * guard, but SCOPED to purpose 'niche_bend:%' so it can only ever expose a
 * niche-bend thumbnail — never an arbitrary imagegen asset.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const taskId = Number(id);
  if (!Number.isFinite(taskId)) return NextResponse.json({ error: 'bad id' }, { status: 400 });

  const pool = await getPool();
  const scoped = await pool.query(
    `SELECT 1 FROM imagegen_tasks WHERE id = $1 AND purpose LIKE 'niche_bend:%'`,
    [taskId],
  );
  if (!scoped.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const file = await readImageFile(taskId);
  if (!file) return NextResponse.json({ error: 'not downloaded' }, { status: 404 });

  return new Response(new Uint8Array(file.buf), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(file.buf.length),
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
