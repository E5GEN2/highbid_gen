import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getApiUser } from '@/lib/api-auth';

/**
 * POST /api/video_prompt/confirm
 *
 * Marks a popped prompt as used so it doesn't return to the available
 * pool after its 5-minute reservation expires.
 *
 * Body: { id: number }
 *
 * Response: { ok: true } on success, { ok: false, detail } otherwise.
 *
 * Auth: hb_ Bearer token.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ detail: 'Missing or invalid hb_ token' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as { id?: number };
  const id = typeof body.id === 'number' ? body.id : null;
  if (id == null || !Number.isFinite(id)) {
    return NextResponse.json({ detail: 'id (number) required' }, { status: 400 });
  }

  const pool = await getPool();
  // Idempotent: a row that's already confirmed_at IS NOT NULL doesn't
  // get touched, but we still return ok so retries are safe.
  const r = await pool.query<{ id: number }>(
    `UPDATE video_prompts
        SET confirmed_at = NOW(),
            confirmation_meta = jsonb_build_object('confirmedBy', $1::text)
      WHERE id = $2 AND confirmed_at IS NULL
      RETURNING id`,
    [user.tokenId || 'anonymous', id],
  );

  if (r.rows.length === 0) {
    // Either id doesn't exist, or it was already confirmed (which is
    // safe to retry). Tell the caller which without making them care
    // too much.
    const exists = await pool.query(`SELECT 1 FROM video_prompts WHERE id = $1 LIMIT 1`, [id]);
    if (exists.rows.length === 0) {
      return NextResponse.json({ ok: false, detail: 'id not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, alreadyConfirmed: true });
  }
  return NextResponse.json({ ok: true });
}
