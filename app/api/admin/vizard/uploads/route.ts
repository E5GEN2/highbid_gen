import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { tickVizardUploads } from '@/lib/xgodo-vizard-upload';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET  /api/admin/vizard/uploads
 *   Returns the upload report — every Vizard clip that was sent to xgodo,
 *   joined with project + status/device/worker/timing details. Powers the
 *   "Uploads" view in the Vizard admin tab.
 *
 *   Optional query: ?status=queued|running|uploaded|confirmed|failed|declined
 *
 * POST /api/admin/vizard/uploads/tick
 *   Same handler — manual trigger for an immediate poll without waiting
 *   for the cron. Useful from the UI's "Refresh" button.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const status = req.nextUrl.searchParams.get('status');
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '200'), 500);

  const conditions: string[] = ['c.xgodo_upload_id IS NOT NULL'];
  const params: (string | number)[] = [];
  if (status) {
    conditions.push(`c.xgodo_upload_status = $${params.length + 1}`);
    params.push(status);
  }
  params.push(limit);

  const rows = await pool.query(
    `SELECT
       c.id, c.project_id, c.vizard_video_id,
       c.title AS clip_title,
       c.upload_title, c.upload_description,
       c.video_url AS source_video_url,
       c.duration_ms, c.viral_score,
       c.xgodo_upload_id, c.xgodo_job_task_id, c.xgodo_upload_status,
       c.xgodo_device_id, c.xgodo_device_name,
       c.xgodo_worker_id, c.xgodo_worker_name,
       c.xgodo_submitted_at, c.xgodo_started_at, c.xgodo_finished_at,
       c.xgodo_last_polled_at, c.xgodo_error,
       c.youtube_url,
       p.video_url AS project_url
     FROM vizard_clips c
     JOIN vizard_projects p ON p.id = c.project_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.xgodo_submitted_at DESC NULLS LAST
     LIMIT $${params.length}`,
    params
  );

  // Stats summary for the dashboard header
  const summary = await pool.query<{
    queued: string; running: string; uploaded: string;
    confirmed: string; failed: string; declined: string;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE xgodo_upload_status = 'queued')    AS queued,
      COUNT(*) FILTER (WHERE xgodo_upload_status = 'running')   AS running,
      COUNT(*) FILTER (WHERE xgodo_upload_status = 'uploaded')  AS uploaded,
      COUNT(*) FILTER (WHERE xgodo_upload_status = 'confirmed') AS confirmed,
      COUNT(*) FILTER (WHERE xgodo_upload_status = 'failed')    AS failed,
      COUNT(*) FILTER (WHERE xgodo_upload_status = 'declined')  AS declined
    FROM vizard_clips
    WHERE xgodo_upload_id IS NOT NULL
  `);
  const s = summary.rows[0];

  return NextResponse.json({
    summary: {
      queued:    parseInt(s.queued),
      running:   parseInt(s.running),
      uploaded:  parseInt(s.uploaded),
      confirmed: parseInt(s.confirmed),
      failed:    parseInt(s.failed),
      declined:  parseInt(s.declined),
    },
    uploads: rows.rows.map(r => ({
      clipId:            r.id,
      projectId:         r.project_id,
      vizardVideoId:     r.vizard_video_id,
      clipTitle:         r.clip_title,
      uploadTitle:       r.upload_title,
      uploadDescription: r.upload_description,
      sourceVideoUrl:    r.source_video_url,
      durationMs:        r.duration_ms !== null ? parseInt(r.duration_ms) : null,
      viralScore:        r.viral_score,
      plannedTaskId:     r.xgodo_upload_id,
      jobTaskId:         r.xgodo_job_task_id,
      status:            r.xgodo_upload_status,
      deviceId:          r.xgodo_device_id,
      deviceName:        r.xgodo_device_name,
      workerId:          r.xgodo_worker_id,
      workerName:        r.xgodo_worker_name,
      submittedAt:       r.xgodo_submitted_at,
      startedAt:         r.xgodo_started_at,
      finishedAt:        r.xgodo_finished_at,
      lastPolledAt:      r.xgodo_last_polled_at,
      error:             r.xgodo_error,
      youtubeUrl:        r.youtube_url,
      projectUrl:        r.project_url,
    })),
  });
}

/**
 * POST same path — manual tick. Lets the admin click "Refresh" on the
 * Uploads view and immediately re-poll all in-flight clips instead of
 * waiting up to 60s for the cron.
 */
export async function POST() {
  try {
    const result = await tickVizardUploads();
    return NextResponse.json({ ok: true, ...result, ranAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
