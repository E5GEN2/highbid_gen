/**
 * YouTube Data API v3 key importer.
 *
 * Mirror of lib/ai-studio-key-import.ts for the youtube_data service.
 * xgodo workers harvest fresh YouTube Data API v3 keys and submit them
 * as job_proof on tasks in a dedicated xgodo job. This module reviews
 * those submissions:
 *
 *   1. Fetch tasks awaiting employer review (status='pending').
 *   2. Parse each task's job_proof to extract the candidate key(s).
 *   3. Test each key against youtube/v3/i18nLanguages (cheapest valid
 *      call — 1 quota unit) via an xgodo residential proxy so Google
 *      doesn't see all our test traffic from Railway's egress IP.
 *   4. Good key  → INSERT into xgodo_api_keys (service='youtube_data')
 *                  + mark xgodo task 'confirmed'.
 *   5. Bad key   → mark xgodo task 'declined' with a brief reason.
 *
 * Same review API the data-collection sync uses, so we're exercising a
 * path xgodo's already happy with.
 */

import { getPool } from './db';
import { getRandomProxy } from './xgodo-proxy';
import { ytFetchViaProxy } from './yt-proxy-fetch';

const XGODO_API = 'https://xgodo.com/api/v2';

/** The YouTube Data API key job — passed in from caller normally,
 *  exported here as the operator's default. */
export const DEFAULT_YT_DATA_KEY_JOB_ID = '69f49af26730e5906b239f36';

/** Standard Google API key shape: AIzaSy + 33 chars. YT data keys
 *  use the same prefix as AI Studio keys — the service-side scope is
 *  what differs, not the format. */
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

export interface YtDataKeyImportEvent {
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

export interface YtDataKeyImportProgress {
  total: number;
  processed: number;
  valid: number;
  invalid: number;
  duplicate: number;
  noKey: number;
  errors: number;
  events: YtDataKeyImportEvent[];  // newest-first
  running: boolean;
  jobKey: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

/** Read xgodo bearer for the YT Data key job. Falls back through the
 *  same key chain getXgodoToken() uses elsewhere, plus the env var. */
async function getXgodoToken(): Promise<string> {
  const pool = await getPool();
  for (const k of [
    'xgodo_yt_data_keys_token',     // dedicated for this job, if set
    'xgodo_ai_studio_keys_token',   // same xgodo account works for both jobs
    'xgodo_niche_spy_token',
    'xgodo_api_token',
    'xgodo_admin_token',
  ]) {
    const r = await pool.query("SELECT value FROM admin_config WHERE key = $1", [k]);
    if (r.rows[0]?.value) return r.rows[0].value;
  }
  return process.env.XGODO_API_TOKEN || '';
}

/** Fetch tasks awaiting employer review for the given xgodo job. */
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

/** PUT /jobs/applicants with the review verdict. xgodo's valid
 *  statuses are 'confirmed' | 'notcomplete' | 'declined' | 'pending'. */
async function reviewTasks(
  token: string,
  jobId: string,
  taskIds: string[],
  status: 'confirmed' | 'declined',
  comment: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (taskIds.length === 0) return { ok: true, status: 200 };
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
  if (typeof proof === 'string') {
    try { scan(JSON.parse(proof)); } catch { /* ignore */ }
  }
  return Array.from(new Set(candidates));
}

function maskKey(key: string): string {
  if (key.length < 12) return '***';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

type KeyTestVerdict = 'valid' | 'invalid' | 'error';

/** Hit YouTube Data API v3 i18nLanguages via xgodo proxy. Cheapest
 *  valid call — 1 quota unit per request, returns a small static list
 *  so payload-size isn't a factor.
 *
 *   200 + items[] populated   → 'valid'
 *   400 / 401 / 403 (auth msg) → 'invalid'  (Google rejected the key —
 *                                            wrong key, no YouTube Data
 *                                            scope, billing not enabled,
 *                                            etc.)
 *   network / timeout / 5xx    → 'error'    (proxy or transient)
 *
 * Quota-exceeded (403 with 'quotaExceeded' reason) is also returned as
 * 'invalid' because a brand-new key from xgodo shouldn't have any
 * quota usage — if it does, something's wrong with the key or it was
 * already burned.
 */
async function testKey(key: string, proxy?: { url: string; deviceId: string }): Promise<{
  verdict: KeyTestVerdict;
  reason: string;
  latencyMs: number;
  proxyUsed: string;
}> {
  const url = `https://www.googleapis.com/youtube/v3/i18nLanguages?part=snippet&key=${encodeURIComponent(key)}`;
  const t0 = Date.now();
  const pair = proxy ? {
    key: '',                          // unused by ytFetchViaProxy
    proxyUrl: proxy.url,
    proxyDeviceId: proxy.deviceId,
    banned: false,
    banExpiry: 0,
  } : undefined;
  const res = await ytFetchViaProxy(url, pair);
  const latencyMs = Date.now() - t0;
  const proxyUsed = res.proxyUsed || proxy?.deviceId || '?';
  const data = res.data as {
    items?: Array<{ id?: string }>;
    error?: { code?: number; message?: string; status?: string; errors?: Array<{ reason?: string }> };
  } | null;

  // Happy path
  if (res.ok && Array.isArray(data?.items) && data.items.length > 0) {
    return { verdict: 'valid', reason: `${data.items.length} i18nLanguages returned`, latencyMs, proxyUsed };
  }
  // Google authoritative reject (auth error envelope present)
  if ((res.status === 400 || res.status === 401 || res.status === 403) && data?.error?.message) {
    const reason = data.error.errors?.[0]?.reason;
    const prefix = reason ? `[${reason}] ` : '';
    return { verdict: 'invalid', reason: (prefix + data.error.message).slice(0, 200), latencyMs, proxyUsed };
  }
  // Network-side curl errors come back through ytFetchViaProxy as
  // {ok:false, status:0, error:'curl exit N: ...'} — those are PROXY
  // failures, not key invalidations. Treat as 'error' and let the
  // operator re-run later.
  if (res.error && /curl exit \d+/.test(res.error)) {
    return { verdict: 'error', reason: `proxy/network: ${res.error.slice(0, 160)}`, latencyMs, proxyUsed };
  }
  // Timeout / no response / unexpected payload — also inconclusive.
  return { verdict: 'error', reason: `inconclusive: ${res.error || (res.status ? `HTTP ${res.status}` : 'no response')}`, latencyMs, proxyUsed };
}

/** Insert one validated key into our inventory. Idempotent via
 *  (service, key) unique constraint. Returns the row id, or null if it
 *  was already there. */
async function persistKey(key: string, sourceMeta: Record<string, unknown>): Promise<{ insertedId: number | null; duplicate: boolean }> {
  const pool = await getPool();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO xgodo_api_keys (service, key, source, status, added_at)
     VALUES ('youtube_data', $1, 'xgodo-import', 'active', NOW())
     ON CONFLICT (service, key) DO NOTHING
     RETURNING id`,
    [key],
  );
  if (r.rows.length === 0) return { insertedId: null, duplicate: true };
  void sourceMeta;
  return { insertedId: r.rows[0].id, duplicate: false };
}

// ─────────────────────────────────────────────────────────────────────
// Orchestrator + in-memory state. Runs independently of the AI Studio
// importer — both can be live at the same time without contention.
// ─────────────────────────────────────────────────────────────────────

let state: YtDataKeyImportProgress = {
  total: 0, processed: 0, valid: 0, invalid: 0, duplicate: 0, noKey: 0, errors: 0,
  events: [], running: false, jobKey: null,
  startedAt: null, finishedAt: null, lastError: null,
};
let inFlight = false;

export function getYtDataKeyImportState(): YtDataKeyImportProgress {
  return state;
}

export interface RunImportOpts {
  jobId?: string;
  limit?: number;        // max tasks to pull from xgodo in this run
  concurrency?: number;  // how many keys to test in parallel
  dryRun?: boolean;      // skip the xgodo confirm/decline call
  commentSuffix?: string;
}

export function startYtDataKeyImport(opts: RunImportOpts = {}): { started: boolean; jobKey?: string } {
  if (inFlight) return { started: false, jobKey: state.jobKey ?? undefined };
  const jobKey = `ytkeys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  inFlight = true;
  state = {
    total: 0, processed: 0, valid: 0, invalid: 0, duplicate: 0, noKey: 0, errors: 0,
    events: [], running: true, jobKey,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
  };
  (async () => {
    try {
      await runImport(opts);
    } catch (err) {
      state.lastError = (err as Error).message?.slice(0, 500) || 'unknown';
      console.error('[ytkeys] import failed:', err);
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      inFlight = false;
    }
  })();
  return { started: true, jobKey };
}

async function runImport(opts: RunImportOpts): Promise<void> {
  const jobId = opts.jobId ?? DEFAULT_YT_DATA_KEY_JOB_ID;
  const limit = Math.min(opts.limit ?? 100, 5000);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 5, 20));
  const dryRun = !!opts.dryRun;

  const token = await getXgodoToken();
  if (!token) throw new Error('xgodo bearer not configured (admin_config.xgodo_niche_spy_token / .xgodo_api_token)');

  const tasks = await fetchPendingTasks(token, jobId, limit);
  state.total = tasks.length;
  if (tasks.length === 0) return;

  const satisfiedIds: string[] = [];
  const declinedTasks: Array<{ id: string; reason: string }> = [];

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      const task = tasks[i];
      const finishedIso = task.finished || null;
      const evt: YtDataKeyImportEvent = {
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
          // Test each candidate key against YouTube Data API. We
          // accumulate the strongest verdict across multiple keys in a
          // single task (workers sometimes submit several):
          // valid > duplicate > invalid > error.
          let anyValid = false;
          let anyDuplicate = false;
          let anyInvalid = false;
          let anyNetError = false;
          let lastReason = 'no test completed';
          let firstInsertedId: number | null = null;
          for (const key of keys) {
            evt.key = maskKey(key);
            evt.keyFull = key;
            const proxy = await getRandomProxy();
            const test = await testKey(key, proxy ? { url: proxy.url, deviceId: proxy.deviceId } : undefined);
            evt.latencyMs = test.latencyMs;
            evt.proxyUsed = test.proxyUsed;
            lastReason = test.reason;
            if (test.verdict === 'valid') {
              const p = await persistKey(key, {
                taskId: task._id, jobId, worker: task.worker_name, device: task.device_name,
              });
              if (p.duplicate) anyDuplicate = true;
              else { anyValid = true; firstInsertedId = firstInsertedId ?? p.insertedId; }
            } else if (test.verdict === 'invalid') {
              anyInvalid = true;
            } else {
              anyNetError = true;
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
            declinedTasks.push({ id: task._id, reason: 'duplicate key — already in inventory' });
            state.duplicate++;
          } else if (anyInvalid && !anyNetError) {
            evt.result = 'invalid';
            evt.reason = lastReason;
            declinedTasks.push({ id: task._id, reason: lastReason.slice(0, 100) });
            state.invalid++;
          } else {
            evt.result = 'error';
            evt.reason = lastReason;
            evt.action = 'skipped';
            state.errors++;
          }
        }
      } catch (err) {
        evt.result = 'error';
        evt.reason = (err as Error).message?.slice(0, 200) || 'unknown';
        state.errors++;
      }

      state.events.unshift(evt);
      if (state.events.length > 500) state.events.length = 500;
      state.processed++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

  if (!dryRun) {
    const stamp = new Date().toISOString().slice(0, 19);
    const suffix = opts.commentSuffix ? ` ${opts.commentSuffix}` : '';
    if (satisfiedIds.length > 0) {
      const r = await reviewTasks(token, jobId, satisfiedIds, 'confirmed',
        `rofe.ai YT Data key import @ ${stamp}${suffix}`);
      if (!r.ok) state.lastError = `confirm batch failed: ${r.error}`;
      for (const e of state.events) {
        if (satisfiedIds.includes(e.taskId)) e.action = 'confirmed';
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
