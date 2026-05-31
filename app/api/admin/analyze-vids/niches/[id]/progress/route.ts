import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/analyze-vids/niches/[id]/progress
 *
 * Per-niche rollup the admin tab uses to render the "X of N videos
 * analyzed, Y clips done, Z failed" header strip plus the per-video
 * grid (one row per niche video, joined with its latest non-cancelled
 * analysis job).
 *
 * Optional ?userEmail= scopes the latest-job picker to that user so
 * the same niche under different operators stays cleanly separated.
 *
 * Cheap: one CTE for the per-video latest job + one aggregate query.
 * 357 videos → ~20-50ms total.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const { id } = await ctx.params;
  const customNicheId = parseInt(id);
  if (!Number.isFinite(customNicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const userEmail = req.nextUrl.searchParams.get('userEmail');
  const pool = await getPool();

  // Resolve user_id from email if provided. Allows the panel to scope
  // "what's been analysed by sigadiga@" vs "what's been analysed by
  // anyone."
  let userId: string | null = null;
  if (userEmail) {
    const r = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [userEmail]);
    userId = r.rows[0]?.id ?? null;
    // Don't 404 — just return zero progress for an unknown email so the
    // UI shows a sane "0 of N analysed" instead of error noise.
  }

  // Niche header info.
  const nicheRes = await pool.query<{ name: string }>(
    `SELECT name FROM custom_niches WHERE id = $1`, [customNicheId],
  );
  if (nicheRes.rows.length === 0) return NextResponse.json({ error: 'niche not found' }, { status: 404 });

  // Per-video latest job (excluding cancelled) joined on the niche's
  // video membership. LEFT JOIN keeps videos with no job yet.
  const perVideoRes = await pool.query<{
    video_id: number;
    title: string | null;
    url: string;
    job_id: number | null;
    status: string | null;
    num_clips: number | null;
    num_clips_done: number | null;
    num_clips_failed: number | null;
    total_segments: number | null;
    duration_s: number | null;
    started_at: Date | null;
    completed_at: Date | null;
    error_message: string | null;
  }>(
    `WITH latest_job AS (
       SELECT DISTINCT ON (j.video_id)
              j.video_id, j.id AS job_id, j.status, j.num_clips, j.num_clips_done,
              j.num_clips_failed, j.total_segments,
              j.source_video_duration_s AS duration_s,
              j.started_at, j.completed_at, j.error_message
         FROM video_analysis_jobs j
        WHERE j.custom_niche_id = $1
          AND j.status <> 'cancelled'
          AND ($2::uuid IS NULL OR j.user_id = $2)
        ORDER BY j.video_id, j.created_at DESC
     )
     SELECT cnv.video_id, v.title, v.url,
            lj.job_id, lj.status,
            lj.num_clips, lj.num_clips_done, lj.num_clips_failed, lj.total_segments,
            lj.duration_s,
            lj.started_at, lj.completed_at, lj.error_message
       FROM custom_niche_videos cnv
       JOIN niche_spy_videos v ON v.id = cnv.video_id
       LEFT JOIN latest_job lj ON lj.video_id = cnv.video_id
      WHERE cnv.custom_niche_id = $1
      ORDER BY (lj.status IS NULL) ASC,        -- enqueued videos first
               (lj.num_clips_failed > 0) DESC, -- then ones with failed clips
               lj.completed_at DESC NULLS LAST,
               cnv.added_at DESC`,
    [customNicheId, userId],
  );

  // Niche-level rollup. Counts derived from the same per-video view
  // so the totals always tally.
  let totalVideos = 0;
  const statusCounts: Record<string, number> = {
    not_enqueued: 0,
    pending: 0,
    in_flight: 0,
    done: 0,
    error: 0,
  };
  let doneWithFailures = 0;
  let totalClipsAnalysed = 0;
  let totalClipsExpected = 0;
  let totalClipsFailed   = 0;
  let totalSegments      = 0;
  const perVideo = perVideoRes.rows.map(r => {
    totalVideos++;
    if (!r.status) {
      statusCounts.not_enqueued++;
    } else if (r.status === 'pending') {
      statusCounts.pending++;
    } else if (['downloading', 'splitting', 'analyzing', 'collapsing'].includes(r.status)) {
      statusCounts.in_flight++;
    } else if (r.status === 'done') {
      statusCounts.done++;
      if ((r.num_clips_failed ?? 0) > 0) doneWithFailures++;
    } else if (r.status === 'error') {
      statusCounts.error++;
    }
    if (r.num_clips_done != null) totalClipsAnalysed += r.num_clips_done;
    if (r.num_clips != null)      totalClipsExpected += r.num_clips;
    if (r.num_clips_failed != null) totalClipsFailed += r.num_clips_failed;
    if (r.total_segments != null) totalSegments += r.total_segments;
    return {
      videoId: r.video_id,
      title: r.title,
      url: r.url,
      jobId: r.job_id,
      status: r.status ?? 'not_enqueued',
      numClips: r.num_clips ?? null,
      numClipsDone: r.num_clips_done ?? null,
      numClipsFailed: r.num_clips_failed ?? null,
      totalSegments: r.total_segments ?? null,
      durationS: r.duration_s ?? null,
      startedAt: r.started_at?.toISOString() ?? null,
      completedAt: r.completed_at?.toISOString() ?? null,
      errorMessage: r.error_message,
    };
  });

  return NextResponse.json({
    ok: true,
    customNicheId,
    nicheName: nicheRes.rows[0].name,
    userEmail: userEmail || null,
    totalVideos,
    statusCounts,
    doneWithFailures,
    clips: {
      analysed: totalClipsAnalysed,
      expected: totalClipsExpected,
      failed: totalClipsFailed,
    },
    totalSegments,
    perVideo,
  });
}
