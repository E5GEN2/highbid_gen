import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { runAnalysisJob } from '@/lib/video-analysis';

/**
 * POST /api/admin/analyze-vids/retry-failed
 *
 * Bulk recovery for every job in scope that has at least one `error`
 * clip. Resets ALL such clips back to `pending`, flips the parent job
 * back to `pending` if it was `done`-with-partial-failure or `error`,
 * and fires runAnalysisJob on each. The pipeline lib's per-job logic
 * skips already-`done` clips so we never re-pay for successful work.
 *
 * Scope is filter-shaped so the admin tab's "Retry all failed in this
 * niche" button maps cleanly:
 *   { customNicheId?, jobIds?, since?, userEmail? }
 * Combining filters narrows the scope (AND). At least one must be set
 * to keep this from accidentally re-running the entire history.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

interface Body {
  customNicheId?: number;
  jobIds?: number[];
  since?: string;
  userEmail?: string;
  // Cap on how many jobs to actually fire workers for in one request —
  // beyond this we still flip them to pending so a future Drain or
  // cron tick will pick them up.
  concurrentStarts?: number;
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as Body;
  const concurrentStarts = Math.max(1, Math.min(20, body.concurrentStarts ?? 5));

  if (!body.customNicheId && !body.jobIds?.length && !body.since && !body.userEmail) {
    return NextResponse.json(
      { error: 'specify at least one of: customNicheId, jobIds, since, userEmail' },
      { status: 400 },
    );
  }

  const pool = await getPool();
  const conds: string[] = [`j.num_clips_failed > 0`];
  const args: unknown[] = [];
  let p = 1;
  if (body.customNicheId) { conds.push(`j.custom_niche_id = $${p++}`); args.push(body.customNicheId); }
  if (body.jobIds?.length) { conds.push(`j.id = ANY($${p++}::int[])`); args.push(body.jobIds); }
  if (body.since) { conds.push(`j.created_at > $${p++}`); args.push(body.since); }
  if (body.userEmail) {
    conds.push(`j.user_id = (SELECT id FROM users WHERE email = $${p++})`);
    args.push(body.userEmail);
  }
  const where = `WHERE ${conds.join(' AND ')}`;

  // Find target jobs. We only touch jobs that actually have failed
  // clips — otherwise this would needlessly restart already-clean jobs.
  const jobRes = await pool.query<{ id: number; status: string }>(
    `SELECT id, status FROM video_analysis_jobs j ${where} ORDER BY id`,
    args,
  );
  const jobIds = jobRes.rows.map(r => r.id);
  if (jobIds.length === 0) {
    return NextResponse.json({ ok: true, jobsReset: 0, clipsReset: 0, started: 0, note: 'no jobs with failed clips in scope' });
  }

  // Reset error clips → pending for these jobs.
  const clipRes = await pool.query<{ id: number }>(
    `UPDATE video_analysis_clips
        SET status='pending', attempts='[]'::jsonb, attempt_count=0,
            error_category=NULL, error_detail=NULL, raw_debug_text=NULL,
            elapsed_s=NULL, started_at=NULL, completed_at=NULL
      WHERE job_id = ANY($1::int[]) AND status = 'error'
      RETURNING id`,
    [jobIds],
  );

  // Reset parent jobs: failed counter, error_message, terminal status.
  // num_clips_done stays — those segments are still valid; the
  // pipeline picks up where it left off and rewrites the timeline on
  // collapse.
  //
  // Also resets auto_retry_count to 0. Rationale: a manual bulk retry
  // is the operator saying "the prior cap was spent on broken-pipeline
  // failures; give these jobs a fresh runway." Without this, jobs that
  // hit the cap during a bad deploy stay permanently abandoned by the
  // watchdog even after we ship a fix.
  await pool.query(
    `UPDATE video_analysis_jobs
        SET status='pending', stage='pending',
            error_message=NULL, error_category=NULL,
            num_clips_failed=0,
            auto_retry_count=0,
            completed_at=NULL,
            last_progress_at=NOW()
      WHERE id = ANY($1::int[])`,
    [jobIds],
  );

  // Fire the first N workers. The rest sit in pending until Drain
  // queue / cron / another POST picks them up.
  const startNow = jobIds.slice(0, concurrentStarts);
  for (const jobId of startNow) {
    void runAnalysisJob(jobId).catch(err => {
      console.error(`[analyze-vids] retry-failed job ${jobId} threw:`, err);
    });
  }

  return NextResponse.json({
    ok: true,
    jobsReset: jobIds.length,
    clipsReset: clipRes.rowCount ?? 0,
    started: startNow.length,
    jobIds,
  });
}
