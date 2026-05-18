import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * Per-video membership lookup + bulk set, used by the StarChooser
 * modal:
 *
 * GET  /api/niche-spy/custom-niches/membership?videoId=N
 *      → { customNicheIds: number[] }  — which niches contain
 *        the video right now. Drives the modal's pre-checked state.
 *
 * POST /api/niche-spy/custom-niches/membership
 *      body: { videoId: number, customNicheIds: number[] }
 *      → replaces the set of (customNicheId, videoId) memberships
 *        in one transaction. Insert missing, delete removed.
 *
 *      The favourites toggle is a separate concern — the modal sends
 *      a normal POST/DELETE to /api/niche-spy/favourites alongside
 *      this call. We keep the two surfaces independent so an outage
 *      on one doesn't break the other.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const videoId = parseInt(req.nextUrl.searchParams.get('videoId') || '');
  if (!Number.isFinite(videoId)) return NextResponse.json({ error: 'videoId required' }, { status: 400 });
  const pool = await getPool();
  const r = await pool.query<{ custom_niche_id: number }>(
    `SELECT custom_niche_id FROM custom_niche_videos WHERE video_id = $1`,
    [videoId],
  );
  return NextResponse.json({
    customNicheIds: r.rows.map(row => row.custom_niche_id),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { videoId?: number; customNicheIds?: number[] };
  const videoId = body.videoId;
  const next = Array.isArray(body.customNicheIds) ? body.customNicheIds.filter(n => Number.isFinite(n)) : [];
  if (!Number.isFinite(videoId)) return NextResponse.json({ error: 'videoId required' }, { status: 400 });

  const pool = await getPool();
  // Defence: refuse if the video doesn't exist
  const check = await pool.query('SELECT 1 FROM niche_spy_videos WHERE id = $1', [videoId]);
  if (check.rows.length === 0) return NextResponse.json({ error: 'video not found' }, { status: 404 });

  // Compute the diff against current memberships, then apply in a
  // single transaction. The naive "DELETE all + INSERT new" would
  // also work but bumps added_at for unchanged rows, which we want
  // to preserve so users can sort by "recently added" inside a niche.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ custom_niche_id: number }>(
      `SELECT custom_niche_id FROM custom_niche_videos WHERE video_id = $1`,
      [videoId],
    );
    const currentSet = new Set(current.rows.map(r => r.custom_niche_id));
    const nextSet = new Set(next);

    const toAdd    = [...nextSet].filter(id => !currentSet.has(id));
    const toRemove = [...currentSet].filter(id => !nextSet.has(id));

    if (toAdd.length > 0) {
      // Bulk-insert with VALUES expansion. ON CONFLICT in case of
      // race with another tab updating the same video — second write
      // becomes a no-op instead of erroring.
      const placeholders = toAdd.map((_, i) => `($${i + 1}, $${toAdd.length + 1})`).join(',');
      await client.query(
        `INSERT INTO custom_niche_videos (custom_niche_id, video_id) VALUES ${placeholders}
         ON CONFLICT DO NOTHING`,
        [...toAdd, videoId],
      );
      // Bump updated_at on each touched niche so the My Niches list
      // re-sorts to the top.
      await client.query(
        `UPDATE custom_niches SET updated_at = NOW() WHERE id = ANY($1::int[])`,
        [toAdd],
      );
    }
    if (toRemove.length > 0) {
      await client.query(
        `DELETE FROM custom_niche_videos WHERE video_id = $1 AND custom_niche_id = ANY($2::int[])`,
        [videoId, toRemove],
      );
      await client.query(
        `UPDATE custom_niches SET updated_at = NOW() WHERE id = ANY($1::int[])`,
        [toRemove],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return NextResponse.json({ ok: true, customNicheIds: next });
}
