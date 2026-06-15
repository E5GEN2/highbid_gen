import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { fetchTasksByStatus } from '@/lib/xgodo-tasks';
import { snapshotTaskProofs } from '@/lib/agent-task-proof';

const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';

/**
 * GET /api/admin/agents/log?page=1&limit=50&keyword=X&status=completed
 * Paginated task history with durations, enriched with seed/label + the
 * per-task crawl-trace counts (videos watched / candidates scored).
 *
 * Side effect: snapshots the job_proof of every running + recently-completed
 * task into agent_task_proof before reading, so the ephemeral watch-order is
 * captured continuously while this panel polls. Best-effort — never blocks the
 * list on xgodo.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  const page = parseInt(req.nextUrl.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '50'), 200);
  const keyword = req.nextUrl.searchParams.get('keyword') || '';
  const status = req.nextUrl.searchParams.get('status') || '';
  const offset = (page - 1) * limit;

  // Snapshot live proofs first (best-effort). Only worth doing on page 1 of an
  // unfiltered/most-recent view — that's where live tasks surface.
  if (page === 1 && !keyword) {
    try {
      const cfgRes = await pool.query('SELECT key, value FROM admin_config WHERE key = ANY($1)', [[
        'xgodo_niche_spy_token', 'xgodo_api_token',
      ]]);
      const cfg: Record<string, string> = {};
      for (const r of cfgRes.rows) cfg[r.key] = r.value;
      const token = cfg.xgodo_niche_spy_token || cfg.xgodo_api_token
        || process.env.XGODO_NICHE_SPY_TOKEN || process.env.XGODO_API_TOKEN || '';
      if (token) {
        // Niche-spy tasks are 'running' in xgodo until they finish, then drop
        // off the list — there is no 'completed' status. The job_proof
        // watch-path grows on the running task, so snapshotting 'running'
        // captures it. (The thermostat also snapshots every tick, so the path
        // is captured even when this panel isn't open.)
        const running = await fetchTasksByStatus(token, NICHE_SPY_JOB_ID, 'running', 100).catch(() => []);
        await snapshotTaskProofs(running);
      }
    } catch (err) {
      console.error('[agents/log] proof snapshot skipped:', (err as Error).message);
    }
  }

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
