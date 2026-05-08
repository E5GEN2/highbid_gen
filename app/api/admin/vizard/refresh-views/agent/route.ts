import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { refreshClipViewCounts } from '@/lib/yt-clip-views';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * Agent-driven Vizard "refresh all view counts" control surface. Same
 * shape as /api/admin/niche-tree/agent — designed for an automated
 * caller that wants to drive the refresh and poll until it's done
 * without holding a long-lived SSE connection.
 *
 *   GET    /api/admin/vizard/refresh-views/agent
 *     → compact status of the latest job
 *
 *   POST   /api/admin/vizard/refresh-views/agent
 *     body: { force?: boolean; staleMinutes?: number; threads?: number;
 *             clipIds?: number[]; cancelExisting?: boolean }
 *     → creates a new vizard_refresh_jobs row, fires the worker pool
 *       fire-and-forget, returns { ok, jobId }. If a job is already
 *       running and cancelExisting !== true, returns 409.
 *
 *   DELETE /api/admin/vizard/refresh-views/agent
 *     → marks the running job as cancelled. Workers stop between batches.
 *
 * Auth: Bearer hba_… token, x-admin-token header, or admin_token cookie.
 */

interface AgentStatus {
  jobId: number | null;
  status: string | null;        // 'running' | 'done' | 'error' | 'cancelled' | null
  threads: number;
  totalClips: number;
  totalBatches: number;
  completedBatches: number;
  updated: number;
  errors: number;
  calls: number;
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
    `SELECT * FROM vizard_refresh_jobs ORDER BY started_at DESC LIMIT 1`
  );
  if (r.rows.length === 0) {
    return {
      jobId: null, status: null, threads: 0,
      totalClips: 0, totalBatches: 0, completedBatches: 0,
      updated: 0, errors: 0, calls: 0,
      percentComplete: 0, etaSeconds: null,
      startedAt: null, completedAt: null, lastProgressAt: null,
      errorMessage: null,
    };
  }
  const row = r.rows[0];
  const totalBatches = row.total_batches || 0;
  const completedBatches = row.completed_batches || 0;
  let percent = totalBatches > 0 ? completedBatches / totalBatches : 0;
  if (row.status === 'done') percent = 1;
  if (row.status === 'cancelled' || row.status === 'error') percent = Math.min(percent, 0.999);

  // ETA from per-batch rate while running.
  let etaSeconds: number | null = null;
  if (row.status === 'running' && row.started_at && completedBatches > 0 && completedBatches < totalBatches) {
    const elapsed = (Date.now() - new Date(row.started_at).getTime()) / 1000;
    const remaining = totalBatches - completedBatches;
    const rate = completedBatches / elapsed;
    if (rate > 0) etaSeconds = Math.round(remaining / rate);
  }

  return {
    jobId: row.id,
    status: row.status,
    threads: row.threads,
    totalClips: row.total_clips,
    totalBatches,
    completedBatches,
    updated: row.updated,
    errors: row.errors,
    calls: row.calls,
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
    force?: boolean;
    staleMinutes?: number;
    threads?: number;
    clipIds?: number[];
    cancelExisting?: boolean;
  } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const inflight = await pool.query<{ id: number }>(
    `SELECT id FROM vizard_refresh_jobs WHERE status='running' ORDER BY started_at DESC LIMIT 1`
  );
  if (inflight.rows.length > 0) {
    if (body.cancelExisting) {
      await pool.query(
        `UPDATE vizard_refresh_jobs SET status='cancelled', completed_at=NOW() WHERE id=$1 AND status='running'`,
        [inflight.rows[0].id]
      );
    } else {
      return NextResponse.json(
        { error: 'A refresh job is already running; pass {cancelExisting: true} to cancel and restart',
          runningJobId: inflight.rows[0].id },
        { status: 409 }
      );
    }
  }

  const threads = Math.max(1, Math.min(30, body.threads ?? 10));
  const force = !!body.force;
  const staleMinutes = body.staleMinutes ?? 60;
  const clipIds = Array.isArray(body.clipIds) && body.clipIds.length > 0 ? body.clipIds : null;

  const job = await pool.query<{ id: number }>(
    `INSERT INTO vizard_refresh_jobs (status, threads, force, stale_minutes, clip_ids)
     VALUES ('running', $1, $2, $3, $4) RETURNING id`,
    [threads, force, staleMinutes, clipIds]
  );
  const jobId = job.rows[0].id;

  // Fire-and-forget. Wrap in a try/catch that flips the job row to
  // 'error' if the entire run blows up before any batch completes.
  refreshClipViewCounts({
    clipIds: clipIds ?? undefined,
    force,
    staleMinutes,
    threads,
    jobId,
  }).catch(async err => {
    console.error('[refresh-views-agent] job', jobId, 'failed:', err);
    try {
      await pool.query(
        `UPDATE vizard_refresh_jobs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2 AND status='running'`,
        [(err instanceof Error ? err.message : String(err)).slice(0, 500), jobId]
      );
    } catch { /* best effort */ }
  });

  return NextResponse.json({ ok: true, jobId, threads, force, staleMinutes, status: 'started' });
}

export async function DELETE(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  const inflight = await pool.query<{ id: number }>(
    `SELECT id FROM vizard_refresh_jobs WHERE status='running' ORDER BY started_at DESC LIMIT 1`
  );
  const jobId = inflight.rows[0]?.id;
  if (!jobId) return NextResponse.json({ error: 'No running refresh job to cancel' }, { status: 404 });

  await pool.query(
    `UPDATE vizard_refresh_jobs SET status='cancelled', completed_at=NOW() WHERE id=$1 AND status='running'`,
    [jobId]
  );
  return NextResponse.json({ ok: true, jobId, status: 'cancelled' });
}
