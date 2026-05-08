import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { runOutlierEnrich } from '@/lib/outlier-enrich';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * Agent-driven Outlier Pipeline channel enrichment. Fire-and-forget +
 * pollable status, same shape as the niche-tree and refresh-views
 * agent endpoints.
 *
 *   GET    /api/admin/outliers/enrich-channels/agent
 *     → compact status of the latest job
 *
 *   POST   /api/admin/outliers/enrich-channels/agent
 *     body: { limit?, threads?, maxVideos?, staleDays?, force?, cancelExisting? }
 *     → creates outlier_enrich_jobs row, fires worker, returns { ok, jobId }.
 *       409 if a job is already running and cancelExisting !== true.
 *
 *   DELETE /api/admin/outliers/enrich-channels/agent
 *     → marks the running job as cancelled; workers stop after their
 *       in-flight channel.
 *
 * Auth: Bearer hba_… token / x-admin-token / admin_token cookie.
 */

interface AgentStatus {
  jobId: number | null;
  status: string | null;
  threads: number;
  maxVideos: number;
  staleDays: number;
  force: boolean;
  targetChannels: number;
  processed: number;
  withStats: number;
  errors: number;
  apiCalls: number;
  percentComplete: number;
  etaSeconds: number | null;
  startedAt: string | null;
  completedAt: string | null;
  lastProgressAt: string | null;
  errorMessage: string | null;
}

async function buildStatus(): Promise<AgentStatus> {
  const pool = await getPool();
  const r = await pool.query(
    `SELECT * FROM outlier_enrich_jobs ORDER BY started_at DESC LIMIT 1`
  );
  if (r.rows.length === 0) {
    return {
      jobId: null, status: null, threads: 0, maxVideos: 0, staleDays: 0, force: false,
      targetChannels: 0, processed: 0, withStats: 0, errors: 0, apiCalls: 0,
      percentComplete: 0, etaSeconds: null,
      startedAt: null, completedAt: null, lastProgressAt: null,
      errorMessage: null,
    };
  }
  const row = r.rows[0];
  const total = row.target_channels || 0;
  const processed = row.processed || 0;
  let percent = total > 0 ? processed / total : 0;
  if (row.status === 'done') percent = 1;
  if (row.status === 'cancelled' || row.status === 'error') percent = Math.min(percent, 0.999);

  let etaSeconds: number | null = null;
  if (row.status === 'running' && row.started_at && processed > 0 && processed < total) {
    const elapsed = (Date.now() - new Date(row.started_at).getTime()) / 1000;
    const rate = processed / elapsed;
    if (rate > 0) etaSeconds = Math.round((total - processed) / rate);
  }

  return {
    jobId: row.id,
    status: row.status,
    threads: row.threads,
    maxVideos: row.max_videos,
    staleDays: row.stale_days,
    force: row.force,
    targetChannels: total,
    processed,
    withStats: row.with_stats,
    errors: row.errors,
    apiCalls: row.api_calls,
    percentComplete: Math.round(percent * 1000) / 10,
    etaSeconds,
    startedAt: row.started_at?.toISOString?.() ?? null,
    completedAt: row.completed_at?.toISOString?.() ?? null,
    lastProgressAt: row.last_progress_at?.toISOString?.() ?? null,
    errorMessage: row.error_message ?? null,
  };
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  return NextResponse.json(await buildStatus());
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  let body: {
    limit?: number; threads?: number; maxVideos?: number; staleDays?: number;
    force?: boolean; cancelExisting?: boolean;
  } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const inflight = await pool.query<{ id: number }>(
    `SELECT id FROM outlier_enrich_jobs WHERE status='running' ORDER BY started_at DESC LIMIT 1`
  );
  if (inflight.rows.length > 0) {
    if (body.cancelExisting) {
      await pool.query(
        `UPDATE outlier_enrich_jobs SET status='cancelled', completed_at=NOW() WHERE id=$1 AND status='running'`,
        [inflight.rows[0].id]
      );
    } else {
      return NextResponse.json(
        { error: 'An enrichment job is already running; pass {cancelExisting: true} to cancel and restart',
          runningJobId: inflight.rows[0].id },
        { status: 409 }
      );
    }
  }

  const threads    = Math.max(1, Math.min(30, body.threads ?? 10));
  const limit      = Math.max(1, Math.min(5000, body.limit ?? 200));
  const maxVideos  = Math.max(5, Math.min(50, body.maxVideos ?? 30));
  const staleDays  = Math.max(0, body.staleDays ?? 7);
  const force      = !!body.force;

  const job = await pool.query<{ id: number }>(
    `INSERT INTO outlier_enrich_jobs (status, threads, max_videos, stale_days, force)
     VALUES ('running', $1, $2, $3, $4) RETURNING id`,
    [threads, maxVideos, staleDays, force]
  );
  const jobId = job.rows[0].id;

  // Fire-and-forget. Errors not handled by the worker bubble up here
  // so the row gets flipped to 'error' instead of being stuck on
  // 'running' forever.
  runOutlierEnrich({ limit, threads, maxVideos, staleDays, force, jobId }).catch(async err => {
    console.error('[outlier-enrich-agent] job', jobId, 'failed:', err);
    try {
      await pool.query(
        `UPDATE outlier_enrich_jobs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2 AND status='running'`,
        [(err instanceof Error ? err.message : String(err)).slice(0, 500), jobId]
      );
    } catch { /* best effort */ }
  });

  return NextResponse.json({ ok: true, jobId, threads, limit, maxVideos, staleDays, force, status: 'started' });
}

export async function DELETE(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  const inflight = await pool.query<{ id: number }>(
    `SELECT id FROM outlier_enrich_jobs WHERE status='running' ORDER BY started_at DESC LIMIT 1`
  );
  const jobId = inflight.rows[0]?.id;
  if (!jobId) return NextResponse.json({ error: 'No running enrichment job to cancel' }, { status: 404 });

  await pool.query(
    `UPDATE outlier_enrich_jobs SET status='cancelled', completed_at=NOW() WHERE id=$1 AND status='running'`,
    [jobId]
  );
  return NextResponse.json({ ok: true, jobId, status: 'cancelled' });
}
