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

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

// The three things we can embed — each one maps to a specific model + DB column
// + pgvector table, so callers pick a target and we route everything accordingly.
export type EmbeddingTarget = 'title_v1' | 'title_v2' | 'thumbnail_v2';

export interface TargetConfig {
  model: string;
  column: string;       // niche_spy_videos column storing the vector
  stampColumn: string;  // timestamp column storing when it was last embedded
}

export const TARGET_CONFIG: Record<EmbeddingTarget, TargetConfig> = {
  title_v1:     { model: 'gemini-embedding-001',       column: 'title_embedding',        stampColumn: 'embedded_at' },
  title_v2:     { model: 'gemini-embedding-2-preview', column: 'title_embedding_v2',     stampColumn: 'title_embedded_v2_at' },
  thumbnail_v2: { model: 'gemini-embedding-2-preview', column: 'thumbnail_embedding_v2', stampColumn: 'thumbnail_embedded_v2_at' },
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

async function buildPairs(): Promise<KeyProxyPair[]> {
  if (Date.now() - lastPairBuild < PAIR_CACHE_TTL && pairs.length > 0) return pairs;

  const pool = await getPool();
  const res = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_google_api_keys'");
  const raw = res.rows[0]?.value || '';
  const keys = raw.split('\n').map((k: string) => k.trim()).filter((k: string) => k.length > 10);

  const proxies = await getProxies();

  if (keys.length === 0) {
    pairs = [];
    lastPairBuild = Date.now();
    return pairs;
  }

  const newPairs: KeyProxyPair[] = [];
  for (let i = 0; i < keys.length; i++) {
    const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
    const existing = pairs.find(p => p.key === keys[i]);
    newPairs.push({
      key: keys[i],
      proxyUrl: proxy?.url || '',
      proxyDeviceId: proxy?.deviceId?.substring(0, 8) || 'direct',
      banned: existing?.banned && existing.banExpiry > Date.now() ? true : false,
      banExpiry: existing?.banExpiry || 0,
    });
  }

  pairs = newPairs;
  lastPairBuild = Date.now();
  console.log(`[embedding] Built ${pairs.length} key-proxy pairs (${proxies.length} proxies available)`);
  return pairs;
}

async function getNextPair(): Promise<KeyProxyPair> {
  const allPairs = await buildPairs();
  if (allPairs.length === 0) throw new Error('No Google API keys configured. Add them in Admin > Niche Explorer.');

  const now = Date.now();
  for (let i = 0; i < allPairs.length; i++) {
    const pair = allPairs[(pairIndex + i) % allPairs.length];
    if (!pair.banned || now > pair.banExpiry) {
      pair.banned = false;
      pairIndex = (pairIndex + i + 1) % allPairs.length;
      console.log(`[embedding] Using key=${pair.key.substring(0, 10)}... proxy=${pair.proxyDeviceId}`);
      return pair;
    }
  }

  let best = allPairs[0];
  for (const p of allPairs) {
    if (p.banExpiry < best.banExpiry) best = p;
  }
  console.log(`[embedding] ALL BANNED, forcing key=${best.key.substring(0, 10)}... proxy=${best.proxyDeviceId}`);
  return best;
}

let lastUsedKey = '';
export function getLastUsedKey(): string { return lastUsedKey; }

export function banKey(key: string): void {
  const pair = pairs.find(p => p.key === key);
  if (pair) {
    pair.banned = true;
    pair.banExpiry = Date.now() + BAN_DURATION;
    console.log(`[embedding] Banned key=${key.substring(0, 10)}... proxy=${pair.proxyDeviceId} for 5min`);
  }
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

export async function getPairForThread(threadIdx: number): Promise<KeyProxyPair | null> {
  const allPairs = await buildPairs();
  if (allPairs.length === 0) return null;
  return allPairs[threadIdx % allPairs.length];
}

export type EmbedInput =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };   // data is base64

/**
 * Generic batch embed — accepts mixed text/image inputs and a model name.
 * This is the new primary entrypoint; batchEmbed is kept as a thin wrapper for
 * backward compat.
 */
export async function batchEmbedInputs(
  inputs: EmbedInput[],
  model: string,
  fixedPairIdx?: number,
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  if (inputs.length > 100) throw new Error('Batch limit is 100 items');

  const pair = fixedPairIdx !== undefined ? await getPairForThread(fixedPairIdx) || await getNextPair() : await getNextPair();
  lastUsedKey = pair.key;

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
      { timeout: 120000, maxBuffer: 200 * 1024 * 1024 }   // images can make input+output large
    );
    rawOut = result.stdout;
    rawErr = result.stderr;
  } catch (err) {
    fs.unlinkSync(tmpFile);
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = e.stdout?.substring(0, 300) || e.stderr?.substring(0, 300) || e.message?.substring(0, 300);
    throw new Error(`Python embed failed: ${detail}`);
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
    if (errMsg.includes('API 429') || errMsg.includes('"code": 429') || errMsg.includes('RESOURCE_EXHAUSTED') ||
        (errMsg.includes('API 403') && errMsg.includes('denied access'))) {
      banKey(pair.key);
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
      COUNT(*) FILTER (WHERE title_embedding IS NULL          AND title IS NOT NULL AND title != '') AS ne_title_v1,
      COUNT(*) FILTER (WHERE title_embedding_v2 IS NULL       AND title IS NOT NULL AND title != '') AS ne_title_v2,
      COUNT(*) FILTER (WHERE thumbnail_embedding_v2 IS NULL
                       AND (thumbnail IS NOT NULL AND thumbnail != '' OR url IS NOT NULL AND url != '')) AS ne_thumb_v2
    FROM niche_spy_videos
  `);
  const r = statsRes.rows[0];
  const total = parseInt(r.total);

  return {
    apiKeysConfigured: allPairs.length,
    legacyModel,
    targets: {
      title_v1:     { totalVideos: total, embedded: parseInt(r.e_title_v1),  notEmbedded: parseInt(r.ne_title_v1) },
      title_v2:     { totalVideos: total, embedded: parseInt(r.e_title_v2),  notEmbedded: parseInt(r.ne_title_v2) },
      thumbnail_v2: { totalVideos: total, embedded: parseInt(r.e_thumb_v2),  notEmbedded: parseInt(r.ne_thumb_v2) },
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
