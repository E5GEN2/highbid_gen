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
    // Per-tool cache breakdown — drives the "tts ⚡3/3 · yt_capture 0/3"
    // chip in the GUI so the user can see at a glance which tools are
    // burning compute vs. serving from cache.
    const pool = await getPool();
    const cacheBreakdown = (await pool.query<{ tool: string; total: number; cached: number }>(
      `SELECT tool, COUNT(*)::int AS total, SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END)::int AS cached
         FROM content_gen_producer_gems WHERE job_id = $1 AND status = 'done'
        GROUP BY tool ORDER BY tool`,
      [id],
    )).rows;
    return NextResponse.json({ ok: true, ...result, cache_breakdown: cacheBreakdown });
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
    // gems_cached counted via correlated subquery so the GUI can show the
    // cache win-rate on the job list ("X/Y cached"). content_gen_producer_gems
    // already has the cache_hit column written by runOneGem on every hit.
    const whereJ = where.replace(/(\bstatus\s*=)/g, 'j.$1');
    const r = await pool.query(
      `SELECT j.id, j.channel_id, j.channel_name, j.niche_index, j.video_id, j.status,
              j.final_video_url, j.gems_total, j.gems_done, j.gems_failed, j.error,
              j.started_at, j.finished_at, j.created_at, j.updated_at,
              (SELECT COUNT(*) FROM content_gen_producer_gems g
                WHERE g.job_id = j.id AND g.cache_hit = TRUE)::int AS gems_cached
         FROM content_gen_producer_jobs j ${whereJ}
        ORDER BY j.id DESC LIMIT $1`,
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
