import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getApiUser } from '@/lib/api-auth';

/**
 * POST /api/video_prompt/confirm
 *
 * Finalises a reservation made by GET /api/video_prompt?reservable=1.
 * The client calls this AFTER the video is actually generated and
 * submitted, locking the prompt as truly used. Until this is called,
 * the prompt is sitting on a 5-minute reservation; if it expires
 * unconfirmed, the next /video_prompt pop will pick it up again,
 * preventing the "client crashed → prompt lost forever" failure mode.
 *
 * Body:
 *   { claim_token: string;          // returned by the GET pop
 *     video_id?: string;             // optional: client-side video id
 *     meta?: object;                 // optional: any other metadata
 *                                    //   to stash in confirmation_meta
 *   }
 *
 * Auth: hb_ API token.
 *
 * Responses:
 *   200 { ok: true, id }                  — confirmed
 *   404 { detail: "..." }                 — token unknown or already expired
 *   409 { detail: "Already confirmed" }   — idempotent confirm collision
 *
 * The confirm is idempotent at the DB level: setting confirmed_at via
 * UPDATE … WHERE confirmed_at IS NULL means a second confirm with the
 * same token is a no-op rowCount=0 — we return 409 in that case so
 * the caller can tell "I succeeded" from "this token was never valid".
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ detail: 'Missing or invalid hb_ token' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as {
    claim_token?: string;
    video_id?: string;
    meta?: Record<string, unknown>;
  };
  if (!body.claim_token || typeof body.claim_token !== 'string') {
    return NextResponse.json({ detail: 'claim_token required' }, { status: 400 });
  }

  const meta = {
    confirmedBy: user.tokenId || 'anonymous',
    videoId: body.video_id ?? null,
    ...(body.meta && typeof body.meta === 'object' ? body.meta : {}),
  };

  const pool = await getPool();
  const r = await pool.query<{ id: number }>(
    `UPDATE video_prompts
        SET confirmed_at = NOW(),
            confirmation_meta = $1::jsonb
      WHERE claim_token = $2
        AND confirmed_at IS NULL
      RETURNING id`,
    [JSON.stringify(meta), body.claim_token],
  );

  if (r.rows.length === 0) {
    // Either the token never existed OR it was already confirmed. Tell
    // them which so a crashed-and-retrying client can distinguish.
    const exists = await pool.query<{ confirmed_at: Date | null }>(
      `SELECT confirmed_at FROM video_prompts WHERE claim_token = $1 LIMIT 1`,
      [body.claim_token],
    );
    if (exists.rows[0]?.confirmed_at) {
      return NextResponse.json(
        { detail: 'Already confirmed', confirmed_at: exists.rows[0].confirmed_at },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { detail: 'claim_token unknown or reservation expired (released back to pool)' },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, id: r.rows[0].id });
}
