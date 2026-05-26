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

  // Read the global suffix config in parallel with the pop. If the
  // settings row doesn't exist yet (fresh deploy) we fall back to
  // "no suffix" — no need to block the serve path on schema setup.
  const [popRes, settingsRes] = await Promise.all([
    pool.query<{ id: number; prompt: string }>(
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
    ),
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

  // Append the global suffix at serve time when enabled. Single-space
  // separator — the suffix should include its own leading comma /
  // punctuation if the user wants that (so ", photoreal, cinematic"
  // composes naturally with the prompt).
  let prompt = popRes.rows[0].prompt;
  const cfg = settingsRes.rows[0];
  if (cfg?.suffix_enabled && cfg.suffix?.trim()) {
    prompt = `${prompt} ${cfg.suffix.trim()}`;
  }

  return NextResponse.json({ prompt });
}
