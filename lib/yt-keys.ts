/**
 * YouTube Data API v3 key-proxy pair manager.
 *
 * Mirrors the embedding pipeline's pair management (lib/embeddings.ts) so the
 * YT enrichment can run N parallel threads, each pinned to its own key+proxy
 * pair, with ban-aware rotation when a key gets 429'd or 403'd.
 *
 * Key source:
 *   xgodo_api_keys WHERE service='youtube_data' AND status='active' AND
 *                        (banned_until IS NULL OR banned_until < NOW())
 *
 * Legacy fallback: if that table is empty, the niche_yt_api_keys
 * admin_config newline-string is auto-migrated into the table on first
 * read (source='legacy'). The legacy single youtube_api_key key is kept
 * as the very last resort.
 *
 * Proxy routing: round-robin against the USA proxy pool. The keys'
 * `remote_device_id` (xgodo provenance) is NOT used for pairing — all
 * mobile proxies share the same NAT-y pool effectively, so device
 * affinity adds no real value.
 *
 * Ban duration: 5 minutes from a 429/403. Persisted to the table so
 * bans survive Node restarts and other workers see them too.
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

/** One-shot auto-migration: copy any keys from the legacy
 *  niche_yt_api_keys admin_config newline-string into the table.
 *  Idempotent via UNIQUE (service, key). Runs at most once per Node
 *  process. */
let legacyMigrated = false;
async function migrateLegacyOnce(): Promise<void> {
  if (legacyMigrated) return;
  legacyMigrated = true;
  try {
    const pool = await getPool();
    const r = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_yt_api_keys'");
    const raw: string = r.rows[0]?.value || '';
    const keys = raw.split('\n').map(k => k.trim()).filter(k => /^AIzaSy[A-Za-z0-9_-]{33}$/.test(k));
    if (keys.length === 0) return;
    let migrated = 0;
    for (const k of keys) {
      const ins = await pool.query(
        `INSERT INTO xgodo_api_keys (service, key, source, status)
         VALUES ('youtube_data', $1, 'legacy', 'active')
         ON CONFLICT (service, key) DO NOTHING RETURNING id`,
        [k],
      );
      if (ins.rowCount && ins.rowCount > 0) migrated += 1;
    }
    if (migrated > 0) console.log(`[yt-keys] Migrated ${migrated} legacy key(s) from niche_yt_api_keys → xgodo_api_keys`);
  } catch (err) {
    console.error('[yt-keys] legacy migration failed:', (err as Error).message);
  }
}

async function buildPairs(): Promise<YtKeyProxyPair[]> {
  if (Date.now() - lastPairBuild < PAIR_CACHE_TTL && pairs.length > 0) return pairs;

  await migrateLegacyOnce();
  const pool = await getPool();

  // Active, not-currently-banned keys from the inventory table. The
  // `banned_until < NOW()` test means temporarily-banned keys re-enter
  // the pool automatically once their cooloff expires (no separate
  // unban job needed).
  const tableRes = await pool.query<{ key: string; banned_until: Date | null }>(
    `SELECT key, banned_until
       FROM xgodo_api_keys
      WHERE service = 'youtube_data'
        AND status = 'active'
      ORDER BY id ASC`,
  );
  let keys: string[] = tableRes.rows.map(r => r.key);

  // Last-resort: legacy single-key admin_config slot, in case the table
  // is empty AND the niche_yt_api_keys migration found nothing.
  if (keys.length === 0) {
    const single = await pool.query("SELECT value FROM admin_config WHERE key = 'youtube_api_key'");
    if (single.rows[0]?.value) keys = [single.rows[0].value.trim()];
  }

  if (keys.length === 0) {
    pairs = [];
    lastPairBuild = Date.now();
    return pairs;
  }

  // Map of DB-side bans so we can seed in-memory pair state with them
  // (e.g. another worker banned this key 2 minutes ago — we should
  // know about it).
  const banMap = new Map<string, number>();
  for (const r of tableRes.rows) {
    if (r.banned_until && r.banned_until.getTime() > Date.now()) {
      banMap.set(r.key, r.banned_until.getTime());
    }
  }

  const proxies = await getProxies();
  const newPairs: YtKeyProxyPair[] = [];
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
  const expiry = Date.now() + BAN_DURATION;
  if (pair) {
    pair.banned = true;
    pair.banExpiry = expiry;
    console.log(`[yt-keys] Banned key=${key.substring(0, 10)}... proxy=${pair.proxyDeviceId} for 5min`);
  }
  // Persist to DB so the cooloff survives Node restarts and is visible
  // to siblings. Fire-and-forget — failure to persist isn't fatal, the
  // in-memory ban still applies for the lifetime of this process.
  (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys
            SET banned_until = to_timestamp($1 / 1000.0),
                last_used_at = NOW()
          WHERE service = 'youtube_data' AND key = $2`,
        [expiry, key],
      );
    } catch (err) {
      console.error('[yt-keys] persist ban failed:', (err as Error).message);
    }
  })();
}

/** Mark a key as permanently invalid (e.g. 400 invalid_api_key responses).
 *  Drops it out of the rotation forever — operator can re-enable via SQL. */
export async function invalidateYtKey(key: string, reason?: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE xgodo_api_keys
        SET status = 'invalid',
            invalidated_at = NOW()
      WHERE service = 'youtube_data' AND key = $1 AND status = 'active'`,
    [key],
  );
  console.log(`[yt-keys] Invalidated key=${key.substring(0, 10)}...${reason ? ` reason="${reason}"` : ''}`);
  // Force a rebuild on next call.
  lastPairBuild = 0;
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
