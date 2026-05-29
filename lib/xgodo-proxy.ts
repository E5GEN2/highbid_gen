/**
 * Xgodo Device Proxy Manager
 *
 * Pulls the rentable proxy list from xgodo's admin API and exposes
 * round-robin / random pickers used by yt-dlp downloads, niche-spy
 * fetchers, and the YouTube enrichment pipeline.
 *
 * Endpoint (new dealer):
 *   GET https://xgodo.com/server/api/v2/admin/devices/proxies
 *   Authorization: Bearer <xgodo_proxy_token | xgodo_api_token>
 *
 * Response shape:
 *   { total, proxies: [{ connection_id, password, name, bytes_*, device: {
 *       remote_device_id, country, online, is_rented, is_onMarket, ...
 *     } }] }
 *
 * Each proxy is reachable at host:port from admin_config (or default
 * xgodo.com:3008) using Basic auth: connection_id : password.
 *
 * Filters applied (all configurable via admin_config):
 *   - Country (default 'us'): xgodo_proxy_country, set to '' / 'all' to skip
 *   - Online: device.online === true (always required)
 *   - Detached devices (device == null): always skipped
 */

import { getPool } from './db';

const XGODO_PROXIES_URL = 'https://xgodo.com/server/api/v2/admin/devices/proxies';
// 54.36.178.74:1082 is the working SOCKS/HTTP gateway for the new
// dealer's inventory. xgodo.com:3008 looks plausible (matches the
// admin domain) but auth fails there — only this OVH IP accepts the
// connection_id:password from the admin endpoint. Verified: 34/51 US
// online proxies returned 200 OK end-to-end via this host.
const DEFAULT_PROXY_HOST = '54.36.178.74';
const DEFAULT_PROXY_PORT = 1082;
const DEFAULT_COUNTRY = 'us';

/** Read proxy host / port / country filter from admin_config, with defaults. */
async function getProxyConfig(): Promise<{ host: string; port: number; country: string }> {
  try {
    const pool = await getPool();
    const res = await pool.query(
      "SELECT key, value FROM admin_config WHERE key IN ('xgodo_proxy_host', 'xgodo_proxy_port', 'xgodo_proxy_country')",
    );
    let host = DEFAULT_PROXY_HOST;
    let port = DEFAULT_PROXY_PORT;
    let country = DEFAULT_COUNTRY;
    for (const row of res.rows) {
      if (row.key === 'xgodo_proxy_host'    && row.value) host    = row.value;
      if (row.key === 'xgodo_proxy_port'    && row.value) port    = parseInt(row.value) || DEFAULT_PROXY_PORT;
      if (row.key === 'xgodo_proxy_country' && row.value !== undefined && row.value !== null) country = String(row.value).toLowerCase();
    }
    return { host, port, country };
  } catch {
    return { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT, country: DEFAULT_COUNTRY };
  }
}

/** Bearer token for the xgodo admin API. Tries the dedicated proxy
 *  token first, falls back to the legacy admin tokens, then env. */
async function getXgodoToken(): Promise<string> {
  const pool = await getPool();
  for (const key of ['xgodo_proxy_token', 'xgodo_admin_token', 'xgodo_api_token', 'xgodo_niche_spy_token']) {
    const res = await pool.query("SELECT value FROM admin_config WHERE key = $1", [key]);
    if (res.rows[0]?.value) return res.rows[0].value;
  }
  return process.env.XGODO_API_TOKEN || '';
}

interface XgodoDeviceMeta {
  remote_device_id: string;
  user_id: string | null;
  name: string | null;
  brand: string | null;
  model: string | null;
  country: string | null;
  online: boolean;
  is_rented: boolean;
  is_onMarket: boolean;
}

interface XgodoProxy {
  connection_id: string;
  password: string;
  name: string | null;
  bytes_last_24h: number;
  bytes_lifetime: number;
  device: XgodoDeviceMeta | null;
}

export interface ProxyInfo {
  /** http://connection_id:password@host:port */
  url: string;
  /** Device the proxy is anchored to. */
  deviceId: string;
  /** ISO 3166-1 alpha-2 (e.g. 'us'), or 'unknown' if missing. */
  country: string;
  /** xgodo's display name for the proxy device. */
  name: string | null;
}

let cachedProxies: ProxyInfo[] = [];
let cachedTotal = 0;          // raw count returned by xgodo (pre-filter)
let cachedOnline = 0;         // count of online proxies (pre-country-filter)
let lastFetchTime = 0;
let lastError: string | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 min
let rotationIndex = 0;

async function refreshProxies(): Promise<ProxyInfo[]> {
  const token = await getXgodoToken();
  if (!token) {
    lastError = 'No xgodo token configured';
    console.warn('[proxy] No xgodo token configured');
    return [];
  }

  try {
    const { host, port, country } = await getProxyConfig();
    const res = await fetch(XGODO_PROXIES_URL, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      lastError = `Failed to fetch proxies: HTTP ${res.status}`;
      console.error(`[proxy] ${lastError}`);
      return cachedProxies;  // serve stale cache rather than nothing
    }

    const data = await res.json() as { total?: number; proxies?: XgodoProxy[] };
    const all = Array.isArray(data?.proxies) ? data.proxies : [];
    cachedTotal = data.total ?? all.length;

    const wantCountry = country && country !== 'all' && country !== '' ? country : null;
    const built: ProxyInfo[] = [];
    let onlineCount = 0;
    for (const p of all) {
      const dev = p.device;
      if (!dev) continue;            // detached device, no use to us
      if (!dev.online) continue;     // skip offline
      onlineCount += 1;
      if (wantCountry && (dev.country ?? '').toLowerCase() !== wantCountry) continue;
      if (!p.connection_id || !p.password) continue;
      built.push({
        url: `http://${p.connection_id}:${p.password}@${host}:${port}`,
        deviceId: dev.remote_device_id,
        country: (dev.country ?? 'unknown').toLowerCase(),
        name: p.name ?? dev.name ?? null,
      });
    }

    cachedProxies = built;
    cachedOnline = onlineCount;
    lastFetchTime = Date.now();
    lastError = null;
    console.log(
      `[proxy] Refreshed: ${built.length} usable / ${onlineCount} online / ${cachedTotal} total ` +
      `(country=${wantCountry ?? 'any'}, host=${host}:${port})`
    );
    return built;
  } catch (err) {
    lastError = (err as Error).message;
    console.error('[proxy] Refresh error:', lastError);
    return cachedProxies;
  }
}

/** Get all available proxies (cached, refreshes every 5 min). */
export async function getProxies(): Promise<ProxyInfo[]> {
  if (Date.now() - lastFetchTime > CACHE_TTL || cachedProxies.length === 0) {
    await refreshProxies();
  }
  return cachedProxies;
}

/** Round-robin proxy picker. Walks the cached list each call. */
export async function getProxy(): Promise<ProxyInfo | null> {
  const proxies = await getProxies();
  if (proxies.length === 0) return null;
  const proxy = proxies[rotationIndex % proxies.length];
  rotationIndex++;
  return proxy;
}

/** Random proxy picker — used when callers want pure jitter. */
export async function getRandomProxy(): Promise<ProxyInfo | null> {
  const proxies = await getProxies();
  if (proxies.length === 0) return null;
  return proxies[Math.floor(Math.random() * proxies.length)];
}

/**
 * Random pick filtered against the xgodo_proxy_health sweep verdict.
 *
 * The dealer's "online" flag is a per-device heartbeat; it tells us
 * the device is reachable but NOT whether it can carry our actual
 * HTTPS traffic. Live probe sweeps (POST /api/admin/tools/proxy-health)
 * mark TCP-dead devices with banned_until > NOW. We skip those here.
 *
 * Falls back to any healthy/unknown proxy if there's no row for a
 * device (never been probed). Falls back further to the unfiltered
 * pool if the sweep hasn't run yet — so we never starve callers on
 * a cold start.
 */
export async function getRandomHealthyProxy(): Promise<ProxyInfo | null> {
  const proxies = await getProxies();
  if (proxies.length === 0) return null;

  try {
    const pool = await getPool();
    // Pull the ban list for the device IDs we currently have.
    const deviceIds = proxies.map(p => p.deviceId);
    const banRes = await pool.query<{ device_id: string; status: string; banned_until: Date | null }>(
      `SELECT device_id, status, banned_until
         FROM xgodo_proxy_health
        WHERE device_id = ANY($1::text[])`,
      [deviceIds],
    );
    const banByDevice = new Map<string, { status: string; banUntil: number }>();
    for (const r of banRes.rows) {
      banByDevice.set(r.device_id, {
        status: r.status,
        banUntil: r.banned_until ? r.banned_until.getTime() : 0,
      });
    }
    const now = Date.now();
    const healthy = proxies.filter(p => {
      const entry = banByDevice.get(p.deviceId);
      if (!entry) return true;                   // never probed → assume usable
      if (entry.banUntil > now) return false;    // sweep-marked dead
      return entry.status !== 'dead';
    });
    if (healthy.length === 0) {
      // Pool is sweep-empty (likely no sweep run recently). Fall back
      // to the unfiltered random pick so we don't starve the caller.
      console.warn('[proxy] getRandomHealthyProxy: no healthy proxies after filter, falling back to unfiltered');
      return proxies[Math.floor(Math.random() * proxies.length)];
    }
    return healthy[Math.floor(Math.random() * healthy.length)];
  } catch (err) {
    console.warn('[proxy] getRandomHealthyProxy: filter query failed, falling back:', (err as Error).message);
    return proxies[Math.floor(Math.random() * proxies.length)];
  }
}

/** Force-refresh the proxy cache. Useful after admin_config changes. */
export async function reloadProxies(): Promise<ProxyInfo[]> {
  lastFetchTime = 0;
  cachedProxies = [];
  return refreshProxies();
}

/** Stats surfaced in admin dashboards. */
export async function getProxyStats(): Promise<{
  total: number;     // total proxies returned by xgodo
  online: number;    // online of the total (pre-country-filter)
  usable: number;    // online + matches country filter
  cached: boolean;
  cacheAge: number;
  error: string | null;
}> {
  // If never fetched, do it now so admin pages don't show 0/0.
  if (lastFetchTime === 0) await refreshProxies();
  return {
    total: cachedTotal,
    online: cachedOnline,
    usable: cachedProxies.length,
    cached: Date.now() - lastFetchTime < CACHE_TTL,
    cacheAge: Math.round((Date.now() - lastFetchTime) / 1000),
    error: lastError,
  };
}
