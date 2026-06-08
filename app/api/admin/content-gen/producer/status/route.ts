/**
 * GET /api/admin/content-gen/producer/status?id=N
 *   Returns one job's full state — job row + every gem row.
 *
 * GET /api/admin/content-gen/producer/status?list=1[&status=running][&limit=50]
 *   Returns recent jobs for the overwatch dashboard.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getJobStatus } from '@/lib/content-gen/producer';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const idStr = sp.get('id');
  const list = sp.get('list');

  if (idStr) {
    const id = parseInt(idStr, 10);
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
    const result = await getJobStatus(id);
    if (!result.job) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, ...result });
  }

  if (list) {
    const pool = await getPool();
    const status = sp.get('status');
    const limit = Math.max(1, Math.min(200, parseInt(sp.get('limit') ?? '50', 10)));
    const args: unknown[] = [limit];
    let where = '';
    if (status) {
      args.push(status);
      where = `WHERE status = $${args.length}`;
    }
    const r = await pool.query(
      `SELECT id, channel_id, channel_name, niche_index, video_id, status,
              final_video_url, gems_total, gems_done, gems_failed, error,
              started_at, finished_at, created_at, updated_at
         FROM content_gen_producer_jobs ${where}
        ORDER BY id DESC LIMIT $1`,
      args,
    );
    // Aggregate counts for the dashboard chips.
    const counts = (await pool.query<{ status: string; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM content_gen_producer_jobs GROUP BY status`,
    )).rows.reduce((a, r) => { a[r.status] = r.n; return a; }, {} as Record<string, number>);
    return NextResponse.json({ ok: true, jobs: r.rows, counts });
  }

  return NextResponse.json({ error: 'need ?id=N or ?list=1' }, { status: 400 });
}
