/**
 * YouTube Data API v3 key-proxy pair manager.
 *
 * Mirrors the embedding pipeline's pair management (lib/embeddings.ts) so the
 * YT enrichment can run N parallel threads, each pinned to its own key+proxy
 * pair, with ban-aware rotation when a key gets 429'd or 403'd.
 *
 * Ban duration: 5 minutes from a 429/403.
 */

import { getPool } from './db';
import { getProxies } from './xgodo-proxy';

export interface YtKeyProxyPair {
  key: string;
  proxyUrl: string;
  proxyDeviceId: string;
  banned: boolean;
  banExpiry: number;
}

let pairs: YtKeyProxyPair[] = [];
let pairIndex = 0;
let lastPairBuild = 0;
const PAIR_CACHE_TTL = 60 * 1000;
const BAN_DURATION = 5 * 60 * 1000;

async function buildPairs(): Promise<YtKeyProxyPair[]> {
  if (Date.now() - lastPairBuild < PAIR_CACHE_TTL && pairs.length > 0) return pairs;

  const pool = await getPool();
  // Prefer niche_yt_api_keys (multi-line), fall back to legacy single youtube_api_key
  const multi = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_yt_api_keys'");
  const single = await pool.query("SELECT value FROM admin_config WHERE key = 'youtube_api_key'");
  let keys: string[] = (multi.rows[0]?.value || '')
    .split('\n').map((k: string) => k.trim()).filter((k: string) => k.length > 10);
  if (keys.length === 0 && single.rows[0]?.value) keys = [single.rows[0].value.trim()];

  if (keys.length === 0) {
    pairs = [];
    lastPairBuild = Date.now();
    return pairs;
  }

  const proxies = await getProxies();
  const newPairs: YtKeyProxyPair[] = [];
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
  console.log(`[yt-keys] Built ${pairs.length} key-proxy pairs (${proxies.length} proxies available)`);
  return pairs;
}

/** Get the next unbanned pair (round-robin, for non-threaded callers). */
export async function getNextYtPair(): Promise<YtKeyProxyPair | null> {
  const all = await buildPairs();
  if (all.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < all.length; i++) {
    const p = all[(pairIndex + i) % all.length];
    if (!p.banned || now > p.banExpiry) {
      p.banned = false;
      pairIndex = (pairIndex + i + 1) % all.length;
      return p;
    }
  }
  // All banned — shortest-wait pair
  let best = all[0];
  for (const p of all) if (p.banExpiry < best.banExpiry) best = p;
  return best;
}

/**
 * Get a pair for a specific thread. Prefers the slot matching threadIdx but
 * rotates forward to the first unbanned pair — same pattern as the embedding
 * side, so a banned pinned key doesn't starve its thread.
 */
export async function getYtPairForThread(threadIdx: number): Promise<YtKeyProxyPair | null> {
  const all = await buildPairs();
  if (all.length === 0) return null;
  const now = Date.now();
  const n = all.length;
  const start = threadIdx % n;
  for (let i = 0; i < n; i++) {
    const p = all[(start + i) % n];
    if (!p.banned || now > p.banExpiry) {
      if (p.banned && now > p.banExpiry) p.banned = false;
      return p;
    }
  }
  let best = all[start];
  for (const p of all) if (p.banExpiry < best.banExpiry) best = p;
  return best;
}

export function banYtKey(key: string): void {
  const pair = pairs.find(p => p.key === key);
  if (pair) {
    pair.banned = true;
    pair.banExpiry = Date.now() + BAN_DURATION;
    console.log(`[yt-keys] Banned key=${key.substring(0, 10)}... proxy=${pair.proxyDeviceId} for 5min`);
  }
}

/** Admin UI status — truncated key, proxy device, ban state. */
export async function getYtKeyStatus(): Promise<Array<{
  key: string; proxy: string; banned: boolean; banExpiresIn: number | null;
}>> {
  const all = await buildPairs();
  const now = Date.now();
  return all.map(p => ({
    key: p.key.substring(0, 10) + '...' + p.key.substring(p.key.length - 4),
    proxy: p.proxyDeviceId,
    banned: p.banned && now < p.banExpiry,
    banExpiresIn: p.banned && now < p.banExpiry ? Math.round((p.banExpiry - now) / 1000) : null,
  }));
}
