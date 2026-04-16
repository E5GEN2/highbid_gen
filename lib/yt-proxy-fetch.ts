/**
 * YouTube Data API client routed through xgodo proxies via Python+curl.
 * Each call rotates through available proxies to avoid single-IP rate limits.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getProxy } from './xgodo-proxy';

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
 * Returns the parsed JSON response (or an error).
 */
export async function ytFetchViaProxy(url: string): Promise<YtFetchResult> {
  const proxy = await getProxy();
  if (!proxy) {
    // Fallback — direct fetch if no proxy available
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const data = await res.json();
      return { ok: res.ok, status: res.status, data, proxyUsed: 'direct' };
    } catch (err) {
      return { ok: false, status: 0, data: null, error: (err as Error).message, proxyUsed: 'direct' };
    }
  }

  const tmpFile = path.join(os.tmpdir(), `yt_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ url, proxy: proxy.url }));

  try {
    const { stdout } = await execFileAsync('python3',
      [path.join(SCRIPTS_DIR, 'yt-fetch.py'), tmpFile],
      { timeout: 45000, maxBuffer: 10 * 1024 * 1024 }
    );
    fs.unlinkSync(tmpFile);

    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    // Python script wraps errors as { error: "..." }
    if (typeof parsed.error === 'string' && !parsed.kind && !parsed.items) {
      return { ok: false, status: 0, data: null, error: parsed.error, proxyUsed: proxy.deviceId };
    }

    // YouTube API errors come as { error: { code, message } }
    const ytError = parsed.error as { code?: number; message?: string } | undefined;
    if (ytError && typeof ytError === 'object' && ytError.code) {
      return { ok: false, status: ytError.code, data: parsed, error: ytError.message || 'YouTube API error', proxyUsed: proxy.deviceId };
    }

    return { ok: true, status: 200, data: parsed, proxyUsed: proxy.deviceId };
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = e.stdout?.substring(0, 300) || e.stderr?.substring(0, 300) || e.message?.substring(0, 300);
    return { ok: false, status: 0, data: null, error: `yt-fetch subprocess failed: ${detail}`, proxyUsed: proxy.deviceId };
  }
}
