/**
 * xgodo YT-upload pipeline helpers.
 *
 * Submit Vizard clips to xgodo's YT-upload job, then poll one task at a
 * time by id (POST /jobs/applicants { task_id }) instead of scanning the
 * whole queue. Each in-flight clip = one xgodo call per cron tick.
 *
 * State machine on vizard_clips.xgodo_upload_status:
 *   null        — not queued
 *   queued      — planned task submitted, no worker assigned yet
 *                 (job_task_id still null on xgodo side)
 *   running     — worker assigned, upload in progress
 *   uploaded    — worker reported success with a YT URL.
 *                 xgodo's task status here is "pending" (= awaiting employer
 *                 review). For US this is the success state — the video is
 *                 LIVE on YouTube already, just hasn't been confirmed for
 *                 payout yet.
 *   confirmed   — employer reviewed and accepted (paid out)
 *   failed      — worker reported failure
 *   declined    — employer rejected
 */

import { getPool } from './db';

const XGODO_API = 'https://xgodo.com/api/v2';
const YT_UPLOAD_JOB_ID = '699d6d10ab7a598307f47b1c';

export interface VizardClipUploadInput {
  clipId: number;          // vizard_clips.id
  videoUrl: string;        // Vizard CDN signed mp4 (7-day expiry)
  title: string;           // exact Vizard-generated title used as YT title
  description: string;     // free-form, defaults to '' if not provided
}

async function getXgodoToken(): Promise<string> {
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'xgodo_api_token' LIMIT 1`
  );
  const token = r.rows[0]?.value?.trim();
  if (!token) throw new Error('xgodo_api_token not configured in admin_config');
  return token;
}

/**
 * Submit one Vizard clip to xgodo as a planned task. Stores the
 * planned_task_id + chosen title/description on vizard_clips.
 *
 * Idempotent on the planned-task side via a simple guard: if the clip
 * already has a non-null xgodo_upload_id we skip and return the existing
 * one.
 */
export async function submitClipToXgodo(input: VizardClipUploadInput): Promise<{
  ok: true; plannedTaskId: string; alreadyQueued: boolean;
} | {
  ok: false; error: string;
}> {
  const pool = await getPool();
  const existing = await pool.query<{ xgodo_upload_id: string | null; xgodo_upload_status: string | null }>(
    `SELECT xgodo_upload_id, xgodo_upload_status FROM vizard_clips WHERE id = $1`,
    [input.clipId]
  );
  if (existing.rows.length === 0) return { ok: false, error: 'clip not found' };
  const row = existing.rows[0];
  // Idempotency: if a planned_task is still in flight (queued/running/uploaded/
  // confirmed), don't re-submit. But if the previous attempt is in a terminal
  // failure state (failed/declined), CLEAR everything and submit fresh — this
  // is what the "Retry" button needs. Without this, retry was a no-op
  // because xgodo_upload_id was non-null and we returned alreadyQueued.
  const inFlight = row.xgodo_upload_id && row.xgodo_upload_status &&
    !['failed', 'declined'].includes(row.xgodo_upload_status);
  if (inFlight) {
    return { ok: true, plannedTaskId: row.xgodo_upload_id!, alreadyQueued: true };
  }
  if (row.xgodo_upload_id) {
    // Wipe stale failed-attempt state so reporting shows the new run cleanly,
    // not a frankenstein mix of old worker/device + new task.
    await pool.query(
      `UPDATE vizard_clips SET
         xgodo_upload_id = NULL, xgodo_upload_status = NULL,
         xgodo_job_task_id = NULL, xgodo_device_id = NULL, xgodo_device_name = NULL,
         xgodo_worker_id = NULL, xgodo_worker_name = NULL,
         xgodo_submitted_at = NULL, xgodo_started_at = NULL, xgodo_finished_at = NULL,
         xgodo_last_polled_at = NULL, xgodo_error = NULL, youtube_url = NULL
       WHERE id = $1`,
      [input.clipId]
    );
  }

  const token = await getXgodoToken();
  // The automation ONLY reads { video_url, title, description }. Anything
  // else (tags, category, privacy) is silently dropped — the form in
  // xgodo's dashboard ("Add Planned Tasks") confirmed this is the schema.
  const taskInput = {
    video_url:   input.videoUrl,
    title:       input.title,
    description: input.description || '',
  };

  const res = await fetch(`${XGODO_API}/planned_tasks/submit`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: YT_UPLOAD_JOB_ID,
      inputs: [JSON.stringify(taskInput)],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `xgodo submit failed: ${res.status} ${text.slice(0, 200)}` };
  }

  const data = await res.json() as {
    success?: boolean;
    inserted_ids?: Array<{ planned_task_id: string; input: string }>;
  };
  const plannedTaskId = data.inserted_ids?.[0]?.planned_task_id;
  if (!plannedTaskId) {
    return { ok: false, error: `xgodo response missing planned_task_id: ${JSON.stringify(data).slice(0, 200)}` };
  }

  await pool.query(
    `UPDATE vizard_clips SET
       xgodo_upload_id     = $1,
       xgodo_upload_status = 'queued',
       xgodo_submitted_at  = NOW(),
       upload_title        = $2,
       upload_description  = $3,
       xgodo_error         = NULL
     WHERE id = $4`,
    [plannedTaskId, input.title, input.description || '', input.clipId]
  );

  return { ok: true, plannedTaskId, alreadyQueued: false };
}

/**
 * Poll xgodo for ONE specific task by its planned_task_id. xgodo resolves
 * planned_task_id → job_task_id server-side, so we always pass the
 * planned_task_id we stored on submit.
 *
 * Per docs (POST /jobs/applicants):
 *   task_id (string, optional) — accepts either job_task_id or planned_task_id.
 *   If present, the task result list array will contain only one task or
 *   empty array if task not found.
 *
 * "Not found" means the planned task hasn't been assigned to a worker yet
 * (job_task_id is still null) — we leave status='queued' and wait.
 */
async function fetchTaskById(plannedTaskId: string): Promise<XgodoJobTask | null> {
  const token = await getXgodoToken();
  const res = await fetch(`${XGODO_API}/jobs/applicants`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: YT_UPLOAD_JOB_ID, task_id: plannedTaskId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // xgodo returns 400 with this specific message when the planned task
    // exists but no worker has picked it up yet (job_task_id is null).
    // That's not an error from our side — it's the "still queued" case —
    // so swallow it and tell the caller "no task yet".
    if (res.status === 400 && /no associated job task|job_task_id is null/i.test(text)) {
      return null;
    }
    throw new Error(`xgodo poll ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json() as { job_tasks?: XgodoJobTask[] };
  const tasks = data.job_tasks || [];
  return tasks[0] || null;
}

interface XgodoJobTask {
  _id: string;
  status: string;            // 'pending' | 'running' | 'confirmed' | 'failed' | 'declined' | 'notcomplete'
  job_proof: string | Record<string, unknown> | null;
  proof_input: string | null;
  failureReason: string | null;
  device_id: string | null;
  device_name: string | null;
  worker_id: string | null;
  worker_name: string | null;
  added: string | null;       // assignment timestamp
  finished: string | null;    // worker submission timestamp
  planned_task_id: string;
}

function parseJobProof(jp: XgodoJobTask['job_proof']): Record<string, unknown> {
  if (!jp) return {};
  if (typeof jp === 'object') return jp;
  try { return JSON.parse(jp); } catch { return { raw: jp }; }
}

/**
 * Map xgodo task status → our internal vizard_clips.xgodo_upload_status.
 *   running     → 'running'
 *   pending     → 'uploaded'  (worker submitted; awaiting employer review)
 *   confirmed   → 'confirmed'
 *   failed      → 'failed'
 *   declined    → 'declined'
 *   notcomplete → 'running'   (still in progress per xgodo)
 */
function mapXgodoStatus(s: string): string {
  switch (s) {
    case 'pending':     return 'uploaded';
    case 'confirmed':   return 'confirmed';
    case 'running':     return 'running';
    case 'notcomplete': return 'running';
    case 'failed':      return 'failed';
    case 'declined':    return 'declined';
    default:            return 'running';   // safe default — keep polling
  }
}

/**
 * Tick: poll every clip currently in-flight and update its row.
 *
 * "In-flight" = status in (queued, running, uploaded). We keep polling
 * 'uploaded' so we capture the eventual transition to 'confirmed' (when
 * the employer accepts) without needing a separate reconciler.
 *
 * Per-clip rate limit: skip clips polled within the last 30s (matches
 * xgodo's recommended polling cadence and avoids thrashing if the cron
 * fires more often than expected).
 */
export async function tickVizardUploads(): Promise<{
  polled: number; updated: number; errors: number;
}> {
  const pool = await getPool();
  const dueRes = await pool.query<{
    id: number; xgodo_upload_id: string; xgodo_upload_status: string;
  }>(
    `SELECT id, xgodo_upload_id, xgodo_upload_status
     FROM vizard_clips
     WHERE xgodo_upload_id IS NOT NULL
       AND xgodo_upload_status IN ('queued','running','uploaded')
       AND (xgodo_last_polled_at IS NULL OR xgodo_last_polled_at < NOW() - INTERVAL '30 seconds')
     ORDER BY xgodo_submitted_at ASC NULLS LAST
     LIMIT 50`
  );

  let polled = 0, updated = 0, errors = 0;

  for (const row of dueRes.rows) {
    polled++;
    try {
      const task = await fetchTaskById(row.xgodo_upload_id);

      if (!task) {
        // Still queued, no worker assignment yet — just bump last_polled_at.
        await pool.query(
          `UPDATE vizard_clips SET xgodo_last_polled_at = NOW() WHERE id = $1`,
          [row.id]
        );
        continue;
      }

      const newStatus = mapXgodoStatus(task.status);
      const proof = parseJobProof(task.job_proof);
      const ytUrl = typeof proof.video_url === 'string' ? proof.video_url : null;

      await pool.query(
        `UPDATE vizard_clips SET
           xgodo_upload_status   = $1,
           xgodo_job_task_id     = $2,
           xgodo_device_id       = COALESCE($3, xgodo_device_id),
           xgodo_device_name     = COALESCE($4, xgodo_device_name),
           xgodo_worker_id       = COALESCE($5, xgodo_worker_id),
           xgodo_worker_name     = COALESCE($6, xgodo_worker_name),
           xgodo_started_at      = COALESCE(xgodo_started_at, $7),
           xgodo_finished_at     = COALESCE(xgodo_finished_at, $8),
           xgodo_last_polled_at  = NOW(),
           xgodo_error           = $9,
           youtube_url           = COALESCE(youtube_url, $10)
         WHERE id = $11`,
        [
          newStatus,
          task._id,
          task.device_id,
          task.device_name,
          task.worker_id,
          task.worker_name,
          task.added,
          task.finished,
          task.failureReason,
          ytUrl,
          row.id,
        ]
      );
      if (newStatus !== row.xgodo_upload_status) updated++;
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : 'unknown';
      await pool.query(
        `UPDATE vizard_clips SET xgodo_last_polled_at = NOW(), xgodo_error = $1 WHERE id = $2`,
        [msg, row.id]
      );
    }
  }

  return { polled, updated, errors };
}
