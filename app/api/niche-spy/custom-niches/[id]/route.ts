import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * Single custom-niche resource.
 *
 * GET    /api/niche-spy/custom-niches/[id] → metadata + video count
 * PATCH  /api/niche-spy/custom-niches/[id] → rename / edit description
 * DELETE /api/niche-spy/custom-niches/[id] → drop the niche (cascade
 *   removes all custom_niche_videos rows; doesn't touch the videos
 *   themselves).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_NAME = 80;
const MAX_DESCRIPTION = 280;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const pool = await getPool();
  const r = await pool.query<{
    id: number; name: string; description: string | null;
    created_at: string; updated_at: string; video_count: string;
    center_video_id: number | null;
  }>(
    `SELECT n.id, n.name, n.description, n.created_at, n.updated_at,
            n.center_video_id,
            COALESCE((SELECT COUNT(*)::text FROM custom_niche_videos WHERE custom_niche_id = n.id), '0') AS video_count
       FROM custom_niches n
       WHERE n.id = $1`,
    [nicheId],
  );
  if (r.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const row = r.rows[0];
  return NextResponse.json({
    niche: {
      id: row.id,
      name: row.name,
      description: row.description,
      videoCount: parseInt(row.video_count) || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      centerVideoId: row.center_video_id,
    },
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const body = await req.json().catch(() => ({})) as {
    name?: string;
    description?: string | null;
    centerVideoId?: number | null;
  };
  const updates: string[] = [];
  const params: (string | null | number)[] = [];
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
    if (name.length > MAX_NAME) return NextResponse.json({ error: `name must be ≤ ${MAX_NAME} chars` }, { status: 400 });
    params.push(name);
    updates.push(`name = $${params.length}`);
  }
  if (body.description !== undefined) {
    const description = (body.description || '')?.toString().trim() || null;
    if (description && description.length > MAX_DESCRIPTION) {
      return NextResponse.json({ error: `description must be ≤ ${MAX_DESCRIPTION} chars` }, { status: 400 });
    }
    params.push(description);
    updates.push(`description = $${params.length}`);
  }
  if (body.centerVideoId !== undefined) {
    // null clears the center; a number sets it. Defence: refuse
    // when the supplied video isn't actually a member of this
    // niche — otherwise the center could point at a row not in
    // the collection, which would be semantically broken.
    if (body.centerVideoId === null) {
      params.push(null);
      updates.push(`center_video_id = $${params.length}`);
    } else if (Number.isFinite(body.centerVideoId)) {
      const pool = await getPool();
      const member = await pool.query(
        `SELECT 1 FROM custom_niche_videos WHERE custom_niche_id = $1 AND video_id = $2`,
        [nicheId, body.centerVideoId],
      );
      if (member.rowCount === 0) {
        return NextResponse.json({ error: 'center video is not in this niche' }, { status: 400 });
      }
      params.push(body.centerVideoId);
      updates.push(`center_video_id = $${params.length}`);
    } else {
      return NextResponse.json({ error: 'centerVideoId must be a number or null' }, { status: 400 });
    }
  }
  if (updates.length === 0) return NextResponse.json({ error: 'no updates' }, { status: 400 });
  updates.push(`updated_at = NOW()`);
  params.push(nicheId);

  const pool = await getPool();
  const r = await pool.query(
    `UPDATE custom_niches SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params,
  );
  if (r.rowCount === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const pool = await getPool();
  await pool.query(`DELETE FROM custom_niches WHERE id = $1`, [nicheId]);
  return NextResponse.json({ ok: true });
}
