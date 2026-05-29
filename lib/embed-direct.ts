/**
 * Direct-fetch Gemini embedding helper — same shape as the
 * batchEmbedInputs / batchEmbedGrouped pair in lib/embeddings.ts, but
 * routed via native fetch with no xgodo proxy and no Python subprocess.
 *
 * Why: production debug via /admin/embed-debug/embed-one showed the
 * proxied path failing 75% with `curl exit 56` (proxy collapses
 * mid-request) and 25% with 429s. With 3 retries per batch that's a
 * ~1.5% success rate — matches stuck embedding_requests rows sitting
 * at 0/62 for tens of minutes.
 *
 * Direct fetch from Railway → Gemini is much cleaner at the volumes
 * embedding requests run at (a typical request is 50-100 videos in
 * batches of 5 = ~10-20 calls, well under any per-IP rate limit).
 * Same approach has been load-bearing for vid-gen prompt generation
 * since b7ec349.
 *
 * Key hygiene mirrors the vid-gen pattern:
 *   - pickHealthyAiKey filters status='active' AND banned_until<NOW
 *   - 403 PERMISSION_DENIED → mark key invalid permanently
 *   - 429 → 90s cooloff via banned_until
 *
 * Throws the underlying error so the caller (embedSpecificVideos)
 * can retry with a fresh key.
 */

import { getPool } from './db';
import type { EmbedInput } from './embeddings';

interface AiKeyRow { id: number; key: string }

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
 * Direct-fetch equivalent of batchEmbedInputs: one request per input
 * (each input becomes a single-part content). Returns one embedding
 * per input in submission order.
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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(45_000),
  });

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
 * Direct-fetch equivalent of batchEmbedGrouped: each input group
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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(45_000),
  });

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
