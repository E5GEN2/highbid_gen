/**
 * Gemini embedding helper — proxied via xgodo, no Python subprocess.
 *
 * Why undici + ProxyAgent (vs lib/embeddings.ts's Python+curl path):
 * the curl path's failure signature was `curl exit 56` (proxy collapse
 * mid-request) at ~75%. undici uses a different transport stack so
 * proxies that curl can't keep open often work here. We rotate across
 * fresh random proxies per attempt — most "this proxy is down right
 * now" failures recover by re-rolling.
 *
 * No direct fallback. Always proxied to keep Gemini from seeing
 * Railway's single egress IP as the consumer for every call.
 *
 * Key hygiene:
 *   - pickHealthyAiKey: status='active' AND banned_until<NOW
 *   - 403 PERMISSION_DENIED → mark key invalid permanently
 *   - 429 → 90s cooloff via banned_until
 *
 * Throws on any non-recoverable failure so the caller can retry with
 * a fresh key.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { getPool } from './db';
import { getRandomHealthyProxy } from './xgodo-proxy';
import type { EmbedInput } from './embeddings';

interface AiKeyRow { id: number; key: string }

// How many fresh proxies to try before giving up on one Gemini call.
// At ~50% proxy live-rate, 6 attempts give (1-0.5^6) = ~98% chance of
// landing on at least one good proxy. Each attempt has its own 30s
// budget; the outer 45s timeout caps the whole call.
const PROXY_ATTEMPTS = 6;

async function pickHealthyAiKey(): Promise<AiKeyRow | null> {
  const pool = await getPool();
  const r = await pool.query<AiKeyRow>(
    `SELECT id, key
       FROM xgodo_api_keys
      WHERE service = 'google_ai_studio'
        AND status = 'active'
        AND (banned_until IS NULL OR banned_until < NOW())
      ORDER BY RANDOM()
      LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

function invalidateKey(keyId: number, reason: string): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys SET status = 'invalid', invalidated_at = NOW()
          WHERE id = $1 AND status = 'active'`,
        [keyId],
      );
      console.log(`[embed-direct] invalidated key id=${keyId} (${reason})`);
    } catch { /* fire-and-forget */ }
  })();
}

function cooloffKey(keyId: number, seconds: number = 90): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys SET banned_until = NOW() + ($1 || ' seconds')::interval
          WHERE id = $2`,
        [String(seconds), keyId],
      );
    } catch { /* fire-and-forget */ }
  })();
}

function partToGeminiPart(p: EmbedInput): Record<string, unknown> {
  if (p.type === 'image') return { inlineData: { mimeType: p.mimeType, data: p.data } };
  return { text: p.text ?? '' };
}

/**
 * POST to Gemini with proxy rotation. Each attempt picks a fresh
 * random xgodo proxy. If the proxy collapses (network error), we
 * silently roll to the next one. If Gemini responds with anything
 * (200, 429, 403, …) we surface it — that's a key/quota signal, not
 * a proxy issue, and the caller's key-hygiene needs to see it.
 *
 * Throws if all PROXY_ATTEMPTS proxies fail to connect.
 */
async function postGeminiViaProxy(url: string, body: string): Promise<Response> {
  const init = {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(45_000),
  };

  let lastErr: string | null = null;
  for (let i = 0; i < PROXY_ATTEMPTS; i++) {
    const proxy = await getRandomHealthyProxy().catch(() => null);
    if (!proxy?.url) {
      lastErr = 'no_proxy_available';
      continue;
    }
    try {
      const res = await undiciFetch(url, {
        ...init,
        dispatcher: new ProxyAgent({
          uri: proxy.url,
          connectTimeout: 8_000,
          bodyTimeout: 30_000,
          headersTimeout: 15_000,
        }),
      });
      return res as unknown as Response;
    } catch (err) {
      lastErr = (err as Error).message?.slice(0, 120) || 'proxy fail';
      // Try next proxy.
    }
  }
  throw new Error(`all ${PROXY_ATTEMPTS} proxy attempts failed: ${lastErr}`);
}

/**
 * One Gemini call equivalent of batchEmbedInputs: each input becomes a
 * single-part content; returns one embedding per input in order.
 */
export async function batchEmbedInputsDirect(
  inputs: EmbedInput[],
  modelName: string,
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const keyRow = await pickHealthyAiKey();
  if (!keyRow) throw new Error('no_active_ai_keys');

  const requests = inputs.map(p => ({
    model: `models/${modelName}`,
    content: { parts: [partToGeminiPart(p)] },
  }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:batchEmbedContents?key=${keyRow.key}`;
  const res = await postGeminiViaProxy(url, JSON.stringify({ requests }));

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 403 && /PERMISSION_DENIED|has been (denied|suspended)/i.test(errBody)) {
      invalidateKey(keyRow.id, `gemini_403: ${errBody.slice(0, 80)}`);
    } else if (res.status === 429) {
      cooloffKey(keyRow.id, 90);
    }
    throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json() as {
    embeddings?: Array<{ values?: number[] }>;
    error?: { code?: number; message?: string };
  };
  if (data.error) throw new Error(`Gemini error ${data.error.code}: ${(data.error.message || '').slice(0, 200)}`);
  if (!data.embeddings) throw new Error('Gemini response had no embeddings');
  return data.embeddings.map(e => e.values ?? []);
}

/**
 * One Gemini call equivalent of batchEmbedGrouped: each input group
 * becomes one multi-part content, producing ONE joint embedding per
 * group (used for the combined_v2 title+thumbnail multimodal vector).
 */
export async function batchEmbedGroupedDirect(
  groups: EmbedInput[][],
  modelName: string,
): Promise<number[][]> {
  if (groups.length === 0) return [];
  const keyRow = await pickHealthyAiKey();
  if (!keyRow) throw new Error('no_active_ai_keys');

  const requests = groups.map(group => ({
    model: `models/${modelName}`,
    content: { parts: group.map(partToGeminiPart) },
  }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:batchEmbedContents?key=${keyRow.key}`;
  const res = await postGeminiViaProxy(url, JSON.stringify({ requests }));

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 403 && /PERMISSION_DENIED|has been (denied|suspended)/i.test(errBody)) {
      invalidateKey(keyRow.id, `gemini_403: ${errBody.slice(0, 80)}`);
    } else if (res.status === 429) {
      cooloffKey(keyRow.id, 90);
    }
    throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json() as {
    embeddings?: Array<{ values?: number[] }>;
    error?: { code?: number; message?: string };
  };
  if (data.error) throw new Error(`Gemini error ${data.error.code}: ${(data.error.message || '').slice(0, 200)}`);
  if (!data.embeddings) throw new Error('Gemini response had no embeddings');
  return data.embeddings.map(e => e.values ?? []);
}
