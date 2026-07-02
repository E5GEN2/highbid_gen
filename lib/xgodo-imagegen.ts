/**
 * xgodo image-generation pipeline.
 *
 * Routes image-gen tasks through xgodo's image-gen flow (the same worker
 * platform behind our keys / proxies / vizard-upload). Submit a task
 * {prompt, aspect, model}; a worker generates the image and returns a TEMP
 * xgodo url (expires within ~hours). We poll, then DOWNLOAD the temp url to
 * the Railway volume so the asset is permanent.
 *
 * This is the on-demand asset factory for content-gen — icons, card art,
 * etc. — and the overwatch surface (GET endpoint) lets Claude / the admin
 * watch tasks complete.
 *
 * State machine on imagegen_tasks.status:
 *   queued   — planned task submitted, no worker yet
 *   running  — worker assigned, generating
 *   done     — worker returned a temp url AND we downloaded it to the volume
 *   failed   — worker failed / task dropped / download failed
 *
 * Mirrors the proven xgodo-vizard-upload.ts plumbing (submit via
 * /planned_tasks/submit, poll one task by id via /jobs/applicants).
 */

import path from 'path';
import fs from 'fs/promises';
import { getPool } from './db';
import { CLIPS_DIR } from './clips-dir';
import { listMarketDevices, marketDeviceNameSet } from './xgodo-market-devices';
import { deletePlannedTasks } from './xgodo-tasks';

const XGODO_API = 'https://xgodo.com/api/v2';
/** The image-gen job (from the dashboard URL job_applicants?id=…). */
export const IMAGEGEN_JOB_ID = '69833b86b82b73895452552f';
/** Where downloaded images live on the volume (reuses the clips volume). */
const IMAGES_DIR = path.join(CLIPS_DIR, 'imagegen');

export const MODELS = ['nanobananapro', 'nanobanana', 'imagen4'] as const;
export const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;

export interface ImageGenInput {
  prompt: string;
  aspect?: string;
  model?: string;
  purpose?: string;   // free tag, e.g. 'icon:shrug_with_question_marks'
  imageURI?: string;  // 1-3 comma-separated public image URLs -> image-to-image conditioning
}

async function getXgodoToken(): Promise<string> {
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'xgodo_api_token' LIMIT 1`,
  );
  const token = r.rows[0]?.value?.trim();
  if (!token) throw new Error('xgodo_api_token not configured in admin_config');
  return token;
}

// ─────────────────────────────────────────────────────────────────────
// Submit
// ─────────────────────────────────────────────────────────────────────

export interface SubmitOpts {
  /** Pin the task to this device (device_name) + run it immediately. */
  pinDevice?: string;
  /** Dispatch NOW to any free worker (run_immediately, no device_name). The job
   *  is country-restricted, so this stays US-only. This is the reliable path:
   *  plain (no run_immediately) tasks sit in the "planned" stack and are never
   *  auto-pulled; run_immediately without a device is instantly assigned to any
   *  available worker (no specific-device limbo). */
  runImmediately?: boolean;
  /** Mark this row as a retry of an earlier task id. */
  retryOf?: number;
}

export async function submitImageGenTask(input: ImageGenInput, opts: SubmitOpts = {}): Promise<{ ok: true; id: number; plannedTaskId: string } | { ok: false; error: string }> {
  const prompt = (input.prompt || '').trim();
  if (!prompt) return { ok: false, error: 'prompt required' };
  const aspect = input.aspect || '1:1';
  const model = input.model || 'nanobananapro';
  const purpose = input.purpose ?? null;

  const pool = await getPool();
  const token = await getXgodoToken();

  // xgodo's image-gen automation reads {prompt, aspect, model, imageURI?}.
  // imageURI = 1-3 comma-separated public image URLs for image-to-image conditioning.
  const taskInput = { prompt, aspect, model, ...(input.imageURI ? { imageURI: input.imageURI } : {}) };
  const body: Record<string, unknown> = { job_id: IMAGEGEN_JOB_ID, inputs: [JSON.stringify(taskInput)] };
  if (opts.pinDevice) { body.device_name = opts.pinDevice; body.run_immediately = true; }
  else if (opts.runImmediately) { body.run_immediately = true; }   // dispatch to any free (US) worker now

  const res = await fetch(`${XGODO_API}/planned_tasks/submit`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `xgodo submit failed: ${res.status} ${text.slice(0, 200)}` };
  }
  const data = await res.json() as { success?: boolean; inserted_ids?: Array<{ planned_task_id: string }> };
  const plannedTaskId = data.inserted_ids?.[0]?.planned_task_id;
  if (!plannedTaskId) return { ok: false, error: `xgodo response missing planned_task_id: ${JSON.stringify(data).slice(0, 200)}` };

  const ins = await pool.query<{ id: number }>(
    `INSERT INTO imagegen_tasks (purpose, prompt, aspect, model, status, planned_task_id, pinned_device, retry_of, submitted_at)
     VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,NOW()) RETURNING id`,
    [purpose, prompt, aspect, model, plannedTaskId, opts.pinDevice ?? null, opts.retryOf ?? null],
  );
  return { ok: true, id: ins.rows[0].id, plannedTaskId };
}

// ─────────────────────────────────────────────────────────────────────
// Device affinity — learn which devices succeed, route future work to them
// ─────────────────────────────────────────────────────────────────────

export interface DeviceRep {
  device_name: string;
  done: number;
  failed: number;
  total: number;
  success_rate: number;   // done / total
  last_seen: string | null;
}

/** Per-device image-gen success stats, best first. */
export async function getDeviceReputation(): Promise<DeviceRep[]> {
  const pool = await getPool();
  const r = await pool.query<{ device_name: string; done: number; failed: number; total: number; last_seen: string | null }>(
    `SELECT device_name,
            COUNT(*) FILTER (WHERE status='done')::int   AS done,
            COUNT(*) FILTER (WHERE status='failed')::int AS failed,
            COUNT(*) FILTER (WHERE status IN ('done','failed'))::int AS total,
            MAX(updated_at)::text AS last_seen
       FROM imagegen_tasks
      WHERE device_name IS NOT NULL
      GROUP BY device_name`,
  );
  return r.rows
    .map(d => ({ ...d, success_rate: d.total > 0 ? d.done / d.total : 0 }))
    .sort((a, b) => (b.success_rate - a.success_rate) || (b.done - a.done));
}

/** Devices currently RUNNING a task on the image-gen job — pinning to these
 *  leaves the new task in limbo (run_immediately can't assign to a busy
 *  device, and there's no auto-pickup once it frees). Same rule the agents
 *  deploy enforces. */
async function fetchBusyDevices(token: string): Promise<Set<string>> {
  const r = await postApplicants(token, { job_id: IMAGEGEN_JOB_ID, status: 'running', limit: 100 });
  const set = new Set<string>();
  for (const t of r.data?.job_tasks || []) if (t.device_name) set.add(t.device_name);
  return set;
}

/**
 * Devices we may PIN to right now, best first: proven (≥1 success, ≥20%),
 * currently online, and NOT busy on another task. Ordered by success-rate
 * then volume of successes.
 */
export async function getPinnableDevices(token: string): Promise<string[]> {
  const [rep, market, busy] = await Promise.all([
    getDeviceReputation(),
    listMarketDevices(token).catch(() => []),
    fetchBusyDevices(token).catch(() => new Set<string>()),
  ]);
  // USA-only: the 'ng' device pool is the main source of "time limit exceeded"
  // failures; restrict pinning to the far more reliable 'us' devices. Include
  // every online US device (proven-first) so image-to-image batches have a
  // usable pool — only drop devices with a proven-bad record.
  // isAvailable===true means the device has NO running job task right now — only these
  // will accept a run_immediately pin (busy ones fall into limbo). This is the key fix.
  const usOnline = market.filter(d => (d.country || '').toLowerCase() === 'us' && d.isAvailable === true).map(d => d.name).filter(Boolean);
  const repByName = new Map(rep.map(d => [d.device_name, d]));
  return usOnline
    .filter(name => !busy.has(name))
    .filter(name => { const r = repByName.get(name); return !r || r.total < 3 || r.success_rate >= 0.2; })
    .sort((a, b) => (repByName.get(b)?.success_rate ?? 0.5) - (repByName.get(a)?.success_rate ?? 0.5));
}

/**
 * Submit a batch with device affinity, following the agents-deploy rules:
 * pin at most ONE task per proven device that's online AND free right now
 * (claiming each as we go so we never double-pin a device into limbo). Any
 * tasks beyond the available good devices go UNPINNED — which doubles as
 * exploration, letting xgodo surface new devices we can learn about.
 */
export async function submitImageGenBatch(
  inputs: ImageGenInput[],
  opts: { pin?: boolean; dispatchAny?: boolean; retryOf?: (i: number) => number | undefined } = {},
): Promise<{ submitted: number; failed: number; ids: number[]; pinnedTo: string[]; unpinned: number; errors: string[] }> {
  // dispatchAny: run_immediately with NO device -> xgodo assigns to any free
  // (US) worker instantly. The reliable, high-throughput path (see SubmitOpts).
  const dispatchAny = opts.dispatchAny ?? false;
  const pin = !dispatchAny && (opts.pin ?? true);
  let pinnable: string[] = [];
  if (pin) {
    try { pinnable = await getPinnableDevices(await getXgodoToken()); } catch { pinnable = []; }
  }

  // Assign one distinct device per input until we run out of pinnable
  // devices; the rest are unpinned.
  const assignments = inputs.map((_, i) => (i < pinnable.length ? pinnable[i] : undefined));

  const ids: number[] = []; const errors: string[] = []; const pinnedTo: string[] = [];
  const results = await Promise.all(inputs.map(async (input, i) => {
    const dev = assignments[i];
    const r = await submitImageGenTask(input, { pinDevice: dev, runImmediately: dispatchAny, retryOf: opts.retryOf?.(i) });
    if ('error' in r) return { ok: false as const, error: r.error };
    return { ok: true as const, id: r.id, dev };
  }));
  for (const res of results) {
    if (res.ok) { ids.push(res.id); if (res.dev) pinnedTo.push(res.dev); }
    else errors.push(res.error);
  }
  return { submitted: ids.length, failed: errors.length, ids, pinnedTo, unpinned: ids.length - pinnedTo.length, errors };
}

// ─────────────────────────────────────────────────────────────────────
// Poll (mirrors vizard fetchTaskById)
// ─────────────────────────────────────────────────────────────────────

interface XgodoJobTask {
  _id: string;
  status: string;
  job_proof: string | Record<string, unknown> | null;
  failureReason: string | null;
  comment: string | null;
  worker_name: string | null;
  device_id: string | null;
  device_name: string | null;
  added: string | null;
  finished: string | null;
  planned_task_id: string;
}

type FetchResult =
  | { status: 'queued' }
  | { status: 'found'; task: XgodoJobTask }
  | { status: 'gone'; reason: string };

async function postApplicants(token: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string; data: { job_tasks?: XgodoJobTask[] } | null }> {
  const res = await fetch(`${XGODO_API}/jobs/applicants`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => ''), data: null };
  return { ok: true, status: res.status, text: '', data: await res.json() };
}

async function fetchTaskById(token: string, plannedTaskId: string, knownJobTaskId: string | null): Promise<FetchResult> {
  const lookupId = knownJobTaskId || plannedTaskId;
  const r = await postApplicants(token, { job_id: IMAGEGEN_JOB_ID, task_id: lookupId });
  if (!r.ok) {
    if (r.status === 400 && /no associated job task|job_task_id is null/i.test(r.text)) return { status: 'queued' };
    if (r.status === 404 && /neither a valid|not found/i.test(r.text)) return { status: 'gone', reason: 'xgodo no longer recognises this task id' };
    throw new Error(`xgodo poll ${r.status}: ${r.text.slice(0, 160)}`);
  }
  const task = (r.data?.job_tasks || [])[0];
  if (!task) return { status: 'queued' };
  return { status: 'found', task };
}

function parseProof(jp: XgodoJobTask['job_proof']): Record<string, unknown> {
  if (!jp) return {};
  if (typeof jp === 'object') return jp;
  try { return JSON.parse(jp); } catch { return { raw: jp }; }
}

// ─────────────────────────────────────────────────────────────────────
// Download (temp url → volume)
// ─────────────────────────────────────────────────────────────────────

function extFromName(name: string | null, contentType: string | null): string {
  const fromName = name && /\.(jpe?g|png|webp|gif)$/i.exec(name)?.[1];
  if (fromName) return fromName.toLowerCase().replace('jpeg', 'jpg');
  if (contentType?.includes('png')) return 'png';
  if (contentType?.includes('webp')) return 'webp';
  return 'jpg';
}

async function downloadToVolume(id: number, url: string, token: string, imageName: string | null): Promise<{ localPath: string; bytes: number }> {
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  // Temp xgodo urls are usually public/signed; if the fetch is rejected,
  // retry once with the bearer token.
  let res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if ((res.status === 401 || res.status === 403)) {
    res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  }
  if (!res.ok) throw new Error(`download ${res.status}`);
  const ct = res.headers.get('content-type');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 200) throw new Error(`downloaded file too small (${buf.length} bytes)`);
  const ext = extFromName(imageName, ct);
  const localPath = path.join(IMAGES_DIR, `${id}.${ext}`);
  await fs.writeFile(localPath, buf);
  return { localPath, bytes: buf.length };
}

// ─────────────────────────────────────────────────────────────────────
// Tick — poll in-flight tasks, download finished ones
// ─────────────────────────────────────────────────────────────────────

export async function tickImageGen(): Promise<{ polled: number; done: number; failed: number; errors: number; swept: number }> {
  const pool = await getPool();
  const token = await getXgodoToken();

  // Zombie sweep (agents-deploy rule): a PINNED task still 'queued' after a
  // few minutes means its device was busy/offline and run_immediately never
  // landed — xgodo will hold it forever. Delete the planned task to free the
  // slot and fail the row so retryMissing re-pins it to a free device.
  let swept = 0;
  const stuck = await pool.query<{ id: number; planned_task_id: string }>(
    `SELECT id, planned_task_id FROM imagegen_tasks
      WHERE status='queued' AND pinned_device IS NOT NULL AND planned_task_id IS NOT NULL
        AND submitted_at < NOW() - INTERVAL '4 minutes'`,
  );
  if (stuck.rows.length > 0) {
    await deletePlannedTasks(token, stuck.rows.map(r => r.planned_task_id)).catch(() => {});
    await pool.query(
      `UPDATE imagegen_tasks SET status='failed', error='pinned device never picked it up (stuck in queue)', finished_at=NOW(), updated_at=NOW() WHERE id = ANY($1::int[])`,
      [stuck.rows.map(r => r.id)],
    );
    swept = stuck.rows.length;
  }

  const due = await pool.query<{ id: number; planned_task_id: string; job_task_id: string | null; status: string }>(
    `SELECT id, planned_task_id, job_task_id, status
       FROM imagegen_tasks
      WHERE status IN ('queued','running') AND planned_task_id IS NOT NULL
        AND (last_polled_at IS NULL OR last_polled_at < NOW() - INTERVAL '6 seconds')
      ORDER BY submitted_at ASC
      LIMIT 50`,
  );
  if (due.rows.length === 0) return { polled: 0, done: 0, failed: 0, errors: 0, swept };

  let polled = 0, done = 0, failed = 0, errors = 0;

  for (const row of due.rows) {
    polled++;
    try {
      const r = await fetchTaskById(token, row.planned_task_id, row.job_task_id);

      if (r.status === 'queued') {
        await pool.query(`UPDATE imagegen_tasks SET last_polled_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
        continue;
      }
      if (r.status === 'gone') {
        await pool.query(`UPDATE imagegen_tasks SET status='failed', error=$1, finished_at=COALESCE(finished_at,NOW()), last_polled_at=NOW(), updated_at=NOW() WHERE id=$2`, [r.reason, row.id]);
        failed++;
        continue;
      }

      const task = r.task;
      const proof = parseProof(task.job_proof);
      const tempUrl = (typeof proof.uploadedUrl === 'string' ? proof.uploadedUrl : null) ?? (typeof proof.url === 'string' ? proof.url : null);
      const expiresAt = typeof proof.expiresAt === 'string' ? proof.expiresAt : null;
      const imageName = typeof proof.imageName === 'string' ? proof.imageName : null;

      if (['failed', 'declined'].includes(task.status)) {
        // Capture the device that FAILED too — the affinity ranker needs the
        // losers as much as the winners.
        await pool.query(
          `UPDATE imagegen_tasks SET status='failed', job_task_id=$1, worker_name=COALESCE($2,worker_name),
             device_id=COALESCE($3,device_id), device_name=COALESCE($4,device_name),
             error=$5, finished_at=COALESCE(finished_at,$6), last_polled_at=NOW(), updated_at=NOW() WHERE id=$7`,
          [task._id, task.worker_name, task.device_id, task.device_name, task.comment || task.failureReason || 'worker failed', task.finished, row.id],
        );
        failed++;
        continue;
      }

      // pending/confirmed with a url → worker finished; download it.
      if (tempUrl) {
        try {
          const { localPath } = await downloadToVolume(row.id, tempUrl, token, imageName);
          await pool.query(
            `UPDATE imagegen_tasks SET status='done', job_task_id=$1, worker_name=COALESCE($2,worker_name),
               device_id=COALESCE($3,device_id), device_name=COALESCE($4,device_name),
               xgodo_temp_url=$5, expires_at=$6, image_name=$7, local_path=$8,
               started_at=COALESCE(started_at,$9), finished_at=COALESCE(finished_at,$10),
               error=NULL, last_polled_at=NOW(), updated_at=NOW() WHERE id=$11`,
            [task._id, task.worker_name, task.device_id, task.device_name, tempUrl, expiresAt, imageName, localPath, task.added, task.finished, row.id],
          );
          done++;
        } catch (dlErr) {
          // Keep the temp url so a later tick / manual retry can re-download.
          await pool.query(
            `UPDATE imagegen_tasks SET status='running', job_task_id=$1, xgodo_temp_url=$2, expires_at=$3, image_name=$4, error=$5, last_polled_at=NOW(), updated_at=NOW() WHERE id=$6`,
            [task._id, tempUrl, expiresAt, imageName, `download failed: ${(dlErr as Error).message}`, row.id],
          );
          errors++;
        }
        continue;
      }

      // still running (worker assigned, no url yet) — capture the device now
      // so we know who's working it even before it finishes.
      await pool.query(
        `UPDATE imagegen_tasks SET status='running', job_task_id=$1, worker_name=COALESCE($2,worker_name),
           device_id=COALESCE($3,device_id), device_name=COALESCE($4,device_name),
           started_at=COALESCE(started_at,$5), last_polled_at=NOW(), updated_at=NOW() WHERE id=$6`,
        [task._id, task.worker_name, task.device_id, task.device_name, task.added, row.id],
      );
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : 'unknown';
      const transient = /xgodo poll 5\d\d/.test(msg) || /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(msg);
      if (transient) {
        await pool.query(`UPDATE imagegen_tasks SET last_polled_at = NOW() WHERE id = $1`, [row.id]);
      } else {
        await pool.query(`UPDATE imagegen_tasks SET last_polled_at = NOW(), error = $1, updated_at = NOW() WHERE id = $2`, [msg, row.id]);
      }
    }
  }
  return { polled, done, failed, errors, swept };
}

/**
 * Backfill device_id/device_name for terminal tasks that finished before we
 * started capturing it — re-poll each by job_task_id and pull the device.
 * One-time-ish; safe to call repeatedly (only touches rows missing a device).
 */
export async function backfillDeviceInfo(limit = 60): Promise<{ scanned: number; filled: number }> {
  const pool = await getPool();
  const rows = (await pool.query<{ id: number; job_task_id: string | null; planned_task_id: string }>(
    `SELECT id, job_task_id, planned_task_id FROM imagegen_tasks
      WHERE device_name IS NULL AND status IN ('done','failed') AND (job_task_id IS NOT NULL OR planned_task_id IS NOT NULL)
      ORDER BY id DESC LIMIT $1`,
    [limit],
  )).rows;
  if (rows.length === 0) return { scanned: 0, filled: 0 };
  const token = await getXgodoToken();
  let filled = 0;
  for (const row of rows) {
    try {
      const r = await postApplicants(token, { job_id: IMAGEGEN_JOB_ID, task_id: row.job_task_id || row.planned_task_id });
      const task = (r.data?.job_tasks || [])[0];
      if (task && (task.device_name || task.device_id)) {
        await pool.query(`UPDATE imagegen_tasks SET device_id=COALESCE($1,device_id), device_name=COALESCE($2,device_name), worker_name=COALESCE($3,worker_name) WHERE id=$4`,
          [task.device_id, task.device_name, task.worker_name, row.id]);
        filled++;
      }
    } catch { /* skip */ }
  }
  return { scanned: rows.length, filled };
}

/**
 * Resubmit every `purpose` that has NO successful image yet but has failed
 * attempts — pinned to proven good online devices. The core of the
 * "schedule X, keep the winners' devices, retry the rest on them" loop.
 */
export async function retryMissingImageGen(opts: { maxAttemptsPerPurpose?: number } = {}): Promise<{ retried: number; purposes: string[]; ids: number[]; pinnedTo: string[] }> {
  const pool = await getPool();
  const cap = opts.maxAttemptsPerPurpose ?? 6;
  // latest failed task per purpose that has no done sibling, under the attempt cap
  const rows = (await pool.query<{ purpose: string; prompt: string; aspect: string | null; model: string | null; id: number; attempts: number }>(
    `SELECT DISTINCT ON (t.purpose) t.purpose, t.prompt, t.aspect, t.model, t.id,
            (SELECT COUNT(*) FROM imagegen_tasks x WHERE x.purpose = t.purpose)::int AS attempts
       FROM imagegen_tasks t
      WHERE t.purpose IS NOT NULL
        AND t.status = 'failed'
        AND t.purpose NOT IN (SELECT purpose FROM imagegen_tasks WHERE status='done' AND purpose IS NOT NULL)
      ORDER BY t.purpose, t.id DESC`,
  )).rows.filter(r => r.attempts < cap);
  if (rows.length === 0) return { retried: 0, purposes: [], ids: [], pinnedTo: [] };

  const inputs: ImageGenInput[] = rows.map(r => ({ prompt: r.prompt, aspect: r.aspect ?? '16:9', model: r.model ?? 'nanobananapro', purpose: r.purpose }));
  const res = await submitImageGenBatch(inputs, { pin: true, retryOf: (i) => rows[i].id });
  return { retried: res.submitted, purposes: rows.map(r => r.purpose), ids: res.ids, pinnedTo: res.pinnedTo };
}

/** Read a downloaded image off the volume (for the serve endpoint). */
export async function readImageFile(id: number): Promise<{ buf: Buffer; contentType: string } | null> {
  const pool = await getPool();
  const r = await pool.query<{ local_path: string | null }>(`SELECT local_path FROM imagegen_tasks WHERE id = $1`, [id]);
  const p = r.rows[0]?.local_path;
  if (!p) return null;
  try {
    const buf = await fs.readFile(p);
    const ext = path.extname(p).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    return { buf, contentType };
  } catch { return null; }
}
