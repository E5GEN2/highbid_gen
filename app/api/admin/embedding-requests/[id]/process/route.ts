import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { embedSpecificVideos } from '@/lib/embed-by-ids';
import type { EmbeddingTarget } from '@/lib/embeddings';

/**
 * POST /api/admin/embedding-requests/[id]/process
 *
 * Actually run the embedding job for a request — generate Gemini
 * embeddings for the request's video_ids and source, persist them
 * (main DB column + vector-DB row), then flip the request to 'done'
 * with a note summarising what happened.
 *
 * Body: {} (no params)
 *
 * Response:
 *   { ok, processed, errors, alreadyEmbedded, thumbDropped, batches, lastError }
 *
 * On any uncaught exception during the embed run the request flips to
 * 'failed' with the error in `note` so the admin can decide whether
 * to retry.
 *
 * Auth: admin Bearer token.
 *
 * NOTE: synchronous — a typical request is a few dozen to a few
 * hundred videos which fits comfortably in the route's maxDuration.
 * For huge requests we'd queue this off to a worker; not worth it yet.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const { id } = await ctx.params;
  const requestId = parseInt(id);
  if (Number.isNaN(requestId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const pool = await getPool();
  // Atomic claim: only one admin can process the same row at a time.
  // We move pending → processing in a single UPDATE and refuse if the
  // row wasn't actually pending (already done, already in-flight, etc).
  const claim = await pool.query<{ source: string; video_ids: number[]; custom_niche_id: number }>(
    `UPDATE embedding_requests
        SET status = 'processing'
      WHERE id = $1 AND status = 'pending'
      RETURNING source, video_ids, custom_niche_id`,
    [requestId],
  );
  if (claim.rows.length === 0) {
    // Tell the caller WHY — already processed, dismissed, in flight, etc.
    const cur = await pool.query<{ status: string }>(
      `SELECT status FROM embedding_requests WHERE id = $1`,
      [requestId],
    );
    if (cur.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(
      { ok: false, error: `request is in status '${cur.rows[0].status}', not pending` },
      { status: 409 },
    );
  }
  const { source, video_ids: videoIds } = claim.rows[0];

  try {
    const result = await embedSpecificVideos(videoIds, source as EmbeddingTarget);
    const note = `processed=${result.processed} errors=${result.errors} alreadyEmbedded=${result.alreadyEmbedded} thumbDropped=${result.thumbDropped} batches=${result.batches}${result.lastError ? ` lastErr=${result.lastError}` : ''}`;
    // 'done' if any embeddings landed, otherwise 'failed' (we did the
    // work but produced nothing — likely a key-pool / proxy collapse
    // the operator should see).
    const newStatus = result.processed > 0 ? 'done' : 'failed';
    await pool.query(
      `UPDATE embedding_requests SET status = $1, note = $2, processed_at = NOW() WHERE id = $3`,
      [newStatus, note.slice(0, 1000), requestId],
    );
    return NextResponse.json({ ok: true, status: newStatus, ...result });
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 1000) || 'unknown';
    await pool.query(
      `UPDATE embedding_requests SET status='failed', note=$1, processed_at=NOW() WHERE id=$2`,
      [`uncaught: ${msg}`, requestId],
    );
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
