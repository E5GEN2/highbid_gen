import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getApiUser } from '@/lib/api-auth';

/**
 * POST /api/niche-spy/custom-niches/[id]/cluster/request-embeddings
 *
 * Files a request for an admin to compute the missing embeddings for
 * this niche's videos so the user can cluster by `source`.
 *
 * Body: { source: 'title_v2' | 'thumbnail_v2' | 'combined_v2' }
 *
 * Inserts one row into `embedding_requests` with the list of video IDs
 * in this niche that lack the requested embedding type. Admin sees it
 * in the "Embedding requests" admin tab and decides when to process.
 *
 * Returns { ok, requestId, queuedVideos, existingPending } — if a
 * pending request already exists for the same (niche, source), we
 * don't duplicate it; the response surfaces existingPending=true.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SUPPORTED = new Set(['title_v2', 'thumbnail_v2', 'combined_v2']);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const body = await req.json().catch(() => ({})) as { source?: string };
  if (!body.source || !SUPPORTED.has(body.source)) {
    return NextResponse.json({ error: 'source must be one of title_v2 | thumbnail_v2 | combined_v2' }, { status: 400 });
  }
  const source = body.source;
  const embeddingCol =
    source === 'title_v2'     ? 'title_embedding_v2' :
    source === 'thumbnail_v2' ? 'thumbnail_embedding_v2' :
                                'combined_embedding_v2';

  const pool = await getPool();
  // Niche sanity.
  const nicheRow = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM custom_niches WHERE id = $1`, [nicheId],
  );
  if (nicheRow.rows.length === 0) {
    return NextResponse.json({ error: 'custom niche not found' }, { status: 404 });
  }

  // If a request for this exact (niche, source) is already pending,
  // just point the user at it — no point creating duplicates.
  const existing = await pool.query<{ id: number; video_count: number }>(
    `SELECT id, video_count
       FROM embedding_requests
      WHERE custom_niche_id = $1 AND source = $2 AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1`,
    [nicheId, source],
  );
  if (existing.rows.length > 0) {
    return NextResponse.json({
      ok: true,
      requestId: existing.rows[0].id,
      queuedVideos: existing.rows[0].video_count,
      existingPending: true,
    });
  }

  // Pull video IDs in this niche missing the requested embedding.
  const missingRes = await pool.query<{ video_id: number }>(
    `SELECT cnv.video_id
       FROM custom_niche_videos cnv
       JOIN niche_spy_videos v ON v.id = cnv.video_id
      WHERE cnv.custom_niche_id = $1
        AND v.${embeddingCol} IS NULL`,
    [nicheId],
  );
  const videoIds = missingRes.rows.map(r => r.video_id);
  if (videoIds.length === 0) {
    return NextResponse.json({
      ok: true,
      requestId: null,
      queuedVideos: 0,
      detail: `All videos already have ${source} embeddings — no request needed.`,
    });
  }

  // Identify the requester. getApiUser covers both NextAuth sessions
  // and hb_ Bearer tokens; we store whatever id surface is available
  // plus a friendly label so the admin tab can show "claude via
  // hb_..." or "user@email" without a join.
  const user = await getApiUser(req).catch(() => null);
  const requestedBy = user?.tokenId || user?.id || null;
  const requesterLabel =
    user?.email || user?.name || (user?.tokenId ? `token:${user.tokenId.slice(0, 8)}` : null);

  const ins = await pool.query<{ id: number }>(
    `INSERT INTO embedding_requests
       (custom_niche_id, source, video_ids, video_count, requested_by, requester_label)
     VALUES ($1, $2, $3::int[], $4, $5, $6)
     RETURNING id`,
    [nicheId, source, videoIds, videoIds.length, requestedBy, requesterLabel],
  );

  return NextResponse.json({
    ok: true,
    requestId: ins.rows[0].id,
    queuedVideos: videoIds.length,
    existingPending: false,
  });
}
