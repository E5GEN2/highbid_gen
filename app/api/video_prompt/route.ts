import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getApiUser } from '@/lib/api-auth';
import crypto from 'crypto';

/**
 * GET /api/video_prompt
 *
 * Public client-facing endpoint. Pops one random prompt atomically.
 * Two modes:
 *
 *   Default (legacy):
 *     served_at + served_to are stamped; the prompt is permanently
 *     consumed on this call. Existing clients keep working unchanged.
 *
 *   ?reservable=1  (recommended for new clients):
 *     The pop creates a 5-minute RESERVATION instead of a permanent
 *     consume. Response includes a claim_token. The client must POST
 *     /api/video_prompt/confirm with that token after the video is
 *     actually generated. If they never confirm, the prompt is
 *     returned to the available pool automatically when the next pop
 *     scans for candidates (anything with served_at older than 5min
 *     AND no confirmed_at is treated as available again).
 *
 *     This fixes the production scenario where 350 prompts were popped
 *     but only 15 videos got generated — clients can now crash mid-
 *     generation without permanently losing the prompt.
 *
 *     The global suffix (vid_gen_settings.suffix) is appended at serve
 *     time when enabled, same as before.
 *
 * Auth: hb_ API token (Authorization: Bearer hb_…).
 *
 * Response (200):
 *   default:     { "prompt": "<prompt text>" }
 *   reservable:  { "prompt": "<prompt text>", "claim_token": "<uuid>", "expires_in_seconds": 300 }
 *
 * Response (503):
 *   { "detail": "Prompts are being generated, try again shortly" }
 *
 * Atomicity: one UPDATE … RETURNING with a FOR UPDATE SKIP LOCKED
 * subquery, so concurrent pops never hand out the same row.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RESERVATION_MINUTES = 5;

export async function GET(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ detail: 'Missing or invalid hb_ token' }, { status: 401 });
  }

  const reservable = req.nextUrl.searchParams.get('reservable') === '1';
  const claimToken = reservable ? crypto.randomUUID() : null;
  const pool = await getPool();

  // The "available row" predicate is shared by both modes: a row whose
  // confirmed_at is NULL AND has either never been served OR was served
  // more than RESERVATION_MINUTES ago (i.e. its reservation expired).
  // Splitting the UPDATE itself into two paths avoids a CASE expression
  // that confuses pg's parameter-type inference when claim_token is null.
  const availablePredicate = `
    confirmed_at IS NULL
    AND (served_at IS NULL OR served_at < NOW() - INTERVAL '${RESERVATION_MINUTES} minutes')
  `;

  const popPromise = reservable
    ? pool.query<{ id: number; prompt: string }>(
        `UPDATE video_prompts
            SET served_at  = NOW(),
                served_to  = $1,
                claim_token = $2
          WHERE id = (
            SELECT id FROM video_prompts
             WHERE ${availablePredicate}
             ORDER BY RANDOM()
             LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, prompt`,
        [user.tokenId || 'anonymous', claimToken],
      )
    : pool.query<{ id: number; prompt: string }>(
        // Legacy mode: stamp confirmed_at = served_at so the row is
        // permanently consumed — same semantics as before reservations.
        `UPDATE video_prompts
            SET served_at  = NOW(),
                served_to  = $1,
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

  if (reservable) {
    return NextResponse.json({
      prompt,
      claim_token: claimToken,
      expires_in_seconds: RESERVATION_MINUTES * 60,
    });
  }
  return NextResponse.json({ prompt });
}
