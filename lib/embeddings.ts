/**
 * Google Text + Image Embedding API client.
 *
 * Default model: gemini-embedding-001 (text only, 3072 dimensions).
 * Multimodal model: gemini-embedding-2-preview (text + image, 3072 dimensions).
 *
 * Each API key is paired with a dedicated proxy device.
 * Routes via curl subprocess through xgodo mobile proxies.
 */

import { getPool } from './db';
import { getProxies } from './xgodo-proxy';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { classifyKeyError, deleteApiKey } from './api-key-validation';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

// The four things we can embed. Each maps to a model + a niche_spy_videos
// column + a stamp column. Callers pick a target and we route everything
// accordingly.
//   title_v1     — legacy text-only embedding (kept for back-compat)
//   title_v2     — gemini v2 text embedding
//   thumbnail_v2 — gemini v2 image embedding
//   combined_v2  — gemini v2 multimodal embedding: title + thumbnail packed
//                  into a single content with two parts, producing ONE
//                  vector that captures both the visual style and the
//                  promise of the title in one space. Better for "find
//                  similar Shorts that pitch the same hook with the same
//                  visual energy" than either signal alone.
export type EmbeddingTarget = 'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined_v2';

export interface TargetConfig {
  model: string;
  column: string;       // niche_spy_videos column storing the vector
  stampColumn: string;  // timestamp column storing when it was last embedded
}

export const TARGET_CONFIG: Record<EmbeddingTarget, TargetConfig> = {
  title_v1:     { model: 'gemini-embedding-001',       column: 'title_embedding',        stampColumn: 'embedded_at' },
  title_v2:     { model: 'gemini-embedding-2-preview', column: 'title_embedding_v2',     stampColumn: 'title_embedded_v2_at' },
  thumbnail_v2: { model: 'gemini-embedding-2-preview', column: 'thumbnail_embedding_v2', stampColumn: 'thumbnail_embedded_v2_at' },
  combined_v2:  { model: 'gemini-embedding-2-preview', column: 'combined_embedding_v2',  stampColumn: 'combined_embedded_v2_at' },
};

// --- Key-Proxy Pair Management ---

interface KeyProxyPair {
  key: string;
  proxyUrl: string;
  proxyDeviceId: string;
  banned: boolean;
  banExpiry: number;
}

let pairs: KeyProxyPair[] = [];
let pairIndex = 0;
let lastPairBuild = 0;
const PAIR_CACHE_TTL = 60 * 1000;
const BAN_DURATION = 5 * 60 * 1000;

/** One-shot auto-migration: copy any keys from the legacy
 *  niche_google_api_keys admin_config newline-string into the
 *  xgodo_api_keys table (service='google_ai_studio'). Idempotent
 *  via UNIQUE (service, key). Runs at most once per Node process. */
let legacyMigrated = false;
async function migrateLegacyOnce(): Promise<void> {
  if (legacyMigrated) return;
  legacyMigrated = true;
  try {
    const pool = await getPool();
    const r = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_google_api_keys'");
    const raw: string = r.rows[0]?.value || '';
    const keys = raw.split('\n').map(k => k.trim()).filter(k => /^AIzaSy[A-Za-z0-9_-]{33}$/.test(k));
    if (keys.length === 0) return;
    let migrated = 0;
    for (const k of keys) {
      const ins = await pool.query(
        `INSERT INTO xgodo_api_keys (service, key, source, status)
         VALUES ('google_ai_studio', $1, 'legacy', 'active')
         ON CONFLICT (service, key) DO NOTHING RETURNING id`,
        [k],
      );
      if (ins.rowCount && ins.rowCount > 0) migrated += 1;
    }
    if (migrated > 0) console.log(`[embedding] Migrated ${migrated} legacy key(s) from niche_google_api_keys → xgodo_api_keys`);
  } catch (err) {
    console.error('[embedding] legacy migration failed:', (err as Error).message);
  }
}

async function buildPairs(): Promise<KeyProxyPair[]> {
  if (Date.now() - lastPairBuild < PAIR_CACHE_TTL && pairs.length > 0) return pairs;

  await migrateLegacyOnce();
  const pool = await getPool();

  // Active, not-currently-banned keys. The banned_until < NOW() test
  // means temporarily-banned keys re-enter automatically on cooloff
  // expiry — no separate unban job needed.
  const tableRes = await pool.query<{ key: string; banned_until: Date | null }>(
    `SELECT key, banned_until
       FROM xgodo_api_keys
      WHERE service = 'google_ai_studio'
        AND status = 'active'
      ORDER BY id ASC`,
  );
  const keys: string[] = tableRes.rows.map(r => r.key);

  const proxies = await getProxies();

  if (keys.length === 0) {
    pairs = [];
    lastPairBuild = Date.now();
    return pairs;
  }

  // DB-side bans seeded into in-memory state so a key banned by another
  // worker 2 minutes ago doesn't get picked again here.
  const banMap = new Map<string, number>();
  for (const r of tableRes.rows) {
    if (r.banned_until && r.banned_until.getTime() > Date.now()) {
      banMap.set(r.key, r.banned_until.getTime());
    }
  }

  const newPairs: KeyProxyPair[] = [];
  for (let i = 0; i < keys.length; i++) {
    const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
    const existing = pairs.find(p => p.key === keys[i]);
    const dbBanExpiry = banMap.get(keys[i]) ?? 0;
    const inMemBanExpiry = (existing?.banned && existing.banExpiry > Date.now()) ? existing.banExpiry : 0;
    const banExpiry = Math.max(dbBanExpiry, inMemBanExpiry);
    newPairs.push({
      key: keys[i],
      proxyUrl: proxy?.url || '',
      proxyDeviceId: proxy?.deviceId?.substring(0, 8) || 'direct',
      banned: banExpiry > Date.now(),
      banExpiry,
    });
  }

  pairs = newPairs;
  lastPairBuild = Date.now();
  console.log(`[embedding] Built ${pairs.length} key-proxy pairs (${proxies.length} proxies available)`);
  return pairs;
}

/**
 * Pick a random pair from the currently-unbanned set.
 *
 * Why random over round-robin: bench data with 30 threads × 75 batches
 * showed random pick (85% success) beats round-robin (75%) and pinned-
 * per-thread (16% — current production behavior). The dominant failure
 * mode is flaky proxies, not API rate limits — so the question is just
 * "how do we minimise multiple workers landing on the same broken
 * proxy in close succession?". Linear round-robin amplifies that
 * (workers march into a bad neighbourhood in sequence); random spreads
 * collisions.
 *
 * On all-banned, falls back to the pair whose ban expires soonest so
 * the worker has the shortest possible wait.
 */
async function pickRandomActivePair(): Promise<KeyProxyPair> {
  const allPairs = await buildPairs();
  if (allPairs.length === 0) throw new Error('No Google API keys configured. Add them in Admin > Niche Explorer.');

  const now = Date.now();
  const active = allPairs.filter(p => !p.banned || now > p.banExpiry);
  if (active.length > 0) {
    const pick = active[Math.floor(Math.random() * active.length)];
    if (pick.banned && now > pick.banExpiry) pick.banned = false;
    return pick;
  }
  // Everyone banned — return shortest-wait so the worker has minimal idle.
  let best = allPairs[0];
  for (const p of allPairs) if (p.banExpiry < best.banExpiry) best = p;
  console.log(`[embedding] ALL BANNED, forcing key=${best.key.substring(0, 10)}... proxy=${best.proxyDeviceId}`);
  return best;
}

/** @deprecated kept as a thin wrapper for any caller that still imports
 *  it. New code should let batchEmbedInputs do the picking. */
async function getNextPair(): Promise<KeyProxyPair> {
  return pickRandomActivePair();
}

export function banKey(key: string): void {
  const pair = pairs.find(p => p.key === key);
  const expiry = Date.now() + BAN_DURATION;
  if (pair) {
    pair.banned = true;
    pair.banExpiry = expiry;
    console.log(`[embedding] Banned key=${key.substring(0, 10)}... proxy=${pair.proxyDeviceId} for 5min`);
  }
  // Persist to DB so the cooloff survives Node restarts and is visible
  // to siblings. Fire-and-forget — failure to persist isn't fatal.
  (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys
            SET banned_until = to_timestamp($1 / 1000.0),
                last_used_at = NOW()
          WHERE service = 'google_ai_studio' AND key = $2`,
        [expiry, key],
      );
    } catch (err) {
      console.error('[embedding] persist ban failed:', (err as Error).message);
    }
  })();
}


/** Mark a key as permanently invalid (e.g. 400 invalid_api_key responses).
 *  Drops it out of the rotation forever — operator can re-enable via SQL. */
export async function invalidateKey(key: string, reason?: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE xgodo_api_keys
        SET status = 'invalid',
            invalidated_at = NOW()
      WHERE service = 'google_ai_studio' AND key = $1 AND status = 'active'`,
    [key],
  );
  console.log(`[embedding] Invalidated key=${key.substring(0, 10)}...${reason ? ` reason="${reason}"` : ''}`);
  lastPairBuild = 0;  // force rebuild on next call
}

/**
 * Legacy config — kept for backward compatibility with /admin and older callers.
 * New code should pick a target via batchEmbedInputs.
 */
async function getLegacyModel(): Promise<string> {
  const pool = await getPool();
  const res = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_embedding_model'");
  return res.rows[0]?.value || 'gemini-embedding-001';
}

// --- Embedding API ---

/**
 * @deprecated Per-thread pinned-slot picker. The bench (30 threads ×
 * 75 batches each) showed this strategy lands at 16% success rate
 * because the threads pinned to flaky-proxy slots can't escape them.
 * Replaced by random pick from active set (85% success in the same
 * bench). Kept exported as a no-op-ish wrapper around the new picker
 * in case any external code still imports it; new code should not
 * reference threadIdx at all.
 */
export async function getPairForThread(_threadIdx: number): Promise<KeyProxyPair | null> {
  try { return await pickRandomActivePair(); } catch { return null; }
}

export type EmbedInput =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };   // data is base64

/**
 * Generic batch embed — accepts mixed text/image inputs and a model name.
 * This is the new primary entrypoint; batchEmbed is kept as a thin wrapper for
 * backward compat.
 *
 * The optional `fixedPairIdx` parameter is now ignored — picker always
 * randomises across the active pair set per bench results. Kept in the
 * signature so existing callers don't need updates in lockstep.
 */
export async function batchEmbedInputs(
  inputs: EmbedInput[],
  model: string,
  _fixedPairIdx?: number,
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  if (inputs.length > 100) throw new Error('Batch limit is 100 items');

  const pair = await pickRandomActivePair();

  const fs = await import('fs');
  const os = await import('os');
  const inputData = JSON.stringify({ inputs, key: pair.key, model, proxy: pair.proxyUrl });
  const tmpFile = path.join(os.tmpdir(), `embed_input_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, inputData);

  let rawOut: string | Buffer, rawErr: string | Buffer;
  try {
    const result = await execFileAsync(
      'python3',
      [path.join(SCRIPTS_DIR, 'embed-batch.py'), tmpFile],
      { timeout: 75000, maxBuffer: 200 * 1024 * 1024 }   // slightly above the curl --max-time 60
    );
    rawOut = result.stdout;
    rawErr = result.stderr;
  } catch (err) {
    // embed-batch.py exits 1 on Google API errors but still prints the
    // structured error JSON to stdout. execFileAsync throws on the
    // non-zero exit — but if we have the JSON we want to fall through
    // and route it through the same parse + classify path as the
    // success case (otherwise classifyKeyError below is unreachable
    // for the API-error path and dead keys stay in rotation forever).
    const e = err as { stderr?: string; stdout?: string; message?: string };
    if (e.stdout && String(e.stdout).trim().startsWith('{')) {
      rawOut = e.stdout;
      rawErr = e.stderr ?? '';
    } else {
      // True subprocess failure — no JSON to classify, surface as-is.
      fs.unlinkSync(tmpFile);
      const detail = e.stderr?.substring(0, 300) || e.message?.substring(0, 300);
      throw new Error(`Python embed failed: ${detail}`);
    }
  }
  fs.unlinkSync(tmpFile);
  const stdout = String(rawOut);
  const stderr = String(rawErr);

  if (stderr) console.log('[embedding] stderr:', stderr.substring(0, 200));

  let result: number[][] | { error: string };
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse embedding output: ${stdout.substring(0, 200)}`);
  }

  if (!Array.isArray(result)) {
    const errMsg = (result as { error: string }).error || 'Unknown embedding error';
    // 429 / RESOURCE_EXHAUSTED is transient → 5-min cooloff via banKey.
    // Everything matched by classifyKeyError() is terminal → hard delete
    // the row from xgodo_api_keys so future thread pulls don't see it.
    // Order matters: check transient FIRST so a key that's just been
    // 429'd doesn't fall through into the terminal classifier on a stray
    // status-string match.
    if (errMsg.includes('API 429') || errMsg.includes('"code": 429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
      // The 429 body sometimes embeds `consumer 'project_number:N'` —
      // tempting to interpret as a real project number to ban siblings
      // by. In practice the pool is from many independent Google
      // accounts and that field is a templated value that usually just
      // means the key itself is banned. So we treat 429 as a per-key
      // cooloff only; broader project-level bans would punish unrelated
      // keys that happen to share an arbitrary template.
      banKey(pair.key);
    } else {
      const verdict = classifyKeyError(errMsg);
      if (verdict.terminal) {
        deleteApiKey('google_ai_studio', pair.key, verdict.reason)
          .then((removed) => { if (removed) lastPairBuild = 0; })
          .catch(() => { /* fire-and-forget */ });
      }
    }
    throw new Error(errMsg);
  }

  return result;
}

/**
 * Grouped batch embed — each `group` is an array of EmbedInputs that
 * become the `parts` of a single content, producing ONE embedding per
 * group (vs `batchEmbedInputs` which produces one per input).
 *
 * Used by the `combined_v2` target: each video becomes a 2-part group
 * (title text + thumbnail image), yielding one joint multimodal vector.
 *
 * Returns embeddings in the same order as the input groups.
 */
export async function batchEmbedGrouped(
  groups: EmbedInput[][],
  model: string,
): Promise<number[][]> {
  if (groups.length === 0) return [];
  if (groups.length > 100) throw new Error('Batch limit is 100 groups');

  const pair = await pickRandomActivePair();

  const fs = await import('fs');
  const os = await import('os');
  const inputData = JSON.stringify({ groups, key: pair.key, model, proxy: pair.proxyUrl });
  const tmpFile = path.join(os.tmpdir(), `embed_grouped_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, inputData);

  let rawOut: string | Buffer;
  try {
    const result = await execFileAsync(
      'python3',
      [path.join(SCRIPTS_DIR, 'embed-batch.py'), tmpFile],
      { timeout: 90_000, maxBuffer: 200 * 1024 * 1024 }
    );
    rawOut = result.stdout;
  } catch (err) {
    // Same catch-but-recover pattern as batchEmbedInputs — embed-batch.py
    // exits 1 on API errors but the structured error JSON is in
    // err.stdout; route it through the classifier instead of bailing.
    const e = err as { stderr?: string; stdout?: string; message?: string };
    if (e.stdout && String(e.stdout).trim().startsWith('{')) {
      rawOut = e.stdout;
    } else {
      fs.unlinkSync(tmpFile);
      const detail = e.stderr?.substring(0, 300) || e.message?.substring(0, 300);
      throw new Error(`Python embed (grouped) failed: ${detail}`);
    }
  }
  fs.unlinkSync(tmpFile);
  const stdout = String(rawOut);

  let result: number[][] | { error: string };
  try { result = JSON.parse(stdout); }
  catch { throw new Error(`Failed to parse grouped embedding output: ${stdout.substring(0, 200)}`); }

  if (!Array.isArray(result)) {
    const errMsg = (result as { error: string }).error || 'Unknown embedding error';
    // Transient first (so 429 keys aren't accidentally deleted on a
    // PERMISSION_DENIED status string in the body), then terminal
    // classification → hard DELETE. Mirrors batchEmbedInputs.
    if (errMsg.includes('API 429') || errMsg.includes('"code": 429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
      // Per-key cooloff only — see note in batchEmbedGrouped.
      banKey(pair.key);
    } else {
      const verdict = classifyKeyError(errMsg);
      if (verdict.terminal) {
        deleteApiKey('google_ai_studio', pair.key, verdict.reason)
          .then((removed) => { if (removed) lastPairBuild = 0; })
          .catch(() => { /* fire-and-forget */ });
      }
    }
    throw new Error(errMsg);
  }
  return result;
}

/**
 * Backward-compatible text-only batch embed. Uses the legacy
 * admin_config.niche_embedding_model (defaults to gemini-embedding-001).
 */
export async function batchEmbed(texts: string[], fixedPairIdx?: number): Promise<number[][]> {
  const model = await getLegacyModel();
  const inputs: EmbedInput[] = texts.map(t => ({ type: 'text', text: t }));
  return batchEmbedInputs(inputs, model, fixedPairIdx);
}

export async function embedText(text: string): Promise<number[]> {
  const results = await batchEmbed([text]);
  return results[0] || [];
}

// --- Status ---

export async function getKeyStatus(): Promise<Array<{ key: string; proxy: string; banned: boolean; banExpiresIn: number | null }>> {
  const allPairs = await buildPairs();
  const now = Date.now();
  return allPairs.map(p => ({
    key: p.key.substring(0, 10) + '...' + p.key.substring(p.key.length - 4),
    proxy: p.proxyDeviceId,
    banned: p.banned && now < p.banExpiry,
    banExpiresIn: p.banned && now < p.banExpiry ? Math.round((p.banExpiry - now) / 1000) : null,
  }));
}

/**
 * Stats across all three embedding targets.
 * For each target we expose: totalVideos, embedded count, and notEmbedded count.
 * notEmbedded excludes rows that can't be embedded (missing title/thumbnail).
 */
export async function getEmbeddingStats(): Promise<{
  apiKeysConfigured: number;
  legacyModel: string;
  targets: Record<EmbeddingTarget, { totalVideos: number; embedded: number; notEmbedded: number }>;
}> {
  const pool = await getPool();
  const allPairs = await buildPairs();
  const legacyModel = await getLegacyModel();

  const statsRes = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE title_embedding IS NOT NULL)          AS e_title_v1,
      COUNT(*) FILTER (WHERE title_embedding_v2 IS NOT NULL)       AS e_title_v2,
      COUNT(*) FILTER (WHERE thumbnail_embedding_v2 IS NOT NULL)   AS e_thumb_v2,
      COUNT(*) FILTER (WHERE combined_embedding_v2 IS NOT NULL)    AS e_combined_v2,
      COUNT(*) FILTER (WHERE title_embedding IS NULL          AND title IS NOT NULL AND title != '') AS ne_title_v1,
      COUNT(*) FILTER (WHERE title_embedding_v2 IS NULL       AND title IS NOT NULL AND title != '') AS ne_title_v2,
      COUNT(*) FILTER (WHERE thumbnail_embedding_v2 IS NULL
                       AND (thumbnail IS NOT NULL AND thumbnail != '' OR url IS NOT NULL AND url != '')) AS ne_thumb_v2,
      COUNT(*) FILTER (WHERE combined_embedding_v2 IS NULL
                       AND title IS NOT NULL AND title != ''
                       AND (thumbnail IS NOT NULL AND thumbnail != '' OR url IS NOT NULL AND url != '')) AS ne_combined_v2
    FROM niche_spy_videos
  `);
  const r = statsRes.rows[0];
  const total = parseInt(r.total);

  return {
    apiKeysConfigured: allPairs.length,
    legacyModel,
    targets: {
      title_v1:     { totalVideos: total, embedded: parseInt(r.e_title_v1),     notEmbedded: parseInt(r.ne_title_v1) },
      title_v2:     { totalVideos: total, embedded: parseInt(r.e_title_v2),     notEmbedded: parseInt(r.ne_title_v2) },
      thumbnail_v2: { totalVideos: total, embedded: parseInt(r.e_thumb_v2),     notEmbedded: parseInt(r.ne_thumb_v2) },
      combined_v2:  { totalVideos: total, embedded: parseInt(r.e_combined_v2),  notEmbedded: parseInt(r.ne_combined_v2) },
    },
  };
}

/** Per-keyword coverage for all three targets (top N by total). */
export async function getKeywordCoverage(limit: number = 30): Promise<Array<{
  keyword: string;
  total: number;
  title_v1: { embedded: number; pct: number };
  title_v2: { embedded: number; pct: number };
  thumbnail_v2: { embedded: number; pct: number };
}>> {
  const pool = await getPool();
  const res = await pool.query(`
    SELECT keyword,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE title_embedding IS NOT NULL)        AS e_title_v1,
      COUNT(*) FILTER (WHERE title_embedding_v2 IS NOT NULL)     AS e_title_v2,
      COUNT(*) FILTER (WHERE thumbnail_embedding_v2 IS NOT NULL) AS e_thumb_v2
    FROM niche_spy_videos
    WHERE keyword IS NOT NULL
    GROUP BY keyword
    ORDER BY total DESC
    LIMIT $1
  `, [limit]);
  return res.rows.map(r => {
    const total = parseInt(r.total);
    const pct = (n: number) => total > 0 ? Math.round((n / total) * 100) : 0;
    const e1 = parseInt(r.e_title_v1);
    const e2 = parseInt(r.e_title_v2);
    const et = parseInt(r.e_thumb_v2);
    return {
      keyword: r.keyword,
      total,
      title_v1:     { embedded: e1, pct: pct(e1) },
      title_v2:     { embedded: e2, pct: pct(e2) },
      thumbnail_v2: { embedded: et, pct: pct(et) },
    };
  });
}
