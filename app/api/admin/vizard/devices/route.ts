import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { listJobBuckets, type XgodoJobBucket } from '@/lib/xgodo-buckets';

// xgodo's YT-upload job. Same constant as lib/xgodo-vizard-upload.ts —
// duplicated here rather than re-exported so we don't drag the whole
// upload module (with its DB + cron side-effects) into a read-only route.
const YT_UPLOAD_JOB_ID = '699d6d10ab7a598307f47b1c';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface ClipRow {
  id: number;
  project_id: number;
  vizard_video_id: string | null;
  title: string | null;
  upload_title: string | null;
  duration_ms: string | null;
  viral_score: string | null;
  xgodo_upload_id: string | null;
  xgodo_job_task_id: string | null;
  xgodo_upload_status: string | null;
  xgodo_device_id: string | null;
  xgodo_device_name: string | null;
  xgodo_worker_id: string | null;
  xgodo_worker_name: string | null;
  xgodo_submitted_at: Date | null;
  xgodo_started_at: Date | null;
  xgodo_finished_at: Date | null;
  xgodo_failure_comment: string | null;
  xgodo_failure_screenshot_url: string | null;
  xgodo_error: string | null;
  youtube_url: string | null;
  youtube_view_count: string | null;
  youtube_like_count: string | null;
  youtube_comment_count: string | null;
  youtube_views_fetched_at: Date | null;
  project_url: string | null;
}

interface DeviceTask {
  clipId: number;
  projectId: number;
  projectUrl: string | null;
  title: string | null;
  status: string | null;
  plannedTaskId: string | null;
  jobTaskId: string | null;
  submittedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSec: number | null;
  failureComment: string | null;
  failureScreenshotUrl: string | null;
  error: string | null;
  youtubeUrl: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  viralScore: string | null;
}

interface DeviceStats {
  total: number;
  byStatus: {
    queued: number; running: number; uploaded: number;
    confirmed: number; failed: number; declined: number; other: number;
  };
  succeeded: number;       // uploaded + confirmed
  finalFailures: number;   // failed + declined
  successRate: number;     // 0..1, on rows that reached a terminal state
  avgDurationSec: number | null;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  lastActivityAt: string | null;
  last24h: { total: number; succeeded: number; failed: number };
}

interface DeviceRecord {
  deviceId: string;
  deviceName: string | null;
  workerId: string | null;
  workerName: string | null;
  stats: DeviceStats;
  bucket: {
    data: Record<string, unknown> | null;
    updatedAt: string | null;
    /** True when xgodo had no bucket for this device on the YT upload job. */
    missing: boolean;
  };
  /** Most recent N tasks (default 30), newest first. */
  recentTasks: DeviceTask[];
  /** Heuristic flag — if last 5 tasks were all failed/declined, surface it. */
  needsAttention: boolean;
  attentionReason: string | null;
}

function emptyByStatus(): DeviceStats['byStatus'] {
  return { queued: 0, running: 0, uploaded: 0, confirmed: 0, failed: 0, declined: 0, other: 0 };
}

function bumpStatus(by: DeviceStats['byStatus'], status: string | null) {
  if (!status) return;
  if (status in by) (by as unknown as Record<string, number>)[status]++;
  else by.other++;
}

/**
 * GET /api/admin/vizard/devices
 *
 * Reporting view grouping all xgodo YT-upload tasks by worker device.
 * For each device returns aggregate stats, the per-device job bucket
 * (login state, account info, etc. pulled from xgodo's new
 * GET /api/v2/bucket/:job_id endpoint), and the most recent N tasks.
 *
 * Optional query: ?limit=30 to control how many recent tasks per device
 *                  to return (default 30, max 200).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '30'), 5), 200);

  const pool = await getPool();

  // Pull every clip that ever reached a worker (device_id non-null). Rows
  // still in the planned-only state aren't device-attributable, so we
  // skip them — they show up under the "Uploads to YT" view's "queued"
  // bucket instead.
  const rowsRes = await pool.query<ClipRow>(
    `SELECT
       c.id, c.project_id, c.vizard_video_id, c.title, c.upload_title,
       c.duration_ms, c.viral_score,
       c.xgodo_upload_id, c.xgodo_job_task_id, c.xgodo_upload_status,
       c.xgodo_device_id, c.xgodo_device_name,
       c.xgodo_worker_id, c.xgodo_worker_name,
       c.xgodo_submitted_at, c.xgodo_started_at, c.xgodo_finished_at,
       c.xgodo_failure_comment, c.xgodo_failure_screenshot_url, c.xgodo_error,
       c.youtube_url,
       c.youtube_view_count, c.youtube_like_count, c.youtube_comment_count,
       c.youtube_views_fetched_at,
       p.video_url AS project_url
     FROM vizard_clips c
     JOIN vizard_projects p ON p.id = c.project_id
     WHERE c.xgodo_device_id IS NOT NULL
     ORDER BY c.xgodo_submitted_at DESC NULLS LAST, c.id DESC`
  );

  // Group by device_id. We aggregate stats over ALL tasks ever assigned to
  // the device but only return the most recent `limit` in `recentTasks` —
  // so the device card is light to render but the totals are honest.
  const byDevice = new Map<string, {
    deviceName: string | null;
    workerId: string | null;
    workerName: string | null;
    rows: ClipRow[];
  }>();

  for (const row of rowsRes.rows) {
    const did = row.xgodo_device_id!;
    let entry = byDevice.get(did);
    if (!entry) {
      entry = {
        deviceName: row.xgodo_device_name,
        workerId: row.xgodo_worker_id,
        workerName: row.xgodo_worker_name,
        rows: [],
      };
      byDevice.set(did, entry);
    }
    // First row per device is newest (we ordered by submitted_at DESC), so
    // worker info from that row is the freshest — keep it.
    entry.rows.push(row);
  }

  // Fetch xgodo job-level buckets in parallel with the rest of the work.
  // Failure here is non-fatal — we still render device cards without
  // bucket state if xgodo is unreachable or the token isn't set up for
  // bucket reads.
  let bucketsByDevice = new Map<string, XgodoJobBucket>();
  let bucketError: string | null = null;
  try {
    const tokenRes = await pool.query<{ value: string }>(
      `SELECT value FROM admin_config WHERE key = 'xgodo_api_token' LIMIT 1`
    );
    const token = tokenRes.rows[0]?.value?.trim();
    if (token) {
      const buckets = await listJobBuckets(token, YT_UPLOAD_JOB_ID);
      bucketsByDevice = new Map(buckets.map(b => [b.remote_device_id, b]));
    }
  } catch (err) {
    bucketError = err instanceof Error ? err.message : 'unknown';
  }

  // Even if a device has zero clips locally but xgodo holds a bucket for
  // it, we want to surface it — that's a worker that's onboarded into
  // the job (logged into YT, etc.) but hasn't been used yet. So merge in
  // bucket-only devices too.
  for (const [deviceId, bucket] of bucketsByDevice) {
    if (!byDevice.has(deviceId)) {
      byDevice.set(deviceId, {
        deviceName: bucket.device_name,
        workerId: null,
        workerName: null,
        rows: [],
      });
    }
  }

  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  const devices: DeviceRecord[] = [];

  for (const [deviceId, entry] of byDevice) {
    const stats: DeviceStats = {
      total: entry.rows.length,
      byStatus: emptyByStatus(),
      succeeded: 0,
      finalFailures: 0,
      successRate: 0,
      avgDurationSec: null,
      totalViews: 0,
      totalLikes: 0,
      totalComments: 0,
      lastActivityAt: null,
      last24h: { total: 0, succeeded: 0, failed: 0 },
    };

    let durationSum = 0;
    let durationCount = 0;
    let lastActivity = 0;

    for (const r of entry.rows) {
      bumpStatus(stats.byStatus, r.xgodo_upload_status);
      if (r.xgodo_upload_status === 'uploaded' || r.xgodo_upload_status === 'confirmed') stats.succeeded++;
      if (r.xgodo_upload_status === 'failed' || r.xgodo_upload_status === 'declined') stats.finalFailures++;

      if (r.youtube_view_count    != null) stats.totalViews    += parseInt(r.youtube_view_count)    || 0;
      if (r.youtube_like_count    != null) stats.totalLikes    += parseInt(r.youtube_like_count)    || 0;
      if (r.youtube_comment_count != null) stats.totalComments += parseInt(r.youtube_comment_count) || 0;

      if (r.xgodo_submitted_at && r.xgodo_finished_at) {
        const d = (r.xgodo_finished_at.getTime() - r.xgodo_submitted_at.getTime()) / 1000;
        if (d > 0 && d < 6 * 3600) { // ignore obvious clock-skew outliers > 6h
          durationSum += d; durationCount++;
        }
      }

      const activity = (r.xgodo_finished_at || r.xgodo_started_at || r.xgodo_submitted_at)?.getTime() ?? 0;
      if (activity > lastActivity) lastActivity = activity;

      if (r.xgodo_submitted_at && now - r.xgodo_submitted_at.getTime() < oneDayMs) {
        stats.last24h.total++;
        if (r.xgodo_upload_status === 'uploaded' || r.xgodo_upload_status === 'confirmed') stats.last24h.succeeded++;
        if (r.xgodo_upload_status === 'failed' || r.xgodo_upload_status === 'declined') stats.last24h.failed++;
      }
    }

    const terminal = stats.succeeded + stats.finalFailures;
    stats.successRate = terminal > 0 ? stats.succeeded / terminal : 0;
    stats.avgDurationSec = durationCount > 0 ? Math.round(durationSum / durationCount) : null;
    stats.lastActivityAt = lastActivity > 0 ? new Date(lastActivity).toISOString() : null;

    // Last-N recent tasks for the expandable list.
    const recentTasks: DeviceTask[] = entry.rows.slice(0, limit).map(r => {
      const dur = (r.xgodo_submitted_at && r.xgodo_finished_at)
        ? Math.round((r.xgodo_finished_at.getTime() - r.xgodo_submitted_at.getTime()) / 1000)
        : null;
      return {
        clipId:               r.id,
        projectId:            r.project_id,
        projectUrl:           r.project_url,
        title:                r.upload_title || r.title,
        status:               r.xgodo_upload_status,
        plannedTaskId:        r.xgodo_upload_id,
        jobTaskId:            r.xgodo_job_task_id,
        submittedAt:          r.xgodo_submitted_at?.toISOString() ?? null,
        startedAt:            r.xgodo_started_at?.toISOString()   ?? null,
        finishedAt:           r.xgodo_finished_at?.toISOString()  ?? null,
        durationSec:          dur,
        failureComment:       r.xgodo_failure_comment,
        failureScreenshotUrl: r.xgodo_failure_screenshot_url,
        error:                r.xgodo_error,
        youtubeUrl:           r.youtube_url,
        viewCount:            r.youtube_view_count    != null ? parseInt(r.youtube_view_count)    : null,
        likeCount:            r.youtube_like_count    != null ? parseInt(r.youtube_like_count)    : null,
        commentCount:         r.youtube_comment_count != null ? parseInt(r.youtube_comment_count) : null,
        viralScore:           r.viral_score,
      };
    });

    // Heuristic "needs attention" badge — surfaced on the card so the
    // operator can spot devices stuck in a bad loop without expanding
    // every one. Three independent triggers, evaluated in priority order
    // so the most actionable reason wins:
    //
    //   (1) most recent failure has an actionable worker comment
    //       (login / SMS / captcha / verif / sign-in / out_of_steps)
    //   (2) last 3+ COMPLETED tasks were all failed/declined — note
    //       we deliberately ignore queued/running rows here, otherwise
    //       a device that's currently retrying after a failure streak
    //       would silently lose its badge
    //   (3) persistently low success rate over a meaningful sample —
    //       catches the case where one stale success is masking an
    //       otherwise-broken device (e.g. 1/12 over the last few days)
    let needsAttention = false;
    let attentionReason: string | null = null;

    const isTerminal = (s: string | null) =>
      s === 'failed' || s === 'declined' || s === 'uploaded' || s === 'confirmed';
    const isFailure  = (s: string | null) => s === 'failed' || s === 'declined';

    const completedRows = entry.rows.filter(r => isTerminal(r.xgodo_upload_status));
    const lastFailedRow = entry.rows.find(r => isFailure(r.xgodo_upload_status));

    if (lastFailedRow?.xgodo_failure_comment &&
        /login|sms|captcha|verif|sign[\s-]?in|out[_\s-]?of[_\s-]?steps/i.test(lastFailedRow.xgodo_failure_comment)) {
      needsAttention = true;
      attentionReason = `worker reported: ${lastFailedRow.xgodo_failure_comment.slice(0, 80)}`;
    } else {
      const last5Completed = completedRows.slice(0, 5);
      if (last5Completed.length >= 3 && last5Completed.every(r => isFailure(r.xgodo_upload_status))) {
        needsAttention = true;
        attentionReason = `last ${last5Completed.length} completed tasks all failed`;
      } else if (terminal >= 5 && stats.successRate < 0.2) {
        needsAttention = true;
        attentionReason = `${stats.finalFailures}/${terminal} completed tasks failed (${Math.round(stats.successRate * 100)}% success)`;
      }
    }

    const bucket = bucketsByDevice.get(deviceId);
    devices.push({
      deviceId,
      deviceName: entry.deviceName ?? bucket?.device_name ?? null,
      workerId: entry.workerId,
      workerName: entry.workerName,
      stats,
      bucket: {
        data:      bucket?.data       ?? null,
        updatedAt: bucket?.updated_at ?? null,
        missing:   !bucket,
      },
      recentTasks,
      needsAttention,
      attentionReason,
    });
  }

  // Sort: needs-attention first, then by most recent activity.
  devices.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    const aA = a.stats.lastActivityAt ? new Date(a.stats.lastActivityAt).getTime() : 0;
    const bA = b.stats.lastActivityAt ? new Date(b.stats.lastActivityAt).getTime() : 0;
    return bA - aA;
  });

  // Top-line aggregates the UI can show in a header strip.
  const overall = {
    devices: devices.length,
    needsAttention: devices.filter(d => d.needsAttention).length,
    totalUploaded: devices.reduce((s, d) => s + d.stats.byStatus.uploaded + d.stats.byStatus.confirmed, 0),
    totalFailed:   devices.reduce((s, d) => s + d.stats.byStatus.failed   + d.stats.byStatus.declined,  0),
    totalViews:    devices.reduce((s, d) => s + d.stats.totalViews, 0),
  };

  return NextResponse.json({
    overall,
    bucketError,        // null when bucket fetch worked, error message otherwise
    devices,
  });
}
