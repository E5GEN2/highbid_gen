import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * DELETE /api/admin/vizard/clips/:id
 *
 * Removes a single clip row from vizard_clips. Used to clean up
 * one-off bad clips (Vizard occasionally returns the wrong source URL
 * or a corrupted file) without losing the rest of the project's
 * clips. Local-only — does NOT touch xgodo (any planned/running task
 * tied to this clip's planned_task_id is left alone; the clip data
 * just stops appearing in our admin views).
 *
 * Matches the no-admin-auth pattern of the other vizard routes
 * (auth is handled at the cookie/middleware layer for /admin/*).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const clipId = parseInt(id);
  if (Number.isNaN(clipId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  const pool = await getPool();
  // Drop pin records first if any (foreign-key-by-convention; there
  // isn't a real FK between vizard_clips and agent_planned_pins, but
  // keeping them tidy avoids stale rows the sweep would later have to
  // scan).
  await pool.query(
    `DELETE FROM agent_planned_pins
       WHERE planned_task_id IN (
         SELECT xgodo_upload_id FROM vizard_clips WHERE id = $1 AND xgodo_upload_id IS NOT NULL
       )`,
    [clipId],
  ).catch(() => {}); // best-effort

  const res = await pool.query(
    `DELETE FROM vizard_clips WHERE id = $1 RETURNING id`,
    [clipId],
  );
  if (res.rowCount === 0) {
    return NextResponse.json({ error: 'clip not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id: clipId });
}
