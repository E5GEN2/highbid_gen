import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { runAnalysisJob } from '@/lib/video-analysis';

/**
 * POST /api/admin/analyze-vids/jobs/[id]/retry
 *
 * Two modes:
 *   - job in 'error' state → flip to 'pending', clear error_message,
 *     fire the worker (will rerun from whatever stage left a residue).
 *   - job in 'done' state with N>0 failed clips → reset those clips to
 *     'pending' so the worker re-analyses only the bad ones; the
 *     collapse step re-runs and rewrites the timeline.
 *
 * Cheap retry button: respects already-done clips so we don't re-pay
 * for successful work.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const { id } = await ctx.params;
  const jobId = parseInt(id);
  if (!Number.isFinite(jobId)) return NextResponse.json({ error: 'invalid job id' }, { status: 400 });

  const pool = await getPool();
  const r = await pool.query<{ status: string; num_clips_failed: number }>(
    `SELECT status, num_clips_failed FROM video_analysis_jobs WHERE id = $1`,
    [jobId],
  );
  if (r.rows.length === 0) return NextResponse.json({ error: 'job not found' }, { status: 404 });
  const cur = r.rows[0];

  if (cur.status === 'pending' || cur.status === 'downloading' || cur.status === 'splitting' ||
      cur.status === 'analyzing' || cur.status === 'collapsing') {
    return NextResponse.json({ ok: false, error: `job is already in flight (status=${cur.status})` }, { status: 409 });
  }

  // Reset failed clips back to pending. Even when the job was 'done',
  // any leftover error clips get another go.
  await pool.query(
    `UPDATE video_analysis_clips
        SET status='pending', attempts='[]'::jsonb, attempt_count=0,
            error_category=NULL, error_detail=NULL, raw_debug_text=NULL,
            elapsed_s=NULL, started_at=NULL, completed_at=NULL
      WHERE job_id = $1 AND status = 'error'`,
    [jobId],
  );
  // Reset job counters; runAnalysisJob recomputes as clips complete.
  // Also resets auto_retry_count = 0. Rationale: manual retry is the
  // operator saying "give this job a fresh shot." Without this, jobs
  // that hit the watchdog cap during turbulence stay at the cap and
  // the watchdog ignores them after one more failure — meaning a
  // single manual click only buys one attempt. With the reset, manual
  // retry gives the watchdog a fresh 20-retry budget to grind out any
  // residual flakiness without further operator input.
  await pool.query(
    `UPDATE video_analysis_jobs
        SET status='pending', stage='pending', error_message=NULL, error_category=NULL,
            num_clips_failed = 0,
            auto_retry_count = 0,
            completed_at = NULL,
            last_progress_at = NOW()
      WHERE id = $1`,
    [jobId],
  );

  void runAnalysisJob(jobId).catch(err => {
    console.error(`[analyze-vids] retry job ${jobId} threw:`, err);
  });

  return NextResponse.json({ ok: true, jobId, status: 'pending' });
}
