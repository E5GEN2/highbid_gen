import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { embedSpecificVideos } from '@/lib/embed-by-ids';
import type { EmbeddingTarget } from '@/lib/embeddings';

/**
 * POST /api/admin/embedding-requests/process-pending
 *
 * Claims every pending embedding_requests row in one shot and kicks off
 * a background worker for each. Returns the list of (id → status)
 * immediately; live progress is on each row's processed/errors columns
 * (poll via GET /api/admin/embedding-requests).
 *
 * Built for Claude — one curl to drain the queue without clicking
 * Process per-row in the admin UI.
 *
 * Body (optional): { limit?: number } — cap how many rows to process
 * in this batch. Default 10, max 50.
 *
 * Auth: admin Bearer token.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { limit?: number };
  const limit = Math.max(1, Math.min(body.limit ?? 10, 50));

  const pool = await getPool();
  // Atomic claim of N pending rows in a single UPDATE … RETURNING.
  // Uses FOR UPDATE SKIP LOCKED so concurrent calls don't double-claim.
  const claimRes = await pool.query<{
    id: number; source: string; video_ids: number[]; video_count: number;
  }>(
    `UPDATE embedding_requests
        SET status = 'processing',
            processed = 0,
            errors = 0,
            note = NULL,
            processed_at = NULL
      WHERE id IN (
        SELECT id FROM embedding_requests
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, source, video_ids, video_count`,
    [limit],
  );

  if (claimRes.rows.length === 0) {
    return NextResponse.json({ ok: true, claimed: 0, requests: [], detail: 'no pending requests' });
  }

  // Fire one background worker per row. Progress writes happen inside
  // embedSpecificVideos via the onProgress callback.
  for (const row of claimRes.rows) {
    const requestId = row.id;
    const videoIds = row.video_ids;
    const source = row.source as EmbeddingTarget;
    void (async () => {
      try {
        const result = await embedSpecificVideos(videoIds, source, async (partial) => {
          try {
            await pool.query(
              `UPDATE embedding_requests
                  SET processed = $1, errors = $2,
                      note = $3
                WHERE id = $4`,
              [
                partial.processed, partial.errors,
                `batch ${partial.batches}: processed=${partial.processed}/${partial.total} errors=${partial.errors} thumbDropped=${partial.thumbDropped} alreadyEmbedded=${partial.alreadyEmbedded}${partial.lastError ? ` lastErr=${partial.lastError.slice(0, 100)}` : ''}`.slice(0, 1000),
                requestId,
              ],
            );
          } catch { /* progress writes are best-effort */ }
        });
        const finalNote = `processed=${result.processed} errors=${result.errors} alreadyEmbedded=${result.alreadyEmbedded} thumbDropped=${result.thumbDropped} batches=${result.batches}${result.lastError ? ` lastErr=${result.lastError}` : ''}`;
        // Done only when every video has an embedding (or a terminal
        // thumbnail failure). Anything else = failed → re-processable.
        const completed = result.processed + result.alreadyEmbedded + result.thumbDropped;
        const newStatus = completed >= result.total ? 'done' : 'failed';
        await pool.query(
          `UPDATE embedding_requests
              SET status = $1, processed = $2, errors = $3, note = $4, processed_at = NOW()
            WHERE id = $5`,
          [newStatus, result.processed, result.errors, finalNote.slice(0, 1000), requestId],
        ).catch(() => {});
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
  }

  return NextResponse.json({
    ok: true,
    claimed: claimRes.rows.length,
    requests: claimRes.rows.map(r => ({
      id: r.id,
      source: r.source,
      videoCount: r.video_count,
      status: 'processing',
    })),
  });
}
