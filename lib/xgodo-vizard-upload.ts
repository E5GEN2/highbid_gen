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
         xgodo_last_polled_at = NULL, xgodo_error = NULL,
         xgodo_failure_comment = NULL, xgodo_failure_screenshot_url = NULL,
         youtube_url = NULL
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
/**
 * Result of polling one task by id. Three terminal cases:
 *   { status: 'queued' }   — exists, no worker assigned yet
 *   { status: 'found', task } — assigned, returns the task row
 *   { status: 'gone' }     — task_id no longer exists on xgodo (TTL'd or
 *                            manually deleted). Caller treats this as a
 *                            terminal failure so the row stops re-polling.
 */
type FetchTaskResult =
  | { status: 'queued' }
  | { status: 'found'; task: XgodoJobTask }
  | { status: 'gone'; reason: string };

interface ApplicantsResp {
  ok: boolean;
  status: number;        // HTTP status (always set)
  text: string;          // raw error body when !ok, '' when ok
  data: { job_tasks?: XgodoJobTask[] } | null;
}

async function postApplicants(body: Record<string, unknown>): Promise<ApplicantsResp> {
  const token = await getXgodoToken();
  const res = await fetch(`${XGODO_API}/jobs/applicants`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, text: (await res.text().catch(() => '')), data: null };
  }
  return { ok: true, status: res.status, text: '', data: await res.json() };
}

/**
 * Page through xgodo's job_tasks list looking for a job_task whose
 * planned_task_id matches. Used as a fallback when the direct
 * task_id=<planned_task_id> lookup 404s — which happens once a task
 * has FAILED on xgodo's side. Their server-side resolution of
 * planned_task_id → job_task_id only works for in-flight tasks.
 *
 * We only scan recent pages of failed/declined tasks (newest first), so
 * this stays fast: typically the planned task we're looking for failed
 * within the last ~30 minutes and lives on page 1.
 */
async function scanForJobTaskId(plannedTaskId: string, options?: { maxPages?: number }): Promise<XgodoJobTask | null> {
  const maxPages = options?.maxPages ?? 4;
  for (const status of ['failed', 'declined']) {
    for (let page = 1; page <= maxPages; page++) {
      const r = await postApplicants({
        job_id: YT_UPLOAD_JOB_ID, status, limit: 50, page,
      });
      if (!r.ok) break;
      const tasks = r.data?.job_tasks || [];
      if (tasks.length === 0) break;
      const hit = tasks.find(t => t.planned_task_id === plannedTaskId);
      if (hit) return hit;
      if (tasks.length < 50) break;
    }
  }
  return null;
}

/**
 * Look up the current state of one planned task. Strategy:
 *   1. If we already know its job_task_id (stored from a prior poll),
 *      query directly by that — works in every status including failed.
 *   2. Else try task_id=<planned_task_id>. Works while pending/running.
 *   3. On 400 "no associated job task" → still queued, return.
 *   4. On 404 "neither a valid…" → task has likely failed and xgodo's
 *      planned→job_task resolver no longer covers it. Scan the failed
 *      list once to recover the job_task_id, then return that task.
 */
async function fetchTaskById(plannedTaskId: string, knownJobTaskId?: string | null): Promise<FetchTaskResult> {
  const lookupId = knownJobTaskId || plannedTaskId;
  const r = await postApplicants({ job_id: YT_UPLOAD_JOB_ID, task_id: lookupId });

  // Narrow with `!r.ok` first so TS sees the false branch first; otherwise
  // it doesn't propagate the discriminated-union narrowing past the
  // truthy-block return.
  if (!r.ok) {
    // 400 "no associated job task" → planned task exists, just no worker
    // picked it up yet. Keep polling.
    if (r.status === 400 && /no associated job task|job_task_id is null/i.test(r.text)) {
      return { status: 'queued' };
    }
    // 404 "neither valid…" — only happens for planned_task_id when the
    // task has failed. Recover the job_task_id by scanning the failed
    // list, then use it for the real lookup.
    if (r.status === 404 && /neither a valid|not found/i.test(r.text) && !knownJobTaskId) {
      const recovered = await scanForJobTaskId(plannedTaskId);
      if (recovered) return { status: 'found', task: recovered };
      return {
        status: 'gone',
        reason: 'xgodo no longer recognises this task id and it isn\'t in the recent failed list. Click Retry to resubmit.',
      };
    }
    throw new Error(`xgodo poll ${r.status}: ${r.text.slice(0, 200)}`);
  }

  const task = (r.data?.job_tasks || [])[0];
  if (!task) return { status: 'queued' };
  return { status: 'found', task };
}

interface XgodoJobTask {
  _id: string;
  status: string;            // 'pending' | 'running' | 'confirmed' | 'failed' | 'declined' | 'notcomplete'
  job_proof: string | Record<string, unknown> | null;
  proof_input: string | null;
  failureReason: string | null;
  comment: string | null;    // worker-attached note on failed tasks (e.g. "CRASH")
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
  // In-flight rows poll on a fast cadence (>30s gate). We ALSO opportunistically
  // re-poll failed/declined rows whose worker comment hasn't been captured
  // yet — happens for rows that hit the 404-on-planned-id path before we
  // added the failed-list scan fallback. Cap to once an hour so we don't
  // hammer xgodo for stale data.
  const dueRes = await pool.query<{
    id: number; xgodo_upload_id: string; xgodo_job_task_id: string | null; xgodo_upload_status: string;
  }>(
    `SELECT id, xgodo_upload_id, xgodo_job_task_id, xgodo_upload_status
     FROM vizard_clips
     WHERE xgodo_upload_id IS NOT NULL
       AND (
         (xgodo_upload_status IN ('queued','running','uploaded')
          AND (xgodo_last_polled_at IS NULL OR xgodo_last_polled_at < NOW() - INTERVAL '30 seconds'))
         OR
         (xgodo_upload_status IN ('failed','declined')
          AND xgodo_failure_comment IS NULL
          AND (xgodo_last_polled_at IS NULL OR xgodo_last_polled_at < NOW() - INTERVAL '1 hour'))
       )
     ORDER BY xgodo_submitted_at ASC NULLS LAST
     LIMIT 50`
  );

  let polled = 0, updated = 0, errors = 0;

  for (const row of dueRes.rows) {
    polled++;
    try {
      const r = await fetchTaskById(row.xgodo_upload_id, row.xgodo_job_task_id);

      if (r.status === 'queued') {
        // Still in xgodo's queue, no worker assignment yet.
        await pool.query(
          `UPDATE vizard_clips SET xgodo_last_polled_at = NOW() WHERE id = $1`,
          [row.id]
        );
        continue;
      }
      if (r.status === 'gone') {
        // Terminal failure: xgodo dropped the planned task before any worker
        // picked it up. Mark failed with a human-readable reason. The row
        // stays out of the in-flight set on subsequent ticks (status='failed'
        // isn't in the WHERE filter), so we stop polling automatically.
        await pool.query(
          `UPDATE vizard_clips SET
             xgodo_upload_status = 'failed',
             xgodo_last_polled_at = NOW(),
             xgodo_finished_at = COALESCE(xgodo_finished_at, NOW()),
             xgodo_error = $1
           WHERE id = $2`,
          [r.reason, row.id]
        );
        if (row.xgodo_upload_status !== 'failed') updated++;
        continue;
      }

      const task = r.task;
      const newStatus = mapXgodoStatus(task.status);
      const proof = parseJobProof(task.job_proof);
      const ytUrl = typeof proof.video_url === 'string' ? proof.video_url : null;
      // Worker-side failure detail. xgodo's `comment` ("CRASH",
      // "Login required", etc.) is the human-readable reason and lives
      // alongside an optional `failureScreenshot` URL inside job_proof.
      // Both are wiped on retry (see submitClipToXgodo) so they stay
      // accurate for the latest run only.
      const failureComment =
        task.comment
        || (typeof proof.comments === 'string' ? proof.comments : null)
        || null;
      const failureScreenshot =
        typeof proof.failureScreenshot === 'string' ? proof.failureScreenshot : null;

      await pool.query(
        `UPDATE vizard_clips SET
           xgodo_upload_status         = $1,
           xgodo_job_task_id           = $2,
           xgodo_device_id             = COALESCE($3, xgodo_device_id),
           xgodo_device_name           = COALESCE($4, xgodo_device_name),
           xgodo_worker_id             = COALESCE($5, xgodo_worker_id),
           xgodo_worker_name           = COALESCE($6, xgodo_worker_name),
           xgodo_started_at            = COALESCE(xgodo_started_at, $7),
           xgodo_finished_at           = COALESCE(xgodo_finished_at, $8),
           xgodo_last_polled_at        = NOW(),
           xgodo_error                 = $9,
           xgodo_failure_comment       = $10,
           xgodo_failure_screenshot_url = $11,
           youtube_url                 = COALESCE(youtube_url, $12)
         WHERE id = $13`,
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
          failureComment,
          failureScreenshot,
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
