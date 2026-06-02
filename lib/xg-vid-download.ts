/**
 * XG vid download pipeline.
 *
 * Bridges two xgodo jobs into one operator-supervised loop:
 *
 *   1. REVIEW_JOB_ID  (default 6a02e4e48c276d3bba917d54) — workers post
 *      tasks with job_proof = { videoUrl, remote_device_id, ... } that
 *      sit in status 'pending' awaiting our review.
 *   2. We POST those videoUrls into DOWNLOAD_JOB_ID (default
 *      6a12c740d914a97f7c2bd0db) as planned_tasks; a worker clicks the
 *      labs.google download button and uploads the mp4 to
 *      xgodo.com/server/temp/. Worker returns job_proof with prompt /
 *      model / uploadedUrl.
 *   3. We fetch the mp4 from uploadedUrl to the Railway volume, sanity
 *      check the bytes, then mark BOTH the original review task AND
 *      the download task 'confirmed' on xgodo.
 *
 * Wire-call patterns are copied verbatim from xgodo-vizard-upload.ts +
 * ai-studio-key-import.ts (planned_tasks/submit + jobs/applicants + PUT
 * status update) so we hit the same well-trodden paths.
 */

import { getPool } from './db';
import { XG_VIDEOS_DIR } from './xg-videos-dir';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';

const XGODO_API = 'https://xgodo.com/api/v2';

/** Defaults from the operator's spec. Overridable per call so a future
 *  job rotation doesn't require redeploying just to bump an id. */
export const DEFAULT_REVIEW_JOB_ID   = '6a02e4e48c276d3bba917d54';
export const DEFAULT_DOWNLOAD_JOB_ID = '6a12c740d914a97f7c2bd0db';

/** Same key chain xgodo-vizard-upload uses, plus a dedicated key first
 *  so the operator can scope a separate token to this pipeline if they
 *  want to. Falls back through to the env var for local boots before
 *  admin_config has been touched. */
async function getXgodoToken(): Promise<string> {
  const pool = await getPool();
  for (const k of [
    'xgodo_xg_vid_download_token',
    'xgodo_niche_spy_token',
    'xgodo_api_token',
    'xgodo_admin_token',
  ]) {
    const r = await pool.query<{ value: string }>(
      "SELECT value FROM admin_config WHERE key = $1",
      [k],
    );
    if (r.rows[0]?.value) return r.rows[0].value.trim();
  }
  return process.env.XGODO_API_TOKEN || '';
}

// ─── xgodo task shape ───────────────────────────────────────────────
export interface XgodoTask {
  _id: string;
  status: string;
  job_proof: string | Record<string, unknown> | null;
  proof_input: string | null;
  comment: string | null;
  device_id: string | null;
  device_name: string | null;
  worker_id: string | null;
  worker_name: string | null;
  added: string | null;
  finished: string | null;
  planned_task_id?: string;
}

function parseJobProof(jp: XgodoTask['job_proof']): Record<string, unknown> {
  if (!jp) return {};
  if (typeof jp === 'object') return jp;
  try { return JSON.parse(jp); } catch { return { raw: jp }; }
}

/** Pull the first labs.google video URL we can find anywhere in a task's
 *  job_proof. Walks objects/arrays recursively because workers don't all
 *  format the proof identically — some post `videoUrl`, some
 *  `video_url`, some embed the URL inside a longer free-text comment. */
function extractVideoUrl(task: XgodoTask): string | null {
  const proof = parseJobProof(task.job_proof);
  const re = /https:\/\/labs\.google\/fx\/tools\/flow\/shared\/video\/[a-z0-9-]+/i;
  function scan(v: unknown): string | null {
    if (!v) return null;
    if (typeof v === 'string') { const m = v.match(re); return m ? m[0] : null; }
    if (Array.isArray(v)) { for (const x of v) { const h = scan(x); if (h) return h; } return null; }
    if (typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) {
        const h = scan(x); if (h) return h;
      }
      return null;
    }
    return null;
  }
  return scan(proof) || scan(task.proof_input) || scan(task.comment);
}

/** Look for `remote_device_id` (or a couple of aliases) in the proof. */
function extractRemoteDeviceId(task: XgodoTask): string | null {
  const proof = parseJobProof(task.job_proof);
  for (const k of ['remote_device_id', 'remoteDeviceId', 'device_id']) {
    const v = proof[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// ─── xgodo wire calls ───────────────────────────────────────────────

/** Fetch up to `limit` tasks in 'pending' (awaiting employer review)
 *  state for the review job. */
export async function fetchPendingReviewTasks(
  limit: number,
  jobId: string = DEFAULT_REVIEW_JOB_ID,
): Promise<XgodoTask[]> {
  const token = await getXgodoToken();
  const res = await fetch(`${XGODO_API}/jobs/applicants`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, status: 'pending', limit }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`xgodo fetch pending ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json() as { job_tasks?: XgodoTask[] };
  return data.job_tasks || [];
}

/** Submit a planned download task with the labs.google videoUrl as
 *  input. Worker reads inputs[0] and operates on it. */
export async function submitDownloadTask(
  videoUrl: string,
  jobId: string = DEFAULT_DOWNLOAD_JOB_ID,
): Promise<{ ok: true; plannedTaskId: string } | { ok: false; error: string }> {
  const token = await getXgodoToken();
  // The download job's worker expects { url: ... } as its job variable
  // (xgodo rejects { video_url: ... } here with "jobVariables.url is
  // required"). Different schema from the vizard YT-upload job which
  // takes { video_url, title, description } — the schema is per-job on
  // xgodo, not per-account. Live-tested against a 10-task probe.
  const taskInput = { url: videoUrl };
  const res = await fetch(`${XGODO_API}/planned_tasks/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, inputs: [JSON.stringify(taskInput)] }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, error: `submit ${res.status}: ${txt.slice(0, 200)}` };
  }
  const data = await res.json() as { inserted_ids?: Array<{ planned_task_id: string }> };
  const plannedTaskId = data.inserted_ids?.[0]?.planned_task_id;
  if (!plannedTaskId) return { ok: false, error: 'submit returned no planned_task_id' };
  return { ok: true, plannedTaskId };
}

/** Poll one planned task by id. Resolves to:
 *    'queued'  — exists, no worker yet
 *    'found'   — assigned, returns the task row
 *    'gone'    — xgodo no longer knows about it (TTL'd / failed)
 */
export type PollResult =
  | { status: 'queued' }
  | { status: 'found'; task: XgodoTask }
  | { status: 'gone'; reason: string };

export async function pollDownloadTask(
  plannedTaskId: string,
  jobId: string = DEFAULT_DOWNLOAD_JOB_ID,
): Promise<PollResult> {
  const token = await getXgodoToken();
  const res = await fetch(`${XGODO_API}/jobs/applicants`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, task_id: plannedTaskId }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    // Two well-known soft-fails the wire pattern from xgodo-vizard-upload
    // showed: 400 with "no associated job task" = still queued; 404 with
    // "neither a valid" = task has likely failed and the planned→task
    // resolver gave up. We treat the latter as terminal.
    if (res.status === 400 && /no associated job task|job_task_id is null/i.test(txt)) {
      return { status: 'queued' };
    }
    if (res.status === 404 && /neither a valid|not found/i.test(txt)) {
      return { status: 'gone', reason: 'xgodo no longer recognises this task id' };
    }
    throw new Error(`xgodo poll ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json() as { job_tasks?: XgodoTask[] };
  const task = data.job_tasks?.[0];
  if (!task) return { status: 'queued' };
  return { status: 'found', task };
}

/** PUT /jobs/applicants — mark one or more task ids 'confirmed' (xgodo's
 *  operator-satisfied verdict) or 'declined'. Same call shape as
 *  ai-studio-key-import.reviewTasks. */
export async function markTask(
  jobId: string,
  taskIds: string[],
  status: 'confirmed' | 'declined',
  comment: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (taskIds.length === 0) return { ok: true, status: 200 };
  const token = await getXgodoToken();
  const res = await fetch(`${XGODO_API}/jobs/applicants`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      JobTasks_Ids: taskIds,
      status,
      job_id: jobId,
      comment: comment.slice(0, 250),
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: txt.slice(0, 200) };
  }
  return { ok: true, status: 200 };
}

// ─── file download ──────────────────────────────────────────────────

/** Stream a remote URL to a temp path on the Railway volume, atomically
 *  rename when the bytes are committed. Throws on 0-byte downloads so
 *  the orchestrator can mark the row failed instead of confirming a
 *  ghost file.
 *
 *  Returns the absolute final path + the size on disk. */
export async function downloadToVolume(
  url: string,
  filename: string,
): Promise<{ path: string; bytes: number }> {
  await fs.mkdir(XG_VIDEOS_DIR, { recursive: true });
  const finalPath = path.join(XG_VIDEOS_DIR, filename);
  const tmpPath   = `${finalPath}.partial`;
  // Always start from a clean temp file — a previous failed run could
  // have left bytes behind that an append would compound.
  await fs.rm(tmpPath, { force: true });

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download ${res.status} ${res.statusText}`.trim());
  }
  // ReadableStream<Uint8Array> from undici → node writable.
  await pipeline(
    res.body as unknown as NodeJS.ReadableStream,
    createWriteStream(tmpPath),
  );
  const stat = await fs.stat(tmpPath);
  if (stat.size === 0) {
    await fs.rm(tmpPath, { force: true });
    throw new Error('downloaded 0 bytes');
  }
  await fs.rename(tmpPath, finalPath);
  return { path: finalPath, bytes: stat.size };
}

// ─── DB row helpers ─────────────────────────────────────────────────

export interface XgVidDownloadRow {
  id: number;
  reviewTaskId: string;
  reviewJobId: string;
  reviewWorkerName: string | null;
  sourceVideoUrl: string;
  remoteDeviceId: string | null;
  downloadTaskId: string | null;
  downloadJobId: string | null;
  prompt: string | null;
  model: string | null;
  uploadedUrl: string | null;
  localPath: string | null;
  fileBytes: number | null;
  status: string;
  errorMessage: string | null;
  attempts: number;
  resubmissions: number;
  createdAt: string;
  submittedAt: string | null;
  lastPolledAt: string | null;
  downloadedAt: string | null;
  confirmedAt: string | null;
}

interface RawRow {
  id: number;
  review_task_id: string;
  review_job_id: string;
  review_worker_name: string | null;
  source_video_url: string;
  remote_device_id: string | null;
  download_task_id: string | null;
  download_job_id: string | null;
  prompt: string | null;
  model: string | null;
  uploaded_url: string | null;
  local_path: string | null;
  file_bytes: string | number | null;
  status: string;
  error_message: string | null;
  attempts: number;
  resubmissions: number;
  created_at: Date;
  submitted_at: Date | null;
  last_polled_at: Date | null;
  downloaded_at: Date | null;
  confirmed_at: Date | null;
}

function mapRow(r: RawRow): XgVidDownloadRow {
  return {
    id: r.id,
    reviewTaskId: r.review_task_id,
    reviewJobId: r.review_job_id,
    reviewWorkerName: r.review_worker_name,
    sourceVideoUrl: r.source_video_url,
    remoteDeviceId: r.remote_device_id,
    downloadTaskId: r.download_task_id,
    downloadJobId: r.download_job_id,
    prompt: r.prompt,
    model: r.model,
    uploadedUrl: r.uploaded_url,
    localPath: r.local_path,
    fileBytes: r.file_bytes == null ? null : Number(r.file_bytes),
    status: r.status,
    errorMessage: r.error_message,
    attempts: r.attempts,
    resubmissions: r.resubmissions ?? 0,
    createdAt: r.created_at.toISOString(),
    submittedAt:  r.submitted_at?.toISOString() ?? null,
    lastPolledAt: r.last_polled_at?.toISOString() ?? null,
    downloadedAt: r.downloaded_at?.toISOString() ?? null,
    confirmedAt:  r.confirmed_at?.toISOString() ?? null,
  };
}

/** Insert review tasks we haven't seen before. Existing rows
 *  (review_task_id unique) are left alone — the operator can re-process
 *  them via the row-level Retry action without us silently resetting
 *  state from the cron path. */
export async function enqueueReviewTasks(tasks: XgodoTask[]): Promise<{
  inserted: number;
  skipped: number;
  rows: XgVidDownloadRow[];
}> {
  const pool = await getPool();
  const inserted: XgVidDownloadRow[] = [];
  let skipped = 0;

  for (const t of tasks) {
    const url = extractVideoUrl(t);
    if (!url) { skipped++; continue; }
    const deviceId = extractRemoteDeviceId(t);
    const ins = await pool.query<RawRow>(
      `INSERT INTO xg_video_downloads
         (review_task_id, review_job_id, review_worker_name,
          source_video_url, remote_device_id,
          download_job_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued')
       ON CONFLICT (review_task_id) DO NOTHING
       RETURNING *`,
      [
        t._id,
        DEFAULT_REVIEW_JOB_ID,
        t.worker_name,
        url,
        deviceId,
        DEFAULT_DOWNLOAD_JOB_ID,
      ],
    );
    if (ins.rows[0]) inserted.push(mapRow(ins.rows[0]));
    else skipped++;
  }
  return { inserted: inserted.length, skipped, rows: inserted };
}

/**
 * Hard ceiling on retries-per-minute behaviour. Past this, the cron
 * leaves the row alone for the next backoff window (TRANSIENT_BACKOFF_MIN)
 * before re-attempting. Set high (200) — the throttle is what keeps us
 * polite to xgodo, not this cap.
 */
const MAX_ATTEMPTS_HARD_CEILING = 200;

/**
 * Minimum gap between successive retries of a failed-but-transient row.
 * Within an active outage we want to retry every cron tick; once we've
 * burned past the in-window threshold (the row's age exceeds this) we
 * back off to one retry per this many minutes — forever — so a multi-
 * hour xgodo MongoDB outage eventually heals on its own.
 */
const TRANSIENT_BACKOFF_MIN = 30;

/**
 * Resubmission cap. When the xgodo task itself is dead (worker timed
 * out, declined, xgodo /server/temp URL expired with 404), we clear
 * the dead download_task_id and submit a FRESH download task with a
 * new worker. After this many fresh tries we give up — at that point
 * the labs.google source URL is probably itself dead.
 */
const MAX_RESUBMISSIONS = 3;

/**
 * Patterns that mean "xgodo (or the network) was temporarily flaky,
 * try again next tick". Anything not matching is treated as terminal
 * (bad task data, schema mismatch, missing worker proof, etc.).
 *
 * Kept conservative: only obvious transient signatures so we don't
 * silently mask real bugs by retrying them forever.
 */
const TRANSIENT_RE = /(Connection pool|pool was cleared|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|timeout|xgodo (poll|submit) 5\d\d|download 5\d\d|HTTP\/[\d.]+ 5\d\d)/i;

/**
 * Patterns that mean "the current xgodo task is dead, but submitting a
 * fresh download task could still get us the mp4". Worker-side failures:
 * timeout, device unhealthy, xgodo's /server/temp URL aged out, the
 * worker explicitly declined the task.
 */
const RESUBMITTABLE_RE = /(Time limit exceeded|Device uptime|download 4\d\d|download 3\d\d|task declined|xgodo declined|worker declined)/i;

export function isTransientError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return TRANSIENT_RE.test(msg);
}

export function isResubmittableError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return RESUBMITTABLE_RE.test(msg);
}

/** Atomically claim up to N in-flight rows. Used by both the manual
 *  Drain button and the cron tick — SKIP LOCKED makes parallel callers
 *  partition the queue between themselves cleanly.
 *
 *  Self-healing claim policy:
 *    - In-flight rows (queued/submitted/running/downloaded): claim
 *      every tick.
 *    - Failed rows with TRANSIENT_RE error: claim if last_polled_at is
 *      older than TRANSIENT_BACKOFF_MIN (default 30min). No hard
 *      attempts cap until MAX_ATTEMPTS_HARD_CEILING — a multi-hour
 *      xgodo outage eventually heals on its own.
 *    - Failed rows with RESUBMITTABLE_RE error: claim if
 *      resubmissions < MAX_RESUBMISSIONS AND last_polled_at older than
 *      backoff. processOneRow will then submit a FRESH xgodo task.
 *    - Truly terminal failures (auth, schema, malformed proof): never
 *      re-claimed. */
async function claimRows(limit: number): Promise<XgVidDownloadRow[]> {
  const pool = await getPool();
  const r = await pool.query<RawRow>(
    `WITH claimed AS (
       SELECT id FROM xg_video_downloads
        WHERE status IN ('queued', 'submitted', 'running', 'downloaded')
           OR (status = 'failed'
               AND attempts < $2
               AND (last_polled_at IS NULL
                    OR last_polled_at < NOW() - ($3 || ' minutes')::interval)
               AND (error_message ~* $4
                    OR (error_message ~* $5 AND resubmissions < $6)))
        ORDER BY id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE xg_video_downloads x
        SET attempts = attempts + 1, updated_at = NOW()
       FROM claimed
      WHERE x.id = claimed.id
      RETURNING x.*`,
    [
      limit,
      MAX_ATTEMPTS_HARD_CEILING,
      String(TRANSIENT_BACKOFF_MIN),
      TRANSIENT_RE.source,
      RESUBMITTABLE_RE.source,
      MAX_RESUBMISSIONS,
    ],
  );
  // Restore the right re-entry status for each re-claimed failed row
  // before processOneRow sees it:
  //   - Resubmittable failure → 'queued' AND clear download_task_id /
  //     uploaded_url / local_path / file_bytes so the orchestrator
  //     submits a fresh xgodo task.
  //   - Transient failure with download_task_id → 'submitted' (just
  //     re-poll the existing task).
  //   - Transient failure pre-submit → 'queued' (re-attempt submit).
  for (const raw of r.rows) {
    if (raw.status !== 'failed') continue;
    if (isResubmittableError(raw.error_message)) {
      await pool.query(
        `UPDATE xg_video_downloads
            SET status = 'queued',
                download_task_id = NULL,
                uploaded_url = NULL,
                local_path = NULL,
                file_bytes = NULL,
                resubmissions = resubmissions + 1
          WHERE id = $1`,
        [raw.id],
      );
      raw.status = 'queued';
      raw.download_task_id = null;
      raw.uploaded_url = null;
      raw.local_path = null;
      raw.file_bytes = null;
      raw.resubmissions = (raw.resubmissions ?? 0) + 1;
    } else {
      const reEntry = raw.download_task_id ? 'submitted' : 'queued';
      await pool.query(
        `UPDATE xg_video_downloads SET status = $1 WHERE id = $2`,
        [reEntry, raw.id],
      );
      raw.status = reEntry;
    }
  }
  return r.rows.map(mapRow);
}

async function updateRow(id: number, patch: Record<string, unknown>): Promise<void> {
  const pool = await getPool();
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => patch[k]);
  values.push(id);
  await pool.query(
    `UPDATE xg_video_downloads SET ${sets}, updated_at = NOW() WHERE id = $${values.length}`,
    values,
  );
}

// ─── orchestrator ───────────────────────────────────────────────────

/**
 * Self-healing failure recording. If the error matches a known
 * transient pattern AND the row hasn't already burned through
 * MAX_TRANSIENT_RETRIES, we KEEP the row in its working state
 * (`keepStatus`) and just stamp the latest error_message — the next
 * cron tick will re-claim and retry.
 *
 * Otherwise (terminal error, or we've given up after N tries) the row
 * goes to `failed` and stops being claimed. Operator can manually
 * reset if they want.
 */
async function recordFailure(opts: {
  rowId: number;
  attempts: number;
  errorMsg: string;
  keepStatus: 'queued' | 'submitted' | 'running' | 'downloaded';
}): Promise<{ finalStatus: string; note: string }> {
  const msg = (opts.errorMsg || 'unknown').slice(0, 500);
  // Always keep transient failures on the retry path. The claim query's
  // backoff (TRANSIENT_BACKOFF_MIN once status flips to 'failed') is
  // what keeps us polite to xgodo — not a hard attempts cap, which
  // stranded rows when xgodo outages ran longer than 8 minutes.
  const transient = isTransientError(msg);
  if (transient) {
    await updateRow(opts.rowId, {
      status: opts.keepStatus,
      error_message: msg,
      last_polled_at: new Date(),
    });
    return { finalStatus: opts.keepStatus, note: `transient retry: ${msg.slice(0, 100)}` };
  }
  await updateRow(opts.rowId, { status: 'failed', error_message: msg, last_polled_at: new Date() });
  return { finalStatus: 'failed', note: msg };
}

/**
 * Worker-side terminal failure recovery. xgodo's worker timed out, our
 * download 404'd because xgodo's /server/temp URL aged out, or xgodo's
 * worker explicitly declined — the CURRENT xgodo task is dead, but we
 * can submit a FRESH download task and likely get a different worker
 * to succeed.
 *
 * Clears the dead download_task_id + uploaded_url + local_path +
 * file_bytes so the orchestrator's step 1 (submit) gets re-entered on
 * the next tick. Increments resubmissions; once we've hit the cap
 * (MAX_RESUBMISSIONS), the labs.google source is probably itself dead
 * and we mark truly failed.
 */
async function recordResubmittableFailure(opts: {
  rowId: number;
  resubmissions: number;
  errorMsg: string;
}): Promise<{ finalStatus: string; note: string }> {
  const msg = (opts.errorMsg || 'unknown').slice(0, 500);
  if (opts.resubmissions >= MAX_RESUBMISSIONS) {
    await updateRow(opts.rowId, {
      status: 'failed',
      error_message: `gave up after ${opts.resubmissions} resubmissions; last: ${msg}`,
      last_polled_at: new Date(),
    });
    return {
      finalStatus: 'failed',
      note: `exhausted ${MAX_RESUBMISSIONS} resubmissions: ${msg.slice(0, 80)}`,
    };
  }
  await updateRow(opts.rowId, {
    status: 'queued',
    download_task_id: null,
    uploaded_url: null,
    local_path: null,
    file_bytes: null,
    resubmissions: opts.resubmissions + 1,
    error_message: `resubmitting (#${opts.resubmissions + 1}/${MAX_RESUBMISSIONS}): ${msg.slice(0, 200)}`,
    last_polled_at: new Date(),
  });
  return {
    finalStatus: 'queued',
    note: `resubmitting (#${opts.resubmissions + 1}/${MAX_RESUBMISSIONS}) after: ${msg.slice(0, 80)}`,
  };
}

/** Move one row forward by exactly one xgodo round-trip + at most one
 *  download. Returns the post-step status so the caller knows whether
 *  to drop it (terminal) or hold for next tick. */
export async function processOneRow(row: XgVidDownloadRow): Promise<{
  id: number; finalStatus: string; note?: string;
}> {
  try {
    // 1. Queued → submit a download task to xgodo.
    if (row.status === 'queued') {
      const r = await submitDownloadTask(row.sourceVideoUrl);
      if (r.ok === false) {
        const fail = await recordFailure({
          rowId: row.id, attempts: row.attempts, errorMsg: `submit: ${r.error}`,
          keepStatus: 'queued',
        });
        return { id: row.id, ...fail };
      }
      await updateRow(row.id, {
        status: 'submitted',
        download_task_id: r.plannedTaskId,
        submitted_at: new Date(),
        error_message: null,
      });
      return { id: row.id, finalStatus: 'submitted' };
    }

    // 2. Submitted / running → poll for completion.
    if ((row.status === 'submitted' || row.status === 'running') && row.downloadTaskId) {
      const poll = await pollDownloadTask(row.downloadTaskId);
      if (poll.status === 'queued') {
        await updateRow(row.id, { last_polled_at: new Date(), status: 'submitted' });
        return { id: row.id, finalStatus: 'submitted', note: 'awaiting worker' };
      }
      if (poll.status === 'gone') {
        await updateRow(row.id, { status: 'gone', error_message: poll.reason, last_polled_at: new Date() });
        return { id: row.id, finalStatus: 'gone', note: poll.reason };
      }
      const task = poll.task;
      const s = task.status;
      if (s === 'running' || s === 'notcomplete') {
        await updateRow(row.id, { status: 'running', last_polled_at: new Date() });
        return { id: row.id, finalStatus: 'running' };
      }
      if (s === 'failed' || s === 'declined') {
        // Worker reported its own failure — the current xgodo task is
        // dead, but a fresh task with a different worker could still
        // succeed. Route to the resubmit recovery (up to
        // MAX_RESUBMISSIONS fresh tasks). When all resubmissions are
        // exhausted recordResubmittableFailure marks the row 'failed'
        // for real, with a clear "gave up after N" message.
        const reason = task.comment || `xgodo task ${s}`;
        const fail = await recordResubmittableFailure({
          rowId: row.id,
          resubmissions: row.resubmissions,
          errorMsg: reason,
        });
        return { id: row.id, ...fail };
      }
      // 'pending' or 'confirmed' → worker submitted proof. Pull
      // prompt/model/uploadedUrl from job_proof and move to download
      // step. (Workers post in 'pending' awaiting our review; we
      // confirm in step 4.)
      const proof = parseJobProof(task.job_proof);
      const uploaded =
        (proof.uploadedUrl as string | undefined) ||
        (proof.uploaded_url as string | undefined) ||
        (proof.url as string | undefined);
      const prompt = (proof.prompt as string | undefined) || null;
      const model  = (proof.model  as string | undefined) || null;
      if (!uploaded) {
        // Worker's proof shape doesn't match what we expect — could be
        // an early-build worker. Terminal: retrying won't change the
        // proof shape, but recordFailure() will keep it transient-
        // eligible if the message ever matches the regex in future.
        await updateRow(row.id, {
          status: 'failed', last_polled_at: new Date(),
          error_message: 'worker proof missing uploadedUrl',
        });
        return { id: row.id, finalStatus: 'failed', note: 'no uploadedUrl' };
      }
      await updateRow(row.id, {
        status: 'downloaded',     // semantically: "ready to download"
        prompt, model,
        uploaded_url: uploaded,
        last_polled_at: new Date(),
      });
      // Fall through to step 3 in the same tick so we don't waste a
      // round trip just to flip a state.
      row = { ...row, status: 'downloaded', prompt, model, uploadedUrl: uploaded };
    }

    // 3. Downloaded-state (proof captured, file not yet pulled) → fetch
    //    to the volume.
    if (row.status === 'downloaded' && row.uploadedUrl && !row.localPath) {
      // <id>_<short hash of url>.mp4 — short, predictable, no collisions.
      const safeId = String(row.id);
      const tail = row.uploadedUrl.split('/').pop() || 'video.mp4';
      const sanitised = tail.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      const filename = `${safeId}_${sanitised}`;
      try {
        const { path: p, bytes } = await downloadToVolume(row.uploadedUrl, filename);
        await updateRow(row.id, {
          local_path: p, file_bytes: bytes, downloaded_at: new Date(),
        });
        row = { ...row, localPath: p, fileBytes: bytes };
      } catch (err) {
        const msg = `download: ${(err as Error).message || 'failed'}`;
        // 4xx on the uploaded_url means xgodo's /server/temp aged out;
        // re-trying the same fetch will never succeed. Resubmit a
        // fresh xgodo download task so a new worker uploads to a new
        // temp URL. 5xx / network errors → transient retry.
        if (isResubmittableError(msg)) {
          const fail = await recordResubmittableFailure({
            rowId: row.id,
            resubmissions: row.resubmissions,
            errorMsg: msg,
          });
          return { id: row.id, ...fail };
        }
        const fail = await recordFailure({
          rowId: row.id, attempts: row.attempts,
          errorMsg: msg,
          // Proof + uploaded_url still in hand; next tick re-tries just
          // the file fetch.
          keepStatus: 'downloaded',
        });
        return { id: row.id, ...fail };
      }
    }

    // 4. Local file in hand → mark both xgodo tasks 'confirmed'.
    //
    // The mark step has three failure modes we classify separately
    // because they each want different action:
    //
    //   a) Transient (xgodo 5xx, network blip)
    //        → keep status='downloaded', let next tick retry the mark.
    //
    //   b) Task gone (404 / "No job found" / "no unpaid task")
    //        → xgodo no longer has the row to mark. Either the review
    //          task already got paid out by some other path, or xgodo
    //          aged it out. Retrying won't bring it back. We have the
    //          mp4 + prompt locally so this is operator-success.
    //          → status='confirmed' with a no-op note in error_message
    //            so the audit trail is honest about what happened.
    //
    //   c) Other 4xx (auth, schema, etc.)
    //        → terminal. Mark failed; operator needs to look.
    //
    // Before this classifier, row #12971 hit case (b) once and the
    // cron then re-claimed and retried 555 times over 9 hours — the
    // exact "system can't self-handle this" failure mode this fix is
    // for.
    function classifyMarkError(err: string | undefined): 'transient' | 'task_gone' | 'terminal' {
      const m = err || '';
      if (isTransientError(m)) return 'transient';
      if (/no job found|no unpaid task|task not found|404/i.test(m)) return 'task_gone';
      return 'terminal';
    }

    if (row.status === 'downloaded' && row.localPath && (row.fileBytes ?? 0) > 0) {
      const reviewMark = await markTask(
        row.reviewJobId, [row.reviewTaskId], 'confirmed',
        `xg vid download #${row.id} ok (${row.fileBytes} bytes)`,
      );
      let reviewGone = false;
      if (!reviewMark.ok) {
        const kind = classifyMarkError(reviewMark.error);
        if (kind === 'transient') {
          const fail = await recordFailure({
            rowId: row.id, attempts: row.attempts,
            errorMsg: `review mark: ${reviewMark.error}`,
            keepStatus: 'downloaded',
          });
          return { id: row.id, ...fail };
        }
        if (kind === 'task_gone') {
          // Treat as already-confirmed. We've got the mp4 locally; the
          // xgodo side is unreachable but irreversibly so.
          reviewGone = true;
        } else {
          // Terminal — terminate cleanly so the cron stops claiming.
          await updateRow(row.id, {
            status: 'failed',
            error_message: `review mark terminal: ${reviewMark.error}`,
          });
          return { id: row.id, finalStatus: 'failed', note: `review mark: ${reviewMark.error}` };
        }
      }
      let downloadGone = false;
      if (row.downloadTaskId && row.downloadJobId) {
        const dlMark = await markTask(
          row.downloadJobId, [row.downloadTaskId], 'confirmed',
          `xg vid download #${row.id} ok (${row.fileBytes} bytes)`,
        );
        if (!dlMark.ok) {
          const kind = classifyMarkError(dlMark.error);
          if (kind === 'transient') {
            const fail = await recordFailure({
              rowId: row.id, attempts: row.attempts,
              errorMsg: `download mark: ${dlMark.error}`,
              keepStatus: 'downloaded',
            });
            return { id: row.id, ...fail };
          }
          if (kind === 'task_gone') {
            downloadGone = true;
          } else {
            await updateRow(row.id, {
              status: 'failed',
              error_message: `download mark terminal: ${dlMark.error}`,
            });
            return { id: row.id, finalStatus: 'failed', note: `download mark: ${dlMark.error}` };
          }
        }
      }
      const noteParts: string[] = [];
      if (reviewGone)   noteParts.push('review task gone on xgodo');
      if (downloadGone) noteParts.push('download task gone on xgodo');
      await updateRow(row.id, {
        status: 'confirmed',
        confirmed_at: new Date(),
        error_message: noteParts.length ? noteParts.join('; ') : null,
      });
      return { id: row.id, finalStatus: 'confirmed', note: noteParts.join('; ') || undefined };
    }

    return { id: row.id, finalStatus: row.status };
  } catch (err) {
    // Catchall — covers thrown errors from xgodo wire calls (poll
    // throws on unexpected 5xx, submit can throw on network blips).
    // Keep the row in whatever step it was in so the cron's next tick
    // re-enters processOneRow at the same place.
    const keepStatus =
      row.status === 'submitted' || row.status === 'running' || row.status === 'downloaded'
        ? row.status
        : 'queued';
    const fail = await recordFailure({
      rowId: row.id, attempts: row.attempts,
      errorMsg: (err as Error).message || 'unknown',
      keepStatus,
    });
    return { id: row.id, ...fail };
  }
}

/** Claim and process up to N rows, capping concurrency at `parallel`.
 *  Returns the per-row outcomes so the UI can paint a fresh snapshot
 *  after a Drain click. */
export async function drainPending(limit: number, parallel: number): Promise<{
  claimed: number;
  results: Array<{ id: number; finalStatus: string; note?: string }>;
}> {
  const rows = await claimRows(limit);
  if (rows.length === 0) return { claimed: 0, results: [] };

  const cap = Math.max(1, Math.min(parallel, rows.length, 10));
  const results: Array<{ id: number; finalStatus: string; note?: string }> = [];
  let idx = 0;
  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= rows.length) return;
      results.push(await processOneRow(rows[my]));
    }
  }
  await Promise.all(Array.from({ length: cap }, () => worker()));
  return { claimed: rows.length, results };
}

/** Pull the latest rows + an at-a-glance stats summary. Used by the
 *  GET endpoint that the admin tab polls. */
export async function listRecent(options?: {
  limit?: number;
  status?: string;
}): Promise<{
  rows: XgVidDownloadRow[];
  stats: Record<string, number>;
  pending: number;
  running: number;
  done: number;
  errors: number;
  total: number;
}> {
  const pool = await getPool();
  const limit = Math.min(500, Math.max(1, options?.limit ?? 100));
  const filter = options?.status;

  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter && filter !== 'all') {
    where.push(`status = $${args.length + 1}`);
    args.push(filter);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit);
  const rowsRes = await pool.query<RawRow>(
    `SELECT * FROM xg_video_downloads
      ${whereSql}
      ORDER BY id DESC
      LIMIT $${args.length}`,
    args,
  );

  const statsRes = await pool.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM xg_video_downloads GROUP BY status`,
  );
  const stats: Record<string, number> = {};
  for (const r of statsRes.rows) stats[r.status] = parseInt(r.n, 10) || 0;

  const pending = (stats.queued || 0);
  const running = (stats.submitted || 0) + (stats.running || 0) + (stats.downloaded || 0);
  const done    = stats.confirmed || 0;
  const errors  = (stats.failed || 0) + (stats.gone || 0);
  const total   = Object.values(stats).reduce((a, b) => a + b, 0);

  return {
    rows: rowsRes.rows.map(mapRow),
    stats, pending, running, done, errors, total,
  };
}
