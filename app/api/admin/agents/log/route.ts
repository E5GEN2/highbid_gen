import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

/**
 * GET /api/admin/agents/log?page=1&limit=50&keyword=X&status=completed
 * Paginated task history with durations.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  const page = parseInt(req.nextUrl.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '50'), 200);
  const keyword = req.nextUrl.searchParams.get('keyword') || '';
  const status = req.nextUrl.searchParams.get('status') || '';
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (keyword) {
    conditions.push(`keyword = $${paramIdx++}`);
    params.push(keyword);
  }
  if (status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total
  const countRes = await pool.query(`SELECT COUNT(*) as cnt FROM agent_task_log ${where}`, params);
  const total = parseInt(countRes.rows[0].cnt);

  // Fetch page
  const res = await pool.query(`
    SELECT task_id, keyword, status, worker_name, first_seen_at, last_seen_at,
           EXTRACT(EPOCH FROM (last_seen_at - first_seen_at))::integer as duration_sec
    FROM agent_task_log
    ${where}
    ORDER BY first_seen_at DESC
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `, [...params, limit, offset]);

  // Stats summary
  const statsRes = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'running') as running,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) as total,
      ROUND(AVG(EXTRACT(EPOCH FROM (last_seen_at - first_seen_at))) FILTER (WHERE status = 'completed'))::integer as avg_duration,
      MAX(EXTRACT(EPOCH FROM (last_seen_at - first_seen_at)))::integer FILTER (WHERE status = 'completed') as max_duration,
      MIN(EXTRACT(EPOCH FROM (last_seen_at - first_seen_at)))::integer FILTER (WHERE status = 'completed' AND EXTRACT(EPOCH FROM (last_seen_at - first_seen_at)) > 10) as min_duration
    FROM agent_task_log
    ${keyword ? 'WHERE keyword = $1' : ''}
  `, keyword ? [keyword] : []);

  return NextResponse.json({
    tasks: res.rows.map(r => ({
      id: r.task_id,
      keyword: r.keyword,
      status: r.status,
      workerName: r.worker_name,
      firstSeen: r.first_seen_at,
      lastSeen: r.last_seen_at,
      duration: r.duration_sec,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    stats: {
      running: parseInt(statsRes.rows[0]?.running) || 0,
      completed: parseInt(statsRes.rows[0]?.completed) || 0,
      total: parseInt(statsRes.rows[0]?.total) || 0,
      avgDuration: parseInt(statsRes.rows[0]?.avg_duration) || 0,
      maxDuration: parseInt(statsRes.rows[0]?.max_duration) || 0,
      minDuration: parseInt(statsRes.rows[0]?.min_duration) || 0,
    },
  });
}
