import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getApiUser } from '@/lib/api-auth';

/**
 * GET /api/video_prompt
 *
 * Pops one random prompt. The row is reserved for 5 minutes — if the
 * client doesn't POST /api/video_prompt/confirm within that window,
 * the row becomes available again.
 *
 * Response (200): { id, prompt }
 * Response (503): { detail: "Prompts are being generated, try again shortly" }
 *
 * Auth: hb_ Bearer token.
 *
 * Legacy mode (back-compat): GET /api/video_prompt?confirm=auto
 * marks the prompt as confirmed immediately on pop, same semantics as
 * before reservations existed. Returned shape stays the same so old
 * callers that ignore the id keep working.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RESERVATION_MINUTES = 5;

export async function GET(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ detail: 'Missing or invalid hb_ token' }, { status: 401 });
  }

  const autoConfirm = req.nextUrl.searchParams.get('confirm') === 'auto';
  const pool = await getPool();

  // Pick a row that's either never been served OR whose reservation
  // expired. confirmed_at IS NULL guards against re-serving completed
  // ones. served_at is updated on each pop so the visibility window
  // restarts each time the row is handed out.
  const availablePredicate = `
    confirmed_at IS NULL
    AND (served_at IS NULL OR served_at < NOW() - INTERVAL '${RESERVATION_MINUTES} minutes')
  `;

  const popPromise = autoConfirm
    ? pool.query<{ id: number; prompt: string }>(
        `UPDATE video_prompts
            SET served_at = NOW(),
                served_to = $1,
                confirmed_at = NOW()
          WHERE id = (
            SELECT id FROM video_prompts
             WHERE ${availablePredicate}
             ORDER BY RANDOM()
             LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, prompt`,
        [user.tokenId || 'anonymous'],
      )
    : pool.query<{ id: number; prompt: string }>(
        `UPDATE video_prompts
            SET served_at = NOW(),
                served_to = $1
          WHERE id = (
            SELECT id FROM video_prompts
             WHERE ${availablePredicate}
             ORDER BY RANDOM()
             LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, prompt`,
        [user.tokenId || 'anonymous'],
      );

  const [popRes, settingsRes] = await Promise.all([
    popPromise,
    pool.query<{ suffix: string; suffix_enabled: boolean }>(
      `SELECT suffix, suffix_enabled FROM vid_gen_settings WHERE id = 1`,
    ).catch(() => ({ rows: [] as Array<{ suffix: string; suffix_enabled: boolean }> })),
  ]);

  if (popRes.rows.length === 0) {
    return NextResponse.json(
      { detail: 'Prompts are being generated, try again shortly' },
      { status: 503 },
    );
  }

  let prompt = popRes.rows[0].prompt;
  const cfg = settingsRes.rows[0];
  if (cfg?.suffix_enabled && cfg.suffix?.trim()) {
    const trimmed = cfg.suffix.trim();
    const sep = /^[,.;:!?]/.test(trimmed) ? '' : ' ';
    prompt = `${prompt}${sep}${trimmed}`;
  }

  return NextResponse.json({ id: popRes.rows[0].id, prompt });
}
