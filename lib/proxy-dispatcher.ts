/**
 * Unified proxied fetch helper.
 *
 * For HTTP(S) proxies we use undici + ProxyAgent (native).
 * For SOCKS5 we have to drop down to node:https + SocksProxyAgent — undici
 * doesn't accept the socks-proxy-agent Agent as a Dispatcher (the cast
 * compiles but the request fails 0-4ms in with "fetch failed" because
 * undici's Dispatcher and node's http.Agent are different interfaces).
 *
 * Both paths return a Response-compatible object so callers can keep
 * using .ok / .status / .text() / .json() interchangeably.
 *
 * SOCKS5 caveat: the static-proxy provider's nodes only accept proxy-
 * side DNS (NetworkUnreachable on host-side resolution). lib/static-
 * proxies.ts builds URLs as socks5h://... so the SocksProxyAgent
 * forwards the hostname to the proxy and lets it resolve.
 */

import https from 'node:https';
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';

export interface ProxyFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  /** Per-attempt timeout in ms (default 30s). */
  timeoutMs?: number;
}

export interface ProxyFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Default per-attempt budgets — short enough to rotate fast when a
 *  proxy is slow but not so short that we miss a legitimate Gemini
 *  response (typically 200-2000ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Build an undici Dispatcher for HTTP proxies. SOCKS goes through the
 * separate https.request path (see fetchViaProxy below).
 */
export function dispatcherFor(proxyUrl: string, opts: { connectTimeout?: number; bodyTimeout?: number; headersTimeout?: number } = {}): Dispatcher {
  return new ProxyAgent({
    uri: proxyUrl,
    connectTimeout: opts.connectTimeout ?? 8_000,
    bodyTimeout:    opts.bodyTimeout ?? 30_000,
    headersTimeout: opts.headersTimeout ?? 15_000,
  });
}

/**
 * Fetch through any proxy URL, regardless of scheme. SOCKS goes via
 * node:https + SocksProxyAgent; HTTP/HTTPS via undici ProxyAgent.
 *
 * Returns a Response-shaped object with .ok / .status / .text() /
 * .json() so callers don't care about the transport.
 */
export async function fetchViaProxy(url: string, init: ProxyFetchInit, proxyUrl: string): Promise<ProxyFetchResponse> {
  if (/^socks/i.test(proxyUrl)) {
    return socksRequest(url, init, proxyUrl);
  }
  // HTTP(S) proxy path — undici fetch with ProxyAgent.
  const res = await undiciFetch(url, {
    method: init.method ?? 'POST',
    headers: init.headers,
    body: init.body,
    dispatcher: dispatcherFor(proxyUrl),
    signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
    json: () => res.json(),
  };
}

/**
 * SOCKS5 request via legacy node:https + SocksProxyAgent. Returns the
 * same Response-shaped object as the HTTP path. Reads the body
 * eagerly (we never need streaming for these calls).
 */
function socksRequest(url: string, init: ProxyFetchInit, proxyUrl: string): Promise<ProxyFetchResponse> {
  const u = new URL(url);
  const agent = new SocksProxyAgent(proxyUrl);
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: init.method ?? 'POST',
      headers: init.headers ?? {},
      agent,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: () => Promise.resolve(body),
          json: () => Promise.resolve(JSON.parse(body)),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`SOCKS5 request timeout after ${timeoutMs}ms`)));
    if (init.signal) {
      init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    if (init.body) req.write(init.body);
    req.end();
  });
}
