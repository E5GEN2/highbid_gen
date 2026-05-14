/**
 * One-shot pool validation for service='google_ai_studio' keys.
 *
 * The import tool used to validate keys by hitting /v1beta/models — a
 * permissive call that doesn't catch project-level bans or projects
 * where the Gemini API isn't enabled. That left a lot of "active"
 * rows in xgodo_api_keys that fail at runtime on the actual
 * batchEmbedContents endpoint, dragging the embedding worker's error
 * rate up. A live sample on 2026-05-14 showed ~50% of the pool was
 * dead in this way.
 *
 * This module re-validates every active key against the real
 * embedding endpoint via testKey() and DELETEs anything classified as
 * terminal (project denied, consumer suspended, API not enabled, key
 * revoked). Transient errors (proxy / curl exits / 5xx) leave the
 * row alone so we don't nuke healthy keys over a flaky proxy.
 *
 * Fire-and-forget like the import job. Module-scope state holds the
 * in-flight progress for the admin UI to poll.
 */

import { getPool } from './db';
import { getRandomProxy } from './xgodo-proxy';
import { testKey } from './ai-studio-key-import';
import { deleteApiKey } from './api-key-validation';

export interface ValidateEvent {
  key: string;             // masked
  verdict: 'valid' | 'invalid' | 'error';
  reason: string;
  latencyMs: number | null;
  proxyUsed: string | null;
  action: 'kept' | 'deleted' | 'skipped';
  detectedAt: string;
}

export interface ValidateProgress {
  total: number;
  processed: number;
  valid: number;
  invalid: number;
  errors: number;
  deleted: number;
  events: ValidateEvent[];   // newest-first, capped 500
  running: boolean;
  jobKey: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

let state: ValidateProgress = {
  total: 0, processed: 0, valid: 0, invalid: 0, errors: 0, deleted: 0,
  events: [], running: false, jobKey: null,
  startedAt: null, finishedAt: null, lastError: null,
};
let inFlight = false;

function maskKey(k: string): string {
  if (k.length < 12) return '***';
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

export function getValidateState(): ValidateProgress {
  return state;
}

export interface RunValidateOpts {
  /** Limit the scan to the first N keys. 0/undefined = all. */
  limit?: number;
  /** Worker pool size. Each worker tests one key at a time; ~5s/key
   *  on a healthy proxy so concurrency=20 puts a 3k pool at ~12 min. */
  concurrency?: number;
  /** Dry run: classify keys but skip the DELETE step. Useful for
   *  sanity-checking the pattern set before mass-removing rows. */
  dryRun?: boolean;
}

export function startValidate(opts: RunValidateOpts = {}): { started: boolean; jobKey?: string } {
  if (inFlight) return { started: false, jobKey: state.jobKey ?? undefined };
  const jobKey = `aikeysval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  inFlight = true;
  state = {
    total: 0, processed: 0, valid: 0, invalid: 0, errors: 0, deleted: 0,
    events: [], running: true, jobKey,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
  };
  (async () => {
    try {
      await runValidate(opts);
    } catch (err) {
      state.lastError = (err as Error).message?.slice(0, 500) || 'unknown';
      console.error('[aikeysval] validation failed:', err);
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      inFlight = false;
    }
  })();
  return { started: true, jobKey };
}

async function runValidate(opts: RunValidateOpts): Promise<void> {
  const pool = await getPool();
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 20, 40));
  const dryRun = !!opts.dryRun;

  const limitClause = (opts.limit && opts.limit > 0) ? `LIMIT ${opts.limit}` : '';
  const r = await pool.query<{ key: string }>(
    `SELECT key FROM xgodo_api_keys
      WHERE service = 'google_ai_studio' AND status = 'active'
      ORDER BY id ASC ${limitClause}`,
  );
  const keys = r.rows.map(row => row.key);
  state.total = keys.length;
  if (keys.length === 0) return;

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= keys.length) return;
      const key = keys[i];

      const evt: ValidateEvent = {
        key: maskKey(key),
        verdict: 'error',
        reason: '',
        latencyMs: null,
        proxyUsed: null,
        action: 'skipped',
        detectedAt: new Date().toISOString(),
      };
      try {
        const proxy = await getRandomProxy();
        const test = await testKey(key,
          proxy ? { url: proxy.url, deviceId: proxy.deviceId } : undefined);
        evt.verdict   = test.verdict;
        evt.reason    = test.reason;
        evt.latencyMs = test.latencyMs;
        evt.proxyUsed = test.proxyUsed;

        if (test.verdict === 'valid') {
          evt.action = 'kept';
          state.valid++;
        } else if (test.verdict === 'invalid') {
          if (dryRun) {
            evt.action = 'skipped';
            evt.reason = `[dry-run] would delete: ${test.reason}`;
          } else {
            const removed = await deleteApiKey('google_ai_studio', key, test.reason.slice(0, 80));
            evt.action = removed ? 'deleted' : 'skipped';
            if (removed) state.deleted++;
          }
          state.invalid++;
        } else {
          evt.action = 'skipped';
          state.errors++;
        }
      } catch (err) {
        evt.verdict = 'error';
        evt.reason  = (err as Error).message?.slice(0, 200) || 'unknown';
        state.errors++;
      }

      state.events.unshift(evt);
      if (state.events.length > 500) state.events.length = 500;
      state.processed++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, () => worker()));
}
