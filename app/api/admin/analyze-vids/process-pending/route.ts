import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { runAnalysisJob } from '@/lib/video-analysis';

/**
 * POST /api/admin/analyze-vids/process-pending
 *
 * Worker dispatcher. Atomically claims N pending jobs via FOR UPDATE
 * SKIP LOCKED so concurrent calls don't double-fire, then kicks off
 * the worker for each fire-and-forget. The pipeline lib's own
 * GLOBAL_CLIP_CONCURRENCY semaphore keeps Gemini call concurrency
 * sane across all running jobs.
 *
 * Use cases:
 *   - Operator click: drain the queue manually after a paste-batch.
 *   - Cron tick: periodic pull-through so nothing rots in 'pending'.
 *
 * Body: { limit?: number } (default 5; max 50)
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { limit?: number };
  const limit = Math.max(1, Math.min(50, body.limit ?? 5));

  const pool = await getPool();
  // Atomically pick + flip to downloading. SKIP LOCKED means two
  // concurrent dispatchers split the queue cleanly without claiming
  // the same row twice.
  const r = await pool.query<{ id: number }>(
    `WITH claimed AS (
       SELECT id FROM video_analysis_jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE video_analysis_jobs j
        SET status = 'downloading', stage = 'downloading',
            started_at = COALESCE(j.started_at, NOW()),
            last_progress_at = NOW()
       FROM claimed
      WHERE j.id = claimed.id
     RETURNING j.id`,
    [limit],
  );
  const claimedIds = r.rows.map(row => row.id);

  for (const jobId of claimedIds) {
    void runAnalysisJob(jobId).catch(err => {
      console.error(`[analyze-vids] process-pending job ${jobId} threw:`, err);
    });
  }
  return NextResponse.json({ ok: true, claimed: claimedIds.length, jobIds: claimedIds });
}
