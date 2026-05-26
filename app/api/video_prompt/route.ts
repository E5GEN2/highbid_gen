import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getApiUser } from '@/lib/api-auth';

/**
 * GET /api/video_prompt
 *
 * Public client-facing endpoint. Pops one random unserved prompt
 * from `video_prompts` atomically and returns it. If the queue is
 * empty returns HTTP 503 so clients can back off and retry.
 *
 * Auth: hb_ API token (Authorization: Bearer hb_…). Mirrors the
 * existing client-API pattern.
 *
 * Response (200):
 *   { "prompt": "<prompt text>" }
 *
 * Response (503):
 *   { "detail": "Prompts are being generated, try again shortly" }
 *
 * Atomicity: the pop is one UPDATE ... RETURNING that uses a
 * subquery scoped to a single id with FOR UPDATE SKIP LOCKED, so
 * concurrent pops never hand out the same row. ORDER BY RANDOM()
 * is fine at the queue size we expect (hundreds → low thousands);
 * the partial index `idx_vp_available` keeps the candidate set
 * cheap to scan.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ detail: 'Missing or invalid hb_ token' }, { status: 401 });
  }

  const pool = await getPool();
  const r = await pool.query<{ id: number; prompt: string }>(
    `UPDATE video_prompts
        SET served_at = NOW(),
            served_to = $1
      WHERE id = (
        SELECT id FROM video_prompts
         WHERE served_at IS NULL
         ORDER BY RANDOM()
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, prompt`,
    [user.tokenId || 'anonymous'],
  );

  if (r.rows.length === 0) {
    return NextResponse.json(
      { detail: 'Prompts are being generated, try again shortly' },
      { status: 503 },
    );
  }

  return NextResponse.json({ prompt: r.rows[0].prompt });
}
