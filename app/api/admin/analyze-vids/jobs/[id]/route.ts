import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/analyze-vids/jobs/[id]
 *
 * Per-job detail for the admin drill-in. Returns the job row plus all
 * its clips with attempt history. Used by the admin tab when the
 * operator clicks a row.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const { id } = await ctx.params;
  const jobId = parseInt(id);
  if (!Number.isFinite(jobId)) return NextResponse.json({ error: 'invalid job id' }, { status: 400 });

  const pool = await getPool();
  const jr = await pool.query<{
    id: number; video_id: number | null; custom_niche_id: number | null;
    user_id: string | null; youtube_url: string;
    source_video_title: string | null; source_video_duration_s: number | null;
    source_mp4_path: string | null; clips_dir: string | null;
    num_clips: number; num_clips_done: number; num_clips_failed: number;
    clip_durations: number[] | null;
    total_segments: number | null;
    status: string; stage: string | null;
    error_message: string | null; error_category: string | null;
    started_at: Date | null; completed_at: Date | null;
    last_progress_at: Date | null; created_at: Date;
    user_email: string | null; niche_name: string | null;
  }>(
    `SELECT j.*,
            u.email AS user_email,
            cn.name AS niche_name
       FROM video_analysis_jobs j
       LEFT JOIN users u ON u.id = j.user_id
       LEFT JOIN custom_niches cn ON cn.id = j.custom_niche_id
      WHERE j.id = $1`,
    [jobId],
  );
  if (jr.rows.length === 0) return NextResponse.json({ error: 'job not found' }, { status: 404 });
  const j = jr.rows[0];

  const cr = await pool.query<{
    id: number; clip_index: number; clip_path: string | null;
    duration_s: number | null; size_bytes: string | null;
    status: string;
    attempts: Array<{ n: number; elapsed_s: number; category: string; http_status: number | null; detail: string | null }>;
    attempt_count: number;
    segments_count: number | null;
    error_category: string | null; error_detail: string | null;
    has_raw_debug: boolean;
    elapsed_s: number | null;
    started_at: Date | null; completed_at: Date | null;
  }>(
    `SELECT id, clip_index, clip_path, duration_s, size_bytes::text AS size_bytes,
            status, attempts, attempt_count, segments_count,
            error_category, error_detail,
            (raw_debug_text IS NOT NULL) AS has_raw_debug,
            elapsed_s, started_at, completed_at
       FROM video_analysis_clips
      WHERE job_id = $1
      ORDER BY clip_index`,
    [jobId],
  );

  return NextResponse.json({
    ok: true,
    job: {
      id: j.id,
      videoId: j.video_id,
      customNicheId: j.custom_niche_id,
      nicheName: j.niche_name,
      userId: j.user_id,
      userEmail: j.user_email,
      youtubeUrl: j.youtube_url,
      title: j.source_video_title,
      durationS: j.source_video_duration_s,
      sourceMp4Path: j.source_mp4_path,
      clipsDir: j.clips_dir,
      numClips: j.num_clips,
      numClipsDone: j.num_clips_done,
      numClipsFailed: j.num_clips_failed,
      clipDurations: j.clip_durations,
      totalSegments: j.total_segments,
      status: j.status,
      stage: j.stage,
      errorMessage: j.error_message,
      errorCategory: j.error_category,
      startedAt: j.started_at?.toISOString() ?? null,
      completedAt: j.completed_at?.toISOString() ?? null,
      lastProgressAt: j.last_progress_at?.toISOString() ?? null,
      createdAt: j.created_at.toISOString(),
    },
    clips: cr.rows.map(c => ({
      id: c.id,
      clipIndex: c.clip_index,
      clipPath: c.clip_path,
      durationS: c.duration_s,
      sizeBytes: c.size_bytes ? parseInt(c.size_bytes) : null,
      status: c.status,
      attempts: c.attempts,
      attemptCount: c.attempt_count,
      segmentsCount: c.segments_count,
      errorCategory: c.error_category,
      errorDetail: c.error_detail,
      hasRawDebug: c.has_raw_debug,
      elapsedS: c.elapsed_s,
      startedAt: c.started_at?.toISOString() ?? null,
      completedAt: c.completed_at?.toISOString() ?? null,
    })),
  });
}
