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

const XGODO_API = 'https://xgodo.com/api/v2';
/** The image-gen job (from the dashboard URL job_applicants?id=…). */
export const IMAGEGEN_JOB_ID = '69833b86b82b73895452552f';
/** Where downloaded images live on the volume (reuses the clips volume). */
const IMAGES_DIR = path.join(CLIPS_DIR, 'imagegen');

export const MODELS = ['nanobananapro', 'nanobanana', 'imagen4'] as const;
export const ASPECTS = ['16:9', '1:1', '9:16', '4:3', '3:4'] as const;

export interface ImageGenInput {
  prompt: string;
  aspect?: string;
  model?: string;
  purpose?: string;   // free tag, e.g. 'icon:shrug_with_question_marks'
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

export async function submitImageGenTask(input: ImageGenInput): Promise<{ ok: true; id: number; plannedTaskId: string } | { ok: false; error: string }> {
  const prompt = (input.prompt || '').trim();
  if (!prompt) return { ok: false, error: 'prompt required' };
  const aspect = input.aspect || '16:9';
  const model = input.model || 'nanobananapro';
  const purpose = input.purpose ?? null;

  const pool = await getPool();
  const token = await getXgodoToken();

  // xgodo's image-gen automation reads {prompt, aspect, model}.
  const taskInput = { prompt, aspect, model };

  const res = await fetch(`${XGODO_API}/planned_tasks/submit`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: IMAGEGEN_JOB_ID, inputs: [JSON.stringify(taskInput)] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `xgodo submit failed: ${res.status} ${text.slice(0, 200)}` };
  }
  const data = await res.json() as { success?: boolean; inserted_ids?: Array<{ planned_task_id: string }> };
  const plannedTaskId = data.inserted_ids?.[0]?.planned_task_id;
  if (!plannedTaskId) return { ok: false, error: `xgodo response missing planned_task_id: ${JSON.stringify(data).slice(0, 200)}` };

  const ins = await pool.query<{ id: number }>(
    `INSERT INTO imagegen_tasks (purpose, prompt, aspect, model, status, planned_task_id, submitted_at)
     VALUES ($1,$2,$3,$4,'queued',$5,NOW()) RETURNING id`,
    [purpose, prompt, aspect, model, plannedTaskId],
  );
  return { ok: true, id: ins.rows[0].id, plannedTaskId };
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

export async function tickImageGen(): Promise<{ polled: number; done: number; failed: number; errors: number }> {
  const pool = await getPool();
  const due = await pool.query<{ id: number; planned_task_id: string; job_task_id: string | null; status: string }>(
    `SELECT id, planned_task_id, job_task_id, status
       FROM imagegen_tasks
      WHERE status IN ('queued','running') AND planned_task_id IS NOT NULL
        AND (last_polled_at IS NULL OR last_polled_at < NOW() - INTERVAL '6 seconds')
      ORDER BY submitted_at ASC
      LIMIT 50`,
  );
  if (due.rows.length === 0) return { polled: 0, done: 0, failed: 0, errors: 0 };

  const token = await getXgodoToken();
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
        await pool.query(
          `UPDATE imagegen_tasks SET status='failed', job_task_id=$1, worker_name=COALESCE($2,worker_name), error=$3, finished_at=COALESCE(finished_at,$4), last_polled_at=NOW(), updated_at=NOW() WHERE id=$5`,
          [task._id, task.worker_name, task.comment || task.failureReason || 'worker failed', task.finished, row.id],
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
               xgodo_temp_url=$3, expires_at=$4, image_name=$5, local_path=$6,
               started_at=COALESCE(started_at,$7), finished_at=COALESCE(finished_at,$8),
               error=NULL, last_polled_at=NOW(), updated_at=NOW() WHERE id=$9`,
            [task._id, task.worker_name, tempUrl, expiresAt, imageName, localPath, task.added, task.finished, row.id],
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

      // still running (worker assigned, no url yet)
      await pool.query(
        `UPDATE imagegen_tasks SET status='running', job_task_id=$1, worker_name=COALESCE($2,worker_name), started_at=COALESCE(started_at,$3), last_polled_at=NOW(), updated_at=NOW() WHERE id=$4`,
        [task._id, task.worker_name, task.added, row.id],
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
  return { polled, done, failed, errors };
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
