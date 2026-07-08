/**
 * Qwen combined-embedding space (v1) — a SECOND vector space alongside the
 * Gemini combined_v2 one, produced by a self-hosted Qwen3-VL-Embedding-8B
 * server (Colab + ngrok; notebook: lab root qwen_embedding_server.ipynb).
 *
 * Vectors are requested at MRL dim 3072 so the existing pgvector
 * halfvec(3072) index/query machinery applies unchanged. The two spaces are
 * NOT comparable — never mix qwen_v1 and combined_v2 vectors in one
 * similarity computation.
 *
 * Storage:
 *   vector DB  niche_video_vectors_qwen_v1(video_id PK, keyword, title, embedding vector)
 *   main   DB  niche_spy_videos.qwen_embedded_v1_at stamp (cross-DB anti-joins
 *              are impossible, so presence is tracked main-side — same pattern
 *              as combined_embedded_v2_at). Stamp set with NO vector row =
 *              permanently skipped (bad thumbnail etc.), so the loop advances.
 *
 * Control (admin_config keys):
 *   qwen_embed_url         Colab server base URL (rotates with every ngrok restart)
 *   qwen_embed_token       bearer token printed by the notebook's config cell
 *   qwen_backfill_enabled  'true' → the loop works; anything else → loop parks
 *   qwen_backfill_batch    pairs per API call (default 12)
 *
 * The loop itself is started at boot (instrumentation.ts) and by the admin
 * route; it never exits — it parks (sleeps) while disabled/unconfigured and
 * survives transient failures with capped backoff, so a deploy or a dead
 * ngrok URL never needs a code change to recover from.
 */

import { getPool } from './db';
import { vectorPool } from './vector-db';

export const QWEN_DIM = 3072;

const CFG_KEYS = [
  'qwen_embed_url',
  'qwen_embed_token',
  'qwen_backfill_enabled',
  'qwen_backfill_batch',
] as const;

interface QwenCfg {
  url: string;
  token: string;
  enabled: boolean;
  batch: number;
}

export async function readQwenConfig(): Promise<QwenCfg> {
  const pool = await getPool();
  const r = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config WHERE key = ANY($1::text[])`,
    [[...CFG_KEYS]],
  );
  const m: Record<string, string> = {};
  for (const row of r.rows) m[row.key] = row.value;
  return {
    url: (m.qwen_embed_url || '').replace(/\/+$/, ''),
    token: m.qwen_embed_token || '',
    enabled: m.qwen_backfill_enabled === 'true',
    batch: Math.max(1, Math.min(48, parseInt(m.qwen_backfill_batch) || 12)),
  };
}

export interface QwenPair { text?: string; image?: string }

/** One POST /embed call against the Colab server. Throws on any failure. */
export async function embedPairsViaQwen(
  pairs: QwenPair[],
  cfg: { url: string; token: string },
  dimensions: number = QWEN_DIM,
): Promise<number[][]> {
  if (pairs.length === 0) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240_000); // T4 does ~1-2 pairs/s
  try {
    const res = await fetch(`${cfg.url}/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
        // ngrok free tier interposes a browser warning page unless this is set
        'ngrok-skip-browser-warning': '1',
      },
      body: JSON.stringify({ pairs, dimensions }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`qwen embed HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== pairs.length) {
      throw new Error(`qwen embed returned ${data.embeddings?.length ?? 0} vectors for ${pairs.length} pairs`);
    }
    return data.embeddings;
  } finally {
    clearTimeout(timer);
  }
}

export async function qwenHealth(cfg: { url: string; token: string }): Promise<Record<string, unknown> | null> {
  if (!cfg.url) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(`${cfg.url}/health`, {
      headers: { 'ngrok-skip-browser-warning': '1' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function ensureQwenTables(): Promise<void> {
  await vectorPool.query(`
    CREATE TABLE IF NOT EXISTS niche_video_vectors_qwen_v1 (
      video_id INTEGER PRIMARY KEY,
      keyword TEXT,
      title TEXT,
      embedding vector(${QWEN_DIM})
    )
  `);
  await vectorPool.query(
    `CREATE INDEX IF NOT EXISTS idx_nvv_qw1_keyword ON niche_video_vectors_qwen_v1(keyword)`,
  ).catch(() => {});
}

/** ivfflat trains its centroids at CREATE time, so building it on a near-empty
 *  table produces a useless index. Create it once the space has real mass. */
const IVF_MIN_ROWS = 100_000;
let ivfChecked = false;
async function maybeCreateIvfIndex(): Promise<void> {
  if (ivfChecked) return;
  const idx = await vectorPool.query(
    `SELECT 1 FROM pg_indexes WHERE tablename = 'niche_video_vectors_qwen_v1' AND indexname = 'idx_nvv_qw1_emb_ivf'`,
  );
  if (idx.rows.length > 0) { ivfChecked = true; return; }
  const cnt = await vectorPool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM niche_video_vectors_qwen_v1`,
  );
  if (parseInt(cnt.rows[0].n) < IVF_MIN_ROWS) return;
  console.log('[qwen-embed] creating ivfflat index (one-off, table crossed 100K rows)');
  await vectorPool.query(`SET statement_timeout = '1800000'`).catch(() => {});
  await vectorPool.query(`
    CREATE INDEX IF NOT EXISTS idx_nvv_qw1_emb_ivf
      ON niche_video_vectors_qwen_v1
      USING ivfflat (((embedding)::halfvec(${QWEN_DIM})) halfvec_cosine_ops)
      WITH (lists = '200')
  `);
  ivfChecked = true;
}

export interface BackfillRow {
  id: number;
  title: string;
  thumbnail: string;
  keyword: string | null;
}

export async function stampOnly(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = await getPool();
  await pool.query(
    `UPDATE niche_spy_videos SET qwen_embedded_v1_at = NOW() WHERE id = ANY($1::int[])`,
    [ids],
  ).catch(() => {});
}

export async function persistVectors(rows: BackfillRow[], vectors: number[][]): Promise<number> {
  const pool = await getPool();
  let ok = 0;
  for (let i = 0; i < rows.length && i < vectors.length; i++) {
    const r = rows[i];
    const embStr = '[' + vectors[i].join(',') + ']';
    try {
      await vectorPool.query(
        `INSERT INTO niche_video_vectors_qwen_v1 (video_id, keyword, title, embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (video_id) DO UPDATE SET embedding = EXCLUDED.embedding, title = EXCLUDED.title`,
        [r.id, r.keyword, r.title, embStr],
      );
      await pool.query(
        `UPDATE niche_spy_videos SET qwen_embedded_v1_at = NOW() WHERE id = $1`,
        [r.id],
      );
      ok++;
    } catch (err) {
      console.error(`[qwen-embed] persist failed video ${r.id}:`, (err as Error).message);
    }
  }
  return ok;
}

async function noteProgress(note: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO admin_config (key, value) VALUES ('qwen_backfill_last_tick', NOW()::text), ('qwen_backfill_note', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [note.slice(0, 300)],
  ).catch(() => {});
}

let loopRunning = false;
// URL whose /embed endpoint we have PROVEN to support the `pairs` input. An
// older notebook build without pairs 400s every request — without this canary
// the single-item fallback would misread those 400s as bad rows and
// permanently stamp-skip perfectly good videos.
let pairsVerifiedFor: string | null = null;

async function verifyPairsSupport(cfg: { url: string; token: string }): Promise<boolean> {
  if (pairsVerifiedFor === cfg.url) return true;
  try {
    const v = await embedPairsViaQwen([{ text: 'capability canary' }], cfg, 64);
    if (v.length === 1 && v[0].length === 64) {
      pairsVerifiedFor = cfg.url;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Idempotent: first caller starts the eternal loop; later calls no-op. */
export function ensureQwenBackfillRunning(): void {
  if (loopRunning) return;
  loopRunning = true;
  void backfillLoop();
}

async function backfillLoop(): Promise<void> {
  console.log('[qwen-embed] backfill loop started (parks while disabled)');
  await ensureQwenTables().catch(err =>
    console.error('[qwen-embed] table init failed (will retry in loop):', (err as Error).message));
  let consecFailures = 0;

  while (true) {
    try {
      const cfg = await readQwenConfig();
      if (!cfg.enabled || !cfg.url || !cfg.token) {
        await sleep(30_000);
        continue;
      }

      if (!(await verifyPairsSupport(cfg))) {
        await noteProgress('parked: server does not answer pairs (old notebook build or unreachable) - restart Colab with the updated notebook and/or update qwen_embed_url');
        await sleep(60_000);
        continue;
      }

      const pool = await getPool();
      const batch = await pool.query<BackfillRow>(
        `SELECT id, title, thumbnail, keyword
           FROM niche_spy_videos
          WHERE qwen_embedded_v1_at IS NULL
            AND (qwen_claimed_at IS NULL OR qwen_claimed_at < NOW() - INTERVAL '15 minutes')
            AND title IS NOT NULL AND title <> ''
            AND thumbnail IS NOT NULL AND thumbnail <> ''
            AND thumbnail_dead_at IS NULL
          ORDER BY id DESC
          LIMIT $1`,
        [cfg.batch],
      );
      if (batch.rows.length === 0) {
        await noteProgress('queue empty - all eligible videos embedded');
        await sleep(60_000);
        continue;
      }

      const pairs: QwenPair[] = batch.rows.map(r => ({ text: r.title, image: r.thumbnail }));
      let done = 0;
      try {
        const vectors = await embedPairsViaQwen(pairs, cfg);
        done = await persistVectors(batch.rows, vectors);
      } catch (batchErr) {
        // One bad thumbnail 500s the whole request — fall back to singles so a
        // poison row can't wedge the queue head forever.
        console.warn(`[qwen-embed] batch failed, retrying singly: ${(batchErr as Error).message}`);
        for (const row of batch.rows) {
          try {
            const v = await embedPairsViaQwen([{ text: row.title, image: row.thumbnail }], cfg);
            done += await persistVectors([row], v);
          } catch (rowErr) {
            // Permanently skip ONLY on content-level 4xx (bad thumbnail etc.).
            // Connectivity / 5xx / timeout means the ROW may be fine — leave it
            // unstamped and let the outer loop park with backoff.
            const msg = (rowErr as Error).message || '';
            if (/HTTP 4\d\d/.test(msg)) {
              console.warn(`[qwen-embed] skipping video ${row.id} (content error): ${msg.slice(0, 120)}`);
              await stampOnly([row.id]); // stamp with no vector row = skipped
            } else {
              throw rowErr;
            }
          }
        }
      }
      consecFailures = 0;
      await noteProgress(`embedded ${done}/${batch.rows.length} (last id ${batch.rows[0]?.id})`);
      await maybeCreateIvfIndex().catch(() => {});
    } catch (err) {
      // Loop must NEVER die: park with capped backoff (dead ngrok URL, DB blip).
      consecFailures++;
      const wait = Math.min(30_000 * consecFailures, 300_000);
      const msg = (err as Error).message || 'unknown';
      console.error(`[qwen-embed] loop error (${consecFailures} consecutive, parking ${wait / 1000}s): ${msg}`);
      await noteProgress(`error, retrying: ${msg}`);
      await sleep(wait);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
