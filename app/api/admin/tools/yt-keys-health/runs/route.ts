import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/tools/yt-keys-health/runs
 *
 * Recent sweep history — last N rows from xgodo_key_health_runs.
 * Lets me see trends across sweeps without trawling individual
 * runIds: working-rate over time, when the pool was last cleaned,
 * which sweeps errored.
 *
 * Query params:
 *   limit?:  number    default 20, max 100
 *   status?: 'running' | 'done' | 'error'   filter on run status
 *   service?: 'youtube_data' | 'google_ai_studio'   defaults to all
 *
 * Auth: admin Bearer token.
 *
 * Returns rows in started_at DESC order — newest first.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const limit = Math.max(1, Math.min(parseInt(sp.get('limit') || '20'), 100));
  const status = sp.get('status');
  const service = sp.get('service');

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (service) {
    params.push(service);
    where.push(`service = $${params.length}`);
  }
  params.push(limit);
  const limitPlaceholder = `$${params.length}`;

  const sql = `
    SELECT id, service, mode, status,
           started_at, completed_at,
           target_limit, concurrency, dry_run,
           probed, sample_summary, db_updates, proxy_top_failures, error_message,
           CASE
             WHEN completed_at IS NOT NULL THEN
               EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
             ELSE
               EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
           END::bigint AS elapsed_ms
      FROM xgodo_key_health_runs
      ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY started_at DESC
      LIMIT ${limitPlaceholder}
  `;

  const pool = await getPool();
  const r = await pool.query(sql, params);

  return NextResponse.json({
    ok: true,
    total: r.rows.length,
    runs: r.rows.map(row => ({
      id: row.id,
      service: row.service,
      mode: row.mode,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      targetLimit: row.target_limit,
      concurrency: row.concurrency,
      dryRun: row.dry_run,
      probed: row.probed,
      elapsedMs: Number(row.elapsed_ms),
      sampleSummary: row.sample_summary,
      dbUpdates: row.db_updates,
      proxyTopFailures: row.proxy_top_failures,
      errorMessage: row.error_message,
      // Convenience: a working-rate that the dashboards can render
      // as a single percentage. Computed here so the consumer
      // doesn't have to know the bucket names.
      workingRate: (() => {
        const s = row.sample_summary as Record<string, number> | null;
        if (!s || !row.probed) return null;
        const w = (s.working ?? 0);
        return Math.round((w / row.probed) * 1000) / 10; // one decimal %
      })(),
    })),
  });
}
