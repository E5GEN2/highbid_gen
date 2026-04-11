/**
 * Xgodo Device Proxy Manager
 * Fetches online devices from xgodo API and provides rotating proxy URLs.
 *
 * All devices share the same host/port — only credentials change.
 * Host + port are configurable via admin_config (keys: xgodo_proxy_host, xgodo_proxy_port).
 */

import { getPool } from './db';

const XGODO_API = 'https://xgodo.com/api/v2';
const DEFAULT_PROXY_HOST = 'ec2-44-200-81-136.compute-1.amazonaws.com';
const DEFAULT_PROXY_PORT = 1082;

/** Read proxy host/port from admin_config, fallback to defaults */
async function getProxyHostPort(): Promise<{ host: string; port: number }> {
  try {
    const pool = await getPool();
    const res = await pool.query("SELECT key, value FROM admin_config WHERE key IN ('xgodo_proxy_host', 'xgodo_proxy_port')");
    let host = DEFAULT_PROXY_HOST;
    let port = DEFAULT_PROXY_PORT;
    for (const row of res.rows) {
      if (row.key === 'xgodo_proxy_host' && row.value) host = row.value;
      if (row.key === 'xgodo_proxy_port' && row.value) port = parseInt(row.value) || DEFAULT_PROXY_PORT;
    }
    return { host, port };
  } catch {
    return { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT };
  }
}

interface XgodoDevice {
  remote_device_id: string;
  online: boolean;
  networkType?: string;
  proxy_username: string;
  proxy_password: string | null;
  proxy_passwords?: Array<{ label: string; password: string }>;
}

interface ProxyInfo {
  url: string; // http://user:pass@host:port
  deviceId: string;
  networkType: string;
}

let cachedProxies: ProxyInfo[] = [];
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min
let rotationIndex = 0;

/** Get xgodo API token from admin config */
async function getXgodoToken(): Promise<string> {
  const pool = await getPool();
  // Try niche spy token first, then general xgodo token
  for (const key of ['xgodo_niche_spy_token', 'xgodo_api_token']) {
    const res = await pool.query("SELECT value FROM admin_config WHERE key = $1", [key]);
    if (res.rows[0]?.value) return res.rows[0].value;
  }
  return process.env.XGODO_API_TOKEN || '';
}

/** Fetch online devices from xgodo and build proxy list */
async function refreshProxies(): Promise<ProxyInfo[]> {
  const token = await getXgodoToken();
  if (!token) {
    console.warn('[proxy] No xgodo token configured');
    return [];
  }

  try {
    const { host, port } = await getProxyHostPort();
    const res = await fetch(`${XGODO_API}/devices`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error(`[proxy] Failed to fetch devices: ${res.status}`);
      return cachedProxies; // Return stale cache
    }

    const data = await res.json();
    const devices: XgodoDevice[] = Array.isArray(data) ? data : data.devices || [];

    const proxies: ProxyInfo[] = [];
    for (const d of devices) {
      if (!d.online) continue;
      // Only use devices with proxy_password set — others aren't routing
      if (!d.proxy_password) continue;

      const password = d.proxy_password;
      const username = d.proxy_username || d.remote_device_id;
      proxies.push({
        url: `http://${username}:${password}@${host}:${port}`,
        deviceId: d.remote_device_id,
        networkType: d.networkType || 'unknown',
      });
    }

    cachedProxies = proxies;
    lastFetchTime = Date.now();
    console.log(`[proxy] Refreshed: ${proxies.length} online proxies (host=${host}:${port})`);
    return proxies;
  } catch (err) {
    console.error('[proxy] Refresh error:', (err as Error).message);
    return cachedProxies;
  }
}

/** Get all available proxies (cached, refreshes every 5 min) */
export async function getProxies(): Promise<ProxyInfo[]> {
  if (Date.now() - lastFetchTime > CACHE_TTL || cachedProxies.length === 0) {
    await refreshProxies();
  }
  return cachedProxies;
}

/** Get a single proxy (round-robin rotation) */
export async function getProxy(): Promise<ProxyInfo | null> {
  const proxies = await getProxies();
  if (proxies.length === 0) return null;
  const proxy = proxies[rotationIndex % proxies.length];
  rotationIndex++;
  return proxy;
}

/** Get a random proxy */
export async function getRandomProxy(): Promise<ProxyInfo | null> {
  const proxies = await getProxies();
  if (proxies.length === 0) return null;
  return proxies[Math.floor(Math.random() * proxies.length)];
}

/** Get proxy stats */
export async function getProxyStats(): Promise<{ total: number; online: number; cached: boolean; cacheAge: number }> {
  return {
    total: cachedProxies.length,
    online: cachedProxies.length,
    cached: Date.now() - lastFetchTime < CACHE_TTL,
    cacheAge: Math.round((Date.now() - lastFetchTime) / 1000),
  };
}
