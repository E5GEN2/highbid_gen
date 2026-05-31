import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * POST /api/admin/analyze-vids/jobs/[id]/cancel
 *
 * Soft cancel: flips the job status to 'cancelled' so a still-running
 * worker stops persisting further progress. In-flight Gemini calls
 * will still complete (we don't kill child processes), but the job
 * won't transition to 'done' and the operator can retry it later.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const { id } = await ctx.params;
  const jobId = parseInt(id);
  if (!Number.isFinite(jobId)) return NextResponse.json({ error: 'invalid job id' }, { status: 400 });

  const pool = await getPool();
  const r = await pool.query<{ id: number; prev_status: string }>(
    `UPDATE video_analysis_jobs
        SET status = 'cancelled',
            completed_at = COALESCE(completed_at, NOW()),
            last_progress_at = NOW()
      WHERE id = $1
        AND status NOT IN ('done', 'cancelled')
      RETURNING id, (SELECT status FROM video_analysis_jobs WHERE id = $1) AS prev_status`,
    [jobId],
  );
  if (r.rows.length === 0) {
    return NextResponse.json({ ok: false, error: 'job not found or already terminal' }, { status: 409 });
  }
  return NextResponse.json({ ok: true, jobId });
}
