import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { embedSpecificVideos } from '@/lib/embed-by-ids';
import type { EmbeddingTarget } from '@/lib/embeddings';

/**
 * POST /api/admin/embedding-requests/[id]/process
 *
 * Kicks off the embedding job for a request and returns immediately.
 * The job runs in the background, writing live progress to
 * embedding_requests.processed / .errors / .note after every batch.
 * The admin UI polls the requests list to show "Processing 24/62".
 *
 * On completion the row flips to 'done' (any embeddings landed) or
 * 'failed' (zero landed). On uncaught exception: 'failed' with the
 * error in `note`.
 *
 * Body: {} (no params).
 *
 * Response: { ok, status: 'processing', requestId, totalVideos }.
 *
 * The actual embedding work uses lib/embed-by-ids.ts which reuses
 * batchEmbedInputs / batchEmbedGrouped / probeThumbnail / upsertVector
 * — identical primitives to the niche-explorer's runEmbeddingJob, so
 * results are consistent with what that pipeline would produce.
 *
 * Auth: admin Bearer token.
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
  // Atomic claim: pending → processing. Refuses if anything else.
  // Also resets the live counters in case this row was retried after
  // a 'failed' (we PATCH it back to 'pending' to retry).
  const claim = await pool.query<{ source: string; video_ids: number[]; video_count: number }>(
    `UPDATE embedding_requests
        SET status = 'processing',
            processed = 0,
            errors = 0,
            note = NULL,
            processed_at = NULL
      WHERE id = $1 AND status = 'pending'
      RETURNING source, video_ids, video_count`,
    [requestId],
  );
  if (claim.rows.length === 0) {
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
  const { source, video_ids: videoIds, video_count: totalVideos } = claim.rows[0];

  // Fire-and-forget — the request row is the durable progress log.
  // The route returns immediately; the admin UI polls for status +
  // progress updates.
  void (async () => {
    try {
      const result = await embedSpecificVideos(
        videoIds,
        source as EmbeddingTarget,
        async (partial) => {
          // After each batch: stamp processed + errors + a one-line
          // running note. Throttle via a tiny try/catch — a stalled
          // UPDATE shouldn't bubble up and break the embed loop.
          try {
            await pool.query(
              `UPDATE embedding_requests
                  SET processed = $1,
                      errors = $2,
                      note = $3
                WHERE id = $4`,
              [
                partial.processed,
                partial.errors,
                `batch ${partial.batches}: processed=${partial.processed}/${partial.total} errors=${partial.errors} thumbDropped=${partial.thumbDropped} alreadyEmbedded=${partial.alreadyEmbedded}${partial.lastError ? ` lastErr=${partial.lastError.slice(0, 100)}` : ''}`.slice(0, 1000),
                requestId,
              ],
            );
          } catch { /* swallow — progress writes mustn't tank the embed */ }
        },
      );
      const finalNote = `processed=${result.processed} errors=${result.errors} alreadyEmbedded=${result.alreadyEmbedded} thumbDropped=${result.thumbDropped} batches=${result.batches}${result.lastError ? ` lastErr=${result.lastError}` : ''}`;
      const newStatus = result.processed > 0 ? 'done' : 'failed';
      await pool.query(
        `UPDATE embedding_requests
            SET status = $1, processed = $2, errors = $3, note = $4, processed_at = NOW()
          WHERE id = $5`,
        [newStatus, result.processed, result.errors, finalNote.slice(0, 1000), requestId],
      ).catch(err => console.warn(`[embed-req ${requestId}] finalize failed:`, (err as Error).message));
      console.log(`[embed-req ${requestId}] ${newStatus}: ${finalNote}`);
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 1000) || 'unknown';
      await pool.query(
        `UPDATE embedding_requests
            SET status='failed', note=$1, processed_at=NOW()
          WHERE id=$2`,
        [`uncaught: ${msg}`, requestId],
      ).catch(() => {});
      console.error(`[embed-req ${requestId}] uncaught:`, err);
    }
  })();

  return NextResponse.json({
    ok: true,
    status: 'processing',
    requestId,
    totalVideos,
  });
}
