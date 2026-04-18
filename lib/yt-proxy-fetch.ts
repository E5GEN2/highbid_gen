/**
 * YouTube Data API client routed through xgodo proxies via Python+curl.
 *
 * Accepts an optional YtKeyProxyPair — used by the threaded enrichment pipeline
 * so each worker can pin to its own key+proxy. When no pair is given, we fall
 * back to the legacy single-proxy path (any free proxy, caller supplies key in URL).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getProxy } from './xgodo-proxy';
import type { YtKeyProxyPair } from './yt-keys';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

interface YtFetchResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
  error?: string;
  proxyUsed?: string;
}

/**
 * Fetch a YouTube Data API URL through an xgodo proxy.
 * If `pair` is provided the caller is responsible for embedding pair.key in the URL;
 * the proxy will use pair.proxyUrl. Otherwise we pick any available proxy.
 */
export async function ytFetchViaProxy(url: string, pair?: YtKeyProxyPair): Promise<YtFetchResult> {
  const proxyUrl = pair?.proxyUrl;
  const proxyDeviceId = pair?.proxyDeviceId;

  if (!proxyUrl) {
    // No pinned pair — fall back to picking any free proxy
    const anyProxy = await getProxy();
    if (!anyProxy) {
      // Direct fetch fallback
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
        const data = await res.json();
        return { ok: res.ok, status: res.status, data, proxyUsed: 'direct' };
      } catch (err) {
        return { ok: false, status: 0, data: null, error: (err as Error).message, proxyUsed: 'direct' };
      }
    }
    return ytFetchWithProxy(url, anyProxy.url, anyProxy.deviceId);
  }

  return ytFetchWithProxy(url, proxyUrl, proxyDeviceId || 'pinned');
}

async function ytFetchWithProxy(url: string, proxyUrl: string, proxyDeviceId: string): Promise<YtFetchResult> {
  const tmpFile = path.join(os.tmpdir(), `yt_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ url, proxy: proxyUrl }));

  try {
    const { stdout } = await execFileAsync('python3',
      [path.join(SCRIPTS_DIR, 'yt-fetch.py'), tmpFile],
      { timeout: 45000, maxBuffer: 10 * 1024 * 1024 }
    );
    fs.unlinkSync(tmpFile);

    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    // Python script wraps errors as { error: "..." }
    if (typeof parsed.error === 'string' && !parsed.kind && !parsed.items) {
      return { ok: false, status: 0, data: null, error: parsed.error, proxyUsed: proxyDeviceId };
    }

    // YouTube API errors come as { error: { code, message } }
    const ytError = parsed.error as { code?: number; message?: string } | undefined;
    if (ytError && typeof ytError === 'object' && ytError.code) {
      return { ok: false, status: ytError.code, data: parsed, error: ytError.message || 'YouTube API error', proxyUsed: proxyDeviceId };
    }

    return { ok: true, status: 200, data: parsed, proxyUsed: proxyDeviceId };
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = e.stdout?.substring(0, 300) || e.stderr?.substring(0, 300) || e.message?.substring(0, 300);
    return { ok: false, status: 0, data: null, error: `yt-fetch subprocess failed: ${detail}`, proxyUsed: proxyDeviceId };
  }
}
