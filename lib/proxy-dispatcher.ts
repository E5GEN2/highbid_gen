/**
 * Single source of truth for "given a proxy URL, build the right
 * undici Dispatcher for it." Used by every code path that does a
 * proxied fetch via undici — keeps SOCKS5 vs HTTP routing logic in
 * one place so a future scheme addition (or the static-list swap-
 * out) doesn't require touching every caller.
 *
 * HTTP/HTTPS proxies → undici.ProxyAgent (native).
 * SOCKS5            → socks-proxy-agent.SocksProxyAgent (cast to
 *                     Dispatcher; undici accepts it via its node-
 *                     style Agent interface).
 *
 * Timeouts are tuned for embedding-shaped requests (sub-30s body,
 * 8s connect). Callers that need longer can pass overrides.
 */

import { ProxyAgent, type Dispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';

export interface DispatcherOptions {
  connectTimeout?: number;
  bodyTimeout?: number;
  headersTimeout?: number;
}

const DEFAULTS: Required<DispatcherOptions> = {
  connectTimeout: 8_000,
  bodyTimeout:    30_000,
  headersTimeout: 15_000,
};

export function dispatcherFor(proxyUrl: string, opts: DispatcherOptions = {}): Dispatcher {
  const merged = { ...DEFAULTS, ...opts };
  if (/^socks/i.test(proxyUrl)) {
    return new SocksProxyAgent(proxyUrl) as unknown as Dispatcher;
  }
  return new ProxyAgent({
    uri: proxyUrl,
    connectTimeout: merged.connectTimeout,
    bodyTimeout:    merged.bodyTimeout,
    headersTimeout: merged.headersTimeout,
  });
}
