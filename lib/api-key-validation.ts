/**
 * Permanent-failure detection for harvested API keys.
 *
 * Google returns several distinct error strings that all mean
 * "this key will never work again, stop trying" — but the previous
 * filter only matched one of them ("denied access"). Keys hitting any
 * of the others stayed in rotation forever, eating threads and proxy
 * slots on guaranteed failures. We saw ~50% of the ~3k harvested
 * keys in this state in a live sample on 2026-05-14, which translated
 * directly into a ~70% embedding-job error rate.
 *
 * Treat any of these as terminal: the policy across runtime
 * (lib/embeddings.ts) and import-time (lib/ai-studio-key-import.ts)
 * is to DELETE the offending row from xgodo_api_keys rather than
 * just flip status='invalid'. We never need to keep a permanently-
 * dead key around — xgodo workers harvest infinite replacements and
 * the UNIQUE (service, key) constraint prevents re-importing the
 * same dead key by accident.
 */

import { getPool } from './db';

/** Patterns we recognise as permanently dead. All match against the
 *  full error.message string from Google's API. */
const TERMINAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Project flagged / banned by Google's abuse system. Most common in
  // our harvested pool — they're nuked by the time we try to use them.
  { pattern: /denied access/i,                          label: 'project denied' },

  // Project / consumer admin-suspended. Different from "denied" but
  // equally terminal — no way back without contacting Google.
  { pattern: /has been suspended/i,                     label: 'consumer suspended' },

  // Gemini API not enabled on that GCP project. Could in principle be
  // fixed by the project owner, but we don't own these projects so
  // it's terminal for us.
  { pattern: /has not been used in project[^]*disabled/i,        label: 'api not enabled' },
  { pattern: /Gemini API has not been used in project/i,         label: 'api not enabled' },

  // Key revoked (operator deleted in console). Also unrecoverable.
  { pattern: /API key not valid/i,                      label: 'key revoked' },
  { pattern: /API_KEY_INVALID/i,                        label: 'key revoked' },

  // Some 403s come back without a more specific message — the status
  // alone is enough. Last-ditch catch so we don't keep a generic
  // PERMISSION_DENIED key in rotation either. RESOURCE_EXHAUSTED is
  // intentionally NOT here — those are transient bans, not deletes.
  { pattern: /PERMISSION_DENIED/i,                      label: 'permission denied' },
];

export interface TerminalDiagnosis {
  terminal: true;
  reason: string;
}
export interface TransientDiagnosis {
  terminal: false;
}

/** Classify an error message as terminal (delete the key) vs transient
 *  (don't). The reason label is logged + persisted via deleteKey() so
 *  operators can grep audit lines later. */
export function classifyKeyError(message: string): TerminalDiagnosis | TransientDiagnosis {
  if (!message) return { terminal: false };
  for (const { pattern, label } of TERMINAL_PATTERNS) {
    if (pattern.test(message)) return { terminal: true, reason: label };
  }
  return { terminal: false };
}

/** Hard-delete one key from xgodo_api_keys. Used by every code path
 *  that detects a terminal failure — both the runtime embedding worker
 *  and the import-time validator share this. Returns true if a row was
 *  actually removed (vs already gone / duplicate concurrent delete). */
export async function deleteApiKey(
  service: 'google_ai_studio' | 'youtube_data',
  key: string,
  reason: string,
): Promise<boolean> {
  try {
    const pool = await getPool();
    const r = await pool.query(
      `DELETE FROM xgodo_api_keys WHERE service = $1 AND key = $2`,
      [service, key],
    );
    const removed = (r.rowCount ?? 0) > 0;
    if (removed) {
      // Mask the key in logs — we don't want full keys in CloudWatch
      // even after they're dead, in case Google ever restores access.
      console.log(`[api-key] DELETED service=${service} key=${key.slice(0, 10)}…${key.slice(-4)} reason=${reason}`);
    }
    return removed;
  } catch (err) {
    console.error('[api-key] deleteApiKey failed:', (err as Error).message);
    return false;
  }
}
