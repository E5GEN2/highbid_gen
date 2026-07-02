// Shared transient-retry helper for the content-gen pipeline.
//
// A render touches ~700 gems across LLM calls, proxied YouTube captures, and DB
// queries. At normal churn rates SOME of those fail every run — 429/quota, proxy
// timeouts, a one-off malformed model JSON, a pgvector hiccup. These are EXPECTED
// operational events, not blockers: the production answer is retry-and-rotate, so
// no niche or beat is ever silently dropped over a transient failure. (Captures
// already rotate proxies internally; this helper covers the build + LLM layers
// that previously threw-and-dropped on the first failure.)

export interface RetryOpts {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Base backoff; grows linearly with attempt + jitter, capped at 8s. Default 3000. */
  baseDelayMs?: number;
  /** Classifier — return true to retry. Default: the broad transient regex below. */
  isTransient?: (err: unknown) => boolean;
  /** Short label for retry logs. */
  label?: string;
}

// Broad on purpose: the cost of one extra retry is tiny; the cost of dropping a
// niche is a re-render. Permanent errors (bad args, not-found) are matched by the
// per-call-site deny logic, not here.
const TRANSIENT = /failed to parse JSON|unexpected (token|end)|429|RESOURCE_EXHAUSTED|quota|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|HARD_TIMEOUT|YT_PAGE_UNAVAILABLE|THUMBS_UNLOADED|ERR_(TUNNEL|PROXY|TIMED_OUT|CONNECTION|NETWORK)|proxy|tunnel|socket hang up|\b50[234]\b|timeout|timed out|network|fetch failed/i;

export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return TRANSIENT.test(msg);
}

/** Run `fn`, retrying on transient failures with linear backoff + jitter. Throws
 *  the last error only after exhausting attempts (or on a non-transient error). */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 3000;
  const isTransient = opts.isTransient ?? isTransientError;
  const label = opts.label ?? 'op';
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === attempts) break;
      const delay = Math.min(8000, baseDelayMs * attempt + Math.random() * 300);
      const m = (err instanceof Error ? err.message : String(err)).slice(0, 120);
      console.warn(`[retry:${label}] attempt ${attempt}/${attempts} failed: ${m} — retrying in ${Math.round(delay)}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
