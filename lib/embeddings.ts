/**
 * Google Text Embedding API client.
 * Uses gemini-embedding-001 model (3072 dimensions).
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

/** Build key-proxy pairs: each key gets a dedicated proxy */
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

  // Assign keys to proxies: 1 key per proxy, wrap if more keys than proxies
  const newPairs: KeyProxyPair[] = [];
  for (let i = 0; i < keys.length; i++) {
    const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
    // Preserve existing ban state if key was already paired
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

/** Get next available (unbanned) key-proxy pair */
async function getNextPair(): Promise<KeyProxyPair> {
  const allPairs = await buildPairs();
  if (allPairs.length === 0) throw new Error('No Google API keys configured. Add them in Admin > Niche Explorer.');

  const now = Date.now();
  // Find first unbanned pair
  for (let i = 0; i < allPairs.length; i++) {
    const pair = allPairs[(pairIndex + i) % allPairs.length];
    if (!pair.banned || now > pair.banExpiry) {
      pair.banned = false;
      pairIndex = (pairIndex + i + 1) % allPairs.length;
      console.log(`[embedding] Using key=${pair.key.substring(0, 10)}... proxy=${pair.proxyDeviceId}`);
      return pair;
    }
  }

  // All banned — pick soonest to expire
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

async function getModel(): Promise<string> {
  const pool = await getPool();
  const res = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_embedding_model'");
  return res.rows[0]?.value || 'gemini-embedding-001';
}

// --- Embedding API ---

/**
 * Get a specific pair by index (for thread assignment).
 * Thread 0 gets pair 0, thread 1 gets pair 1, etc.
 */
export async function getPairForThread(threadIdx: number): Promise<KeyProxyPair | null> {
  const allPairs = await buildPairs();
  if (allPairs.length === 0) return null;
  return allPairs[threadIdx % allPairs.length];
}

/**
 * Batch embed texts. Uses getNextPair() by default, or a fixed pair if provided.
 */
export async function batchEmbed(texts: string[], fixedPairIdx?: number): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > 100) throw new Error('Batch limit is 100 texts');

  const pair = fixedPairIdx !== undefined ? await getPairForThread(fixedPairIdx) || await getNextPair() : await getNextPair();
  lastUsedKey = pair.key;
  const model = await getModel();

  const fs = await import('fs');
  const os = await import('os');
  const inputData = JSON.stringify({ texts, key: pair.key, model, proxy: pair.proxyUrl });
  const tmpFile = path.join(os.tmpdir(), `embed_input_${Date.now()}.json`);
  fs.writeFileSync(tmpFile, inputData);

  let rawOut: string | Buffer, rawErr: string | Buffer;
  try {
    const result = await execFileAsync(
      'python3',
      [path.join(SCRIPTS_DIR, 'embed-batch.py'), tmpFile],
      { timeout: 45000, maxBuffer: 50 * 1024 * 1024 }
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
    // Only ban on actual Google API errors
    if (errMsg.includes('API 429') || errMsg.includes('"code": 429') || errMsg.includes('RESOURCE_EXHAUSTED') ||
        (errMsg.includes('API 403') && errMsg.includes('denied access'))) {
      banKey(pair.key);
    }
    throw new Error(errMsg);
  }

  return result;
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

export async function getEmbeddingStats(): Promise<{
  totalVideos: number;
  embedded: number;
  notEmbedded: number;
  apiKeysConfigured: number;
  model: string;
}> {
  const pool = await getPool();
  const allPairs = await buildPairs();
  const model = await getModel();
  const statsRes = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE title_embedding IS NOT NULL) as embedded,
      COUNT(*) FILTER (WHERE title_embedding IS NULL AND title IS NOT NULL AND title != '') as not_embedded
    FROM niche_spy_videos
  `);

  return {
    totalVideos: parseInt(statsRes.rows[0].total),
    embedded: parseInt(statsRes.rows[0].embedded),
    notEmbedded: parseInt(statsRes.rows[0].not_embedded),
    apiKeysConfigured: allPairs.length,
    model,
  };
}
