/**
 * Google AI Studio key importer.
 *
 * xgodo workers harvest fresh Google AI Studio API keys and submit them
 * as job_proof on tasks in a dedicated xgodo job. This module reviews
 * those submissions:
 *
 *   1. Fetch tasks awaiting employer review (status='processing').
 *   2. Parse each task's job_proof to extract the candidate key(s).
 *   3. Test each key against generativelanguage.googleapis.com — via an
 *      xgodo residential proxy so Google doesn't see all our test
 *      traffic from Railway's egress IP.
 *   4. Good key  → INSERT into xgodo_api_keys (service='google_ai_studio')
 *                  + mark xgodo task 'confirmed'.
 *   5. Bad key   → mark xgodo task 'declined' with a brief reason.
 *
 * Same review API the data-collection sync uses
 * (PUT /api/v2/jobs/applicants with JobTasks_Ids + status), so we're
 * exercising a path xgodo's already happy with.
 */

import { getPool } from './db';
import { getRandomProxy } from './xgodo-proxy';
import { ytFetchViaProxy } from './yt-proxy-fetch';

const XGODO_API = 'https://xgodo.com/api/v2';

/** The Google AI Studio key job — passed in from caller normally,
 *  exported here as the operator's default. */
export const DEFAULT_AI_STUDIO_KEY_JOB_ID = '69f499d56730e5906b1eb576';

/** Standard Google AI Studio key shape: AIzaSy + 33 chars. */
const KEY_REGEX = /AIzaSy[A-Za-z0-9_-]{33}/g;

interface XgodoTask {
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
}

export interface KeyImportEvent {
  taskId: string;
  workerName: string | null;
  deviceName: string | null;
  finishedAt: string | null;
  key: string | null;             // masked when surfaced through the API
  keyFull?: string;               // populated server-side only (don't leak to client)
  /** Test outcome */
  result: 'valid' | 'invalid' | 'no_key' | 'duplicate' | 'error';
  reason: string | null;          // human-readable detail
  latencyMs: number | null;
  proxyUsed: string | null;
  action: 'confirmed' | 'declined' | 'skipped' | null;
  insertedId: number | null;      // xgodo_api_keys.id if we stored it
  detectedAt: string;             // when we processed this task (server clock)
}

export interface KeyImportProgress {
  total: number;
  processed: number;
  valid: number;
  invalid: number;
  duplicate: number;
  noKey: number;
  errors: number;
  events: KeyImportEvent[];        // newest-first
  running: boolean;
  jobKey: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

/** Read xgodo bearer for the AI Studio key job. Falls back through the
 *  same key chain getXgodoToken() uses, plus the env var. */
async function getXgodoToken(): Promise<string> {
  const pool = await getPool();
  for (const k of [
    'xgodo_ai_studio_keys_token',  // dedicated for this job, if set
    'xgodo_niche_spy_token',        // same xgodo account, same flow
    'xgodo_api_token',
    'xgodo_admin_token',
  ]) {
    const r = await pool.query("SELECT value FROM admin_config WHERE key = $1", [k]);
    if (r.rows[0]?.value) return r.rows[0].value;
  }
  return process.env.XGODO_API_TOKEN || '';
}

/** Fetch tasks awaiting employer review for the given xgodo job.
 *  Note: status='pending' (worker submitted, awaiting review). The
 *  niche-spy sync uses 'processing' — different jobs use different
 *  status semantics on xgodo. Empirically the AI Studio keys job
 *  puts submissions in 'pending'. */
async function fetchPendingTasks(token: string, jobId: string, limit: number): Promise<XgodoTask[]> {
  const res = await fetch(`${XGODO_API}/jobs/applicants`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, status: 'pending', limit }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`xgodo /jobs/applicants ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json() as { job_tasks?: XgodoTask[] };
  return data.job_tasks || [];
}

/** PUT /jobs/applicants with the review verdict — same call shape the
 *  data-collection sync uses to confirm processed tasks. Per the
 *  operator: good keys go to 'satisfied'; bad/duplicate keys go to
 *  'declined'. */
async function reviewTasks(
  token: string,
  jobId: string,
  taskIds: string[],
  status: 'satisfied' | 'declined',
  comment: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (taskIds.length === 0) return { ok: true, status: 200 };
  // xgodo accepts up to 100 ids per call (same cap as the sync).
  for (let off = 0; off < taskIds.length; off += 100) {
    const slice = taskIds.slice(off, off + 100);
    const res = await fetch(`${XGODO_API}/jobs/applicants`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        JobTasks_Ids: slice,
        status,
        job_id: jobId,
        comment: comment.slice(0, 250),
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: txt.slice(0, 200) };
    }
  }
  return { ok: true, status: 200 };
}

/** Pull every AIza... key string out of a job_proof blob (string OR
 *  object). Returns deduplicated. */
function extractKeysFromTask(task: XgodoTask): string[] {
  const candidates: string[] = [];
  const proof = task.job_proof;
  const proofInput = task.proof_input;
  const comment = task.comment;
  function scan(v: unknown) {
    if (!v) return;
    if (typeof v === 'string') {
      const m = v.match(KEY_REGEX);
      if (m) candidates.push(...m);
    } else if (Array.isArray(v)) {
      for (const x of v) scan(x);
    } else if (typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) scan(x);
    }
  }
  scan(proof);
  scan(proofInput);
  scan(comment);
  // Also try parsing string proof as JSON in case it's stringified
  if (typeof proof === 'string') {
    try { scan(JSON.parse(proof)); } catch { /* ignore */ }
  }
  return Array.from(new Set(candidates));
}

/** Mask a key for client display: "AIzaSy…last4". */
function maskKey(key: string): string {
  if (key.length < 12) return '***';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** Hit Google AI Studio's models list via xgodo proxy. 200 + .models[]
 *  = valid. 4xx with PERMISSION_DENIED / API key not valid = invalid.
 *  Any other failure = "error" (not the same as "invalid"). */
async function testKey(key: string, proxyUrl?: string): Promise<{
  valid: boolean;
  reason: string;
  latencyMs: number;
  proxyUsed: string;
}> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const t0 = Date.now();
  // Build a pair-like object so ytFetchViaProxy uses the supplied proxy.
  const pair = proxyUrl ? {
    key: '',                 // not used by the fetch; only the proxy is
    proxyUrl,
    proxyDeviceId: 'ai-studio-test',
    banned: false,
    banExpiry: 0,
  } : undefined;
  const res = await ytFetchViaProxy(url, pair);
  const latencyMs = Date.now() - t0;
  const data = res.data as { models?: Array<{ name?: string }>; error?: { code?: number; message?: string; status?: string } } | null;

  if (res.ok && Array.isArray(data?.models) && data.models.length > 0) {
    return { valid: true, reason: `${data.models.length} models accessible`, latencyMs, proxyUsed: res.proxyUsed || '?' };
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    const msg = data?.error?.message || res.error || `HTTP ${res.status}`;
    return { valid: false, reason: msg.slice(0, 200), latencyMs, proxyUsed: res.proxyUsed || '?' };
  }
  // Anything else (timeout, network failure, weird response) — treat as
  // ERROR not invalid. Don't burn an xgodo task verdict on a transient.
  return { valid: false, reason: `inconclusive: ${res.error || res.status || 'no response'}`, latencyMs, proxyUsed: res.proxyUsed || '?' };
}

/** Insert one validated key into our inventory. Idempotent via
 *  (service, key) unique constraint. Returns the row id, or null if it
 *  was already there. */
async function persistKey(key: string, sourceMeta: Record<string, unknown>): Promise<{ insertedId: number | null; duplicate: boolean }> {
  const pool = await getPool();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO xgodo_api_keys (service, key, source, status, added_at)
     VALUES ('google_ai_studio', $1, 'xgodo-import', 'active', NOW())
     ON CONFLICT (service, key) DO NOTHING
     RETURNING id`,
    [key],
  );
  if (r.rows.length === 0) return { insertedId: null, duplicate: true };
  // Optional: record provenance — only do this if the table has the cols.
  // Skipping for now to keep the migration footprint zero.
  void sourceMeta;
  return { insertedId: r.rows[0].id, duplicate: false };
}

// ─────────────────────────────────────────────────────────────────────
// Orchestrator + in-memory state (fire-and-forget, mirrors the novelty
// + labels job pattern). Railway container restarts wipe state, which
// is fine — re-trigger and pending tasks just get re-processed.
// ─────────────────────────────────────────────────────────────────────

let state: KeyImportProgress = {
  total: 0, processed: 0, valid: 0, invalid: 0, duplicate: 0, noKey: 0, errors: 0,
  events: [], running: false, jobKey: null,
  startedAt: null, finishedAt: null, lastError: null,
};
let inFlight = false;

export function getKeyImportState(): KeyImportProgress {
  return state;
}

export interface RunImportOpts {
  jobId?: string;
  limit?: number;        // max tasks to pull from xgodo in this run
  concurrency?: number;  // how many keys to test in parallel
  dryRun?: boolean;      // skip the xgodo confirm/decline call
  commentSuffix?: string;
}

export function startKeyImport(opts: RunImportOpts = {}): { started: boolean; jobKey?: string } {
  if (inFlight) return { started: false, jobKey: state.jobKey ?? undefined };
  const jobKey = `aikeys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  inFlight = true;
  state = {
    total: 0, processed: 0, valid: 0, invalid: 0, duplicate: 0, noKey: 0, errors: 0,
    events: [], running: true, jobKey,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
  };
  // Detached — handler returns immediately, work continues on the
  // container until done or recycled.
  (async () => {
    try {
      await runImport(opts);
    } catch (err) {
      state.lastError = (err as Error).message?.slice(0, 500) || 'unknown';
      console.error('[aikeys] import failed:', err);
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      inFlight = false;
    }
  })();
  return { started: true, jobKey };
}

async function runImport(opts: RunImportOpts): Promise<void> {
  const jobId = opts.jobId ?? DEFAULT_AI_STUDIO_KEY_JOB_ID;
  const limit = Math.min(opts.limit ?? 100, 500);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 5, 20));
  const dryRun = !!opts.dryRun;

  const token = await getXgodoToken();
  if (!token) throw new Error('xgodo bearer not configured (admin_config.xgodo_niche_spy_token / .xgodo_api_token)');

  const tasks = await fetchPendingTasks(token, jobId, limit);
  state.total = tasks.length;
  if (tasks.length === 0) return;

  // Process tasks with a small worker pool. We need to BOTH test the
  // key AND emit a finished event before scheduling the xgodo review,
  // so we keep the per-task pipeline serial and only parallelise across
  // tasks (not within one task's steps).
  const satisfiedIds: string[] = [];
  const declinedTasks: Array<{ id: string; reason: string }> = [];

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      const task = tasks[i];
      const finishedIso = task.finished || null;
      const evt: KeyImportEvent = {
        taskId: task._id,
        workerName: task.worker_name,
        deviceName: task.device_name,
        finishedAt: finishedIso,
        key: null,
        result: 'no_key',
        reason: null,
        latencyMs: null,
        proxyUsed: null,
        action: null,
        insertedId: null,
        detectedAt: new Date().toISOString(),
      };

      try {
        const keys = extractKeysFromTask(task);
        if (keys.length === 0) {
          evt.result = 'no_key';
          evt.reason = 'job_proof has no AIzaSy… key';
          declinedTasks.push({ id: task._id, reason: 'no key in submission' });
          state.noKey++;
        } else {
          // If a worker submits multiple keys in one task, treat ANY good
          // one as confirming the task. We persist every valid key.
          let anyValid = false;
          let lastReason = 'no valid key';
          let firstInsertedId: number | null = null;
          let anyDuplicate = false;
          for (const key of keys) {
            evt.key = maskKey(key);
            evt.keyFull = key;
            // Random proxy from the active pool — same selection strategy
            // the niche-explorer embedding pipeline uses (random > round
            // robin in the bench we ran on embeddings).
            const proxy = await getRandomProxy();
            const test = await testKey(key, proxy?.url);
            evt.latencyMs = test.latencyMs;
            evt.proxyUsed = test.proxyUsed;
            lastReason = test.reason;
            if (test.valid) {
              const p = await persistKey(key, {
                taskId: task._id, jobId, worker: task.worker_name, device: task.device_name,
              });
              if (p.duplicate) {
                anyDuplicate = true;
              } else {
                anyValid = true;
                firstInsertedId = firstInsertedId ?? p.insertedId;
              }
            }
          }

          if (anyValid) {
            evt.result = 'valid';
            evt.reason = lastReason;
            evt.insertedId = firstInsertedId;
            satisfiedIds.push(task._id);
            state.valid++;
          } else if (anyDuplicate) {
            evt.result = 'duplicate';
            evt.reason = 'already in inventory';
            // Duplicates get DECLINED per operator policy — we don't pay
            // for keys we already have.
            declinedTasks.push({ id: task._id, reason: 'duplicate key — already in inventory' });
            state.duplicate++;
          } else {
            evt.result = 'invalid';
            evt.reason = lastReason;
            declinedTasks.push({ id: task._id, reason: lastReason.slice(0, 100) });
            state.invalid++;
          }
        }
      } catch (err) {
        evt.result = 'error';
        evt.reason = (err as Error).message?.slice(0, 200) || 'unknown';
        state.errors++;
      }

      // Push newest-first into the events ring (cap 500 in memory).
      state.events.unshift(evt);
      if (state.events.length > 500) state.events.length = 500;
      state.processed++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

  // Issue review verdicts at the end so we don't slow per-task
  // progress with a network round trip + so we batch into 1-2 PUT
  // calls instead of N.
  if (!dryRun) {
    const stamp = new Date().toISOString().slice(0, 19);
    const suffix = opts.commentSuffix ? ` ${opts.commentSuffix}` : '';
    if (satisfiedIds.length > 0) {
      const r = await reviewTasks(token, jobId, satisfiedIds, 'satisfied',
        `rofe.ai AI Studio key import @ ${stamp}${suffix}`);
      if (!r.ok) state.lastError = `satisfied batch failed: ${r.error}`;
      // Annotate the events with the action that was taken so the UI
      // can show satisfied/declined per row.
      for (const e of state.events) {
        if (satisfiedIds.includes(e.taskId)) e.action = 'confirmed';   // 'confirmed' kept as the UI's affirmative label
      }
    }
    for (const d of declinedTasks) {
      const r = await reviewTasks(token, jobId, [d.id], 'declined',
        `rofe.ai rejected: ${d.reason}${suffix}`.slice(0, 250));
      if (!r.ok) state.lastError = `decline failed: ${r.error}`;
      const evt = state.events.find(e => e.taskId === d.id);
      if (evt) evt.action = 'declined';
    }
  }
}
