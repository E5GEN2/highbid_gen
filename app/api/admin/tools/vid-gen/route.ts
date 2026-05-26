import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * Admin Vid Gen tool — prompt-queue management.
 *
 * GET /api/admin/tools/vid-gen
 *   ?status=available|served|all  (default 'available')
 *   ?source=manual|ai-generated|all  (default 'all')
 *   ?search=string                 (ILIKE on prompt text)
 *   ?limit=number                  default 50, max 500
 *   ?offset=number                 default 0
 *
 *   Returns paginated prompt rows + top-line counts.
 *
 * POST /api/admin/tools/vid-gen
 *   body: { prompts: string[] }    OR  { prompt: string }
 *
 *   Bulk-add manually-authored prompts. ON CONFLICT (prompt) DO NOTHING
 *   so re-adding identical text is a no-op (the UNIQUE constraint on
 *   the column dedupes).
 *
 * DELETE /api/admin/tools/vid-gen
 *   body: { ids: number[] }
 *
 *   Permanently delete prompts (both served and unserved). Used by
 *   the admin UI for cleanup.
 *
 * Auth: admin Bearer token.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_PROMPT_LEN = 2000;

interface CountsRow { available: string; served: string; manual: string; ai: string; }

async function fetchCounts(): Promise<{ available: number; served: number; manual: number; ai: number; total: number }> {
  const pool = await getPool();
  const r = await pool.query<CountsRow>(
    `SELECT
       COUNT(*) FILTER (WHERE served_at IS NULL)::text                AS available,
       COUNT(*) FILTER (WHERE served_at IS NOT NULL)::text             AS served,
       COUNT(*) FILTER (WHERE source = 'manual')::text                 AS manual,
       COUNT(*) FILTER (WHERE source = 'ai-generated')::text           AS ai
       FROM video_prompts`,
  );
  const row = r.rows[0];
  const available = parseInt(row?.available ?? '0') || 0;
  const served    = parseInt(row?.served    ?? '0') || 0;
  return {
    available, served,
    manual: parseInt(row?.manual ?? '0') || 0,
    ai:     parseInt(row?.ai     ?? '0') || 0,
    total: available + served,
  };
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status') || 'available';
  const source = sp.get('source') || 'all';
  const search = sp.get('search') || '';
  const limit  = Math.max(1, Math.min(parseInt(sp.get('limit')  || '50'), 500));
  const offset = Math.max(0, parseInt(sp.get('offset') || '0'));

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status === 'available') where.push('served_at IS NULL');
  else if (status === 'served') where.push('served_at IS NOT NULL');
  if (source !== 'all') {
    params.push(source);
    where.push(`source = $${params.length}`);
  }
  if (search.trim()) {
    params.push(`%${search.trim()}%`);
    where.push(`prompt ILIKE $${params.length}`);
  }
  params.push(limit);
  params.push(offset);

  const pool = await getPool();
  const r = await pool.query(
    `SELECT id, prompt, source, generation_meta, created_at, served_at, served_to
       FROM video_prompts
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const counts = await fetchCounts();
  return NextResponse.json({
    ok: true,
    counts,
    prompts: r.rows.map(row => ({
      id: row.id,
      prompt: row.prompt,
      source: row.source,
      generationMeta: row.generation_meta,
      createdAt: row.created_at,
      servedAt: row.served_at,
      servedTo: row.served_to,
    })),
    limit, offset,
  });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { prompt?: string; prompts?: string[] };
  // Accept either a single prompt or an array. Normalize to array of
  // clean strings, drop blanks, cap each at MAX_PROMPT_LEN, dedupe
  // within this batch before hitting the DB.
  const raw: string[] = Array.isArray(body.prompts)
    ? body.prompts
    : typeof body.prompt === 'string'
      ? [body.prompt]
      : [];
  const cleaned = [...new Set(
    raw
      .filter(p => typeof p === 'string')
      .map(p => p.trim())
      .filter(p => p.length > 0 && p.length <= MAX_PROMPT_LEN),
  )];

  if (cleaned.length === 0) {
    return NextResponse.json({ error: 'prompts (array) or prompt (string) required' }, { status: 400 });
  }
  if (cleaned.length > 500) {
    return NextResponse.json({ error: 'max 500 prompts per request' }, { status: 400 });
  }

  const pool = await getPool();
  // Bulk INSERT with VALUES expansion + ON CONFLICT DO NOTHING on the
  // UNIQUE prompt column so an existing identical row stays put.
  const placeholders = cleaned.map((_, i) => `($${i + 1}, 'manual')`).join(',');
  const r = await pool.query<{ id: number }>(
    `INSERT INTO video_prompts (prompt, source) VALUES ${placeholders}
       ON CONFLICT (prompt) DO NOTHING
       RETURNING id`,
    cleaned,
  );

  const counts = await fetchCounts();
  return NextResponse.json({
    ok: true,
    added:   r.rowCount ?? 0,
    skipped: cleaned.length - (r.rowCount ?? 0),
    counts,
  });
}

export async function DELETE(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { ids?: number[] };
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids (number[]) required' }, { status: 400 });
  }
  if (ids.length > 500) {
    return NextResponse.json({ error: 'max 500 ids per request' }, { status: 400 });
  }

  const pool = await getPool();
  const r = await pool.query(
    `DELETE FROM video_prompts WHERE id = ANY($1::int[]) RETURNING id`,
    [ids],
  );
  const counts = await fetchCounts();
  return NextResponse.json({ ok: true, deleted: r.rowCount ?? 0, counts });
}
