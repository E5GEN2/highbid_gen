import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

/**
 * GET /api/admin/agents/log?page=1&limit=50&keyword=X&status=completed
 * Paginated task history with durations, enriched with seed/label + the
 * per-task crawl-trace counts (videos watched / candidates scored).
 *
 * Pure reader — the agent_task_proof watch-order is captured continuously by
 * the thermostat (every 30s), so this endpoint never touches xgodo and stays
 * fast. (An earlier version snapshotted on page load, which made the panel
 * hang while it fetched + upserted thousands of job_proof rows.)
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
    conditions.push(`l.keyword = $${paramIdx++}`);
    params.push(keyword);
  }
  if (status) {
    conditions.push(`l.status = $${paramIdx++}`);
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total
  const countRes = await pool.query(`SELECT COUNT(*) as cnt FROM agent_task_log l ${where}`, params);
  const total = parseInt(countRes.rows[0].cnt);

  // Fetch page, enriched with niche label/seed + crawl-trace counts.
  const res = await pool.query(`
    SELECT l.task_id, l.keyword, l.kind, l.seed_url, l.status, l.worker_name,
           l.first_seen_at, l.last_seen_at,
           EXTRACT(EPOCH FROM (l.last_seen_at - l.first_seen_at))::integer as duration_sec,
           n.label AS niche_label, n.seed_urls AS niche_seeds,
           COALESCE(p.watched_count, 0) AS watched_count,
           COALESCE(e.scored_count, 0)  AS scored_count
    FROM agent_task_log l
    LEFT JOIN agent_niches n ON n.niche_id = l.keyword
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE watched) AS watched_count
        FROM agent_task_proof WHERE task_id = l.task_id
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS scored_count
        FROM niche_seed_expansions WHERE task_id = l.task_id
    ) e ON true
    ${where}
    ORDER BY l.first_seen_at DESC
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `, [...params, limit, offset]);

  // Stats summary
  const statsRes = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'running') as running,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) as total,
      ROUND(AVG(EXTRACT(EPOCH FROM (last_seen_at - first_seen_at))) FILTER (WHERE status = 'completed')) as avg_duration,
      ROUND(MAX(EXTRACT(EPOCH FROM (last_seen_at - first_seen_at))) FILTER (WHERE status = 'completed')) as max_duration,
      ROUND(MIN(EXTRACT(EPOCH FROM (last_seen_at - first_seen_at))) FILTER (WHERE status = 'completed' AND EXTRACT(EPOCH FROM (last_seen_at - first_seen_at)) > 10)) as min_duration
    FROM agent_task_log
    ${keyword ? 'WHERE keyword = $1' : ''}
  `, keyword ? [keyword] : []);

  return NextResponse.json({
    tasks: res.rows.map(r => {
      const isSeed = r.kind === 'seed' || /^nd_/.test(r.keyword);
      return {
        id: r.task_id,
        keyword: r.keyword,
        kind: isSeed ? 'seed' : 'keyword',
        label: r.niche_label ?? r.keyword,
        seedUrl: r.seed_url ?? (Array.isArray(r.niche_seeds) && r.niche_seeds.length ? r.niche_seeds[0] : null),
        status: r.status,
        workerName: r.worker_name,
        firstSeen: r.first_seen_at,
        lastSeen: r.last_seen_at,
        duration: r.duration_sec,
        watchedCount: parseInt(r.watched_count) || 0,
        scoredCount: parseInt(r.scored_count) || 0,
      };
    }),
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
