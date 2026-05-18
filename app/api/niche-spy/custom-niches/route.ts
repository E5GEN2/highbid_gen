import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * Custom niches — user-curated video collections (vs. the
 * auto-discovered niche_tree_clusters). One row in custom_niches
 * per collection, m:n with niche_spy_videos via custom_niche_videos.
 *
 * GET  /api/niche-spy/custom-niches → list all niches with video
 *   counts, ordered by updated_at DESC (most recently touched first).
 * POST /api/niche-spy/custom-niches → create a new one
 *   body: { name: string, description?: string }
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_NAME = 80;
const MAX_DESCRIPTION = 280;

export async function GET() {
  const pool = await getPool();
  const r = await pool.query<{
    id: number; name: string; description: string | null;
    video_count: string; created_at: string; updated_at: string;
  }>(
    `SELECT
       n.id, n.name, n.description, n.created_at, n.updated_at,
       COALESCE(c.cnt, 0)::text AS video_count
     FROM custom_niches n
     LEFT JOIN (
       SELECT custom_niche_id, COUNT(*) AS cnt
         FROM custom_niche_videos
         GROUP BY custom_niche_id
     ) c ON c.custom_niche_id = n.id
     ORDER BY n.updated_at DESC`,
  );
  return NextResponse.json({
    niches: r.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      videoCount: parseInt(row.video_count) || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    total: r.rows.length,
  });
}

export async function POST(req: NextRequest) {
  const pool = await getPool();
  const body = await req.json().catch(() => ({})) as { name?: string; description?: string };
  const name = (body.name || '').trim();
  const description = (body.description || '').trim() || null;
  if (!name) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  if (name.length > MAX_NAME) {
    return NextResponse.json({ error: `name must be ≤ ${MAX_NAME} chars` }, { status: 400 });
  }
  if (description && description.length > MAX_DESCRIPTION) {
    return NextResponse.json({ error: `description must be ≤ ${MAX_DESCRIPTION} chars` }, { status: 400 });
  }

  const r = await pool.query<{
    id: number; name: string; description: string | null;
    created_at: string; updated_at: string;
  }>(
    `INSERT INTO custom_niches (name, description) VALUES ($1, $2)
     RETURNING id, name, description, created_at, updated_at`,
    [name, description],
  );
  const row = r.rows[0];
  return NextResponse.json({
    niche: {
      id: row.id,
      name: row.name,
      description: row.description,
      videoCount: 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  });
}
