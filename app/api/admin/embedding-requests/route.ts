import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * Admin: list + status-update embedding requests filed by custom-niche
 * owners when their niche lacks the embeddings needed for clustering
 * by a particular source.
 *
 * GET    /api/admin/embedding-requests?status=pending|all
 *          → { ok, requests: [...] } sorted by created_at DESC.
 *
 * PATCH  /api/admin/embedding-requests
 *          body: { id: number; status: 'pending'|'processing'|'done'|'failed'|'dismissed'; note?: string }
 *          → { ok }
 *
 * Auth: admin Bearer token (hba_…).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VALID_STATUSES = new Set(['pending', 'processing', 'done', 'failed', 'dismissed']);

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status') || 'pending';
  const limit = Math.max(1, Math.min(parseInt(sp.get('limit') || '50'), 200));

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status !== 'all' && VALID_STATUSES.has(status)) {
    params.push(status);
    where.push(`er.status = $${params.length}`);
  }
  params.push(limit);

  const pool = await getPool();
  // Join niche metadata so the admin doesn't need a second fetch per
  // row. video_ids array is heavy, so we return just its length unless
  // a specific row is opened.
  const r = await pool.query(
    `SELECT er.id, er.custom_niche_id, er.source, er.video_count,
            er.requested_by, er.requester_label, er.status, er.note,
            er.created_at, er.processed_at,
            n.name AS niche_name, n.description AS niche_description
       FROM embedding_requests er
       LEFT JOIN custom_niches n ON n.id = er.custom_niche_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY er.created_at DESC
       LIMIT $${params.length}`,
    params,
  );

  // Bucketed counts for the admin badge / filter pills.
  const countsRes = await pool.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM embedding_requests GROUP BY status`,
  );
  const counts: Record<string, number> = {};
  for (const row of countsRes.rows) counts[row.status] = parseInt(row.n) || 0;

  return NextResponse.json({
    ok: true,
    counts,
    requests: r.rows.map(row => ({
      id: row.id,
      customNicheId: row.custom_niche_id,
      nicheName: row.niche_name,
      nicheDescription: row.niche_description,
      source: row.source,
      videoCount: row.video_count,
      requestedBy: row.requested_by,
      requesterLabel: row.requester_label,
      status: row.status,
      note: row.note,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    })),
  });
}

export async function PATCH(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { id?: number; status?: string; note?: string };
  if (typeof body.id !== 'number' || !Number.isFinite(body.id)) {
    return NextResponse.json({ error: 'id (number) required' }, { status: 400 });
  }
  if (body.status && !VALID_STATUSES.has(body.status)) {
    return NextResponse.json({ error: `status must be one of ${[...VALID_STATUSES].join(', ')}` }, { status: 400 });
  }

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (body.status) {
    params.push(body.status);
    sets.push(`status = $${params.length}`);
    if (body.status === 'done' || body.status === 'failed' || body.status === 'dismissed') {
      sets.push(`processed_at = NOW()`);
    }
  }
  if (typeof body.note === 'string') {
    params.push(body.note.slice(0, 1000));
    sets.push(`note = $${params.length}`);
  }
  if (sets.length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });

  params.push(body.id);
  const pool = await getPool();
  const r = await pool.query(
    `UPDATE embedding_requests SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params,
  );
  if (r.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/**
 * GET /api/admin/embedding-requests/[id] would return the full
 * video_ids list. For now, a separate sub-route keeps this listing
 * endpoint lightweight; admin opens a request's detail panel client-
 * side to fetch the full payload.
 */
