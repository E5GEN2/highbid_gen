/**
 * pgvector database client for similarity search.
 * Separate from main DB — only stores vectors.
 *
 * Supports three parallel embedding spaces:
 *   - title_v1    → niche_video_vectors            (gemini-embedding-001, titles)
 *   - title_v2    → niche_video_vectors_title_v2   (gemini-embedding-2-preview, titles)
 *   - thumbnail_v2 → niche_video_vectors_thumb_v2  (gemini-embedding-2-preview, thumbnails)
 *
 * Which one is used for similarity search is controlled by the admin_config
 * key `niche_similarity_source` (falls back to `title_v1`).
 */

import { Pool } from 'pg';
import { getPool } from './db';

const VECTOR_DB_URL = process.env.VECTOR_DB_URL ||
  'postgresql://postgres:rLcWspOFJIPFDMbJSDdNlynLgcnupOfY@gondola.proxy.rlwy.net:10303/railway';

const vectorPool = new Pool({
  connectionString: VECTOR_DB_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export type EmbeddingSource = 'title_v1' | 'title_v2' | 'thumbnail_v2';

const TABLE_BY_SOURCE: Record<EmbeddingSource, string> = {
  title_v1: 'niche_video_vectors',
  title_v2: 'niche_video_vectors_title_v2',
  thumbnail_v2: 'niche_video_vectors_thumb_v2',
};

/** Idempotently create the v2 tables on first call. v1 (niche_video_vectors)
 *  was provisioned manually earlier — we don't touch it. */
let tablesReady = false;
export async function ensureVectorTables(): Promise<void> {
  if (tablesReady) return;
  try {
    await vectorPool.query(`
      CREATE TABLE IF NOT EXISTS niche_video_vectors_title_v2 (
        video_id INTEGER PRIMARY KEY,
        keyword TEXT,
        title TEXT,
        embedding vector(3072)
      )
    `);
    await vectorPool.query(`
      CREATE TABLE IF NOT EXISTS niche_video_vectors_thumb_v2 (
        video_id INTEGER PRIMARY KEY,
        keyword TEXT,
        title TEXT,
        embedding vector(3072)
      )
    `);
    // Index for filtering by keyword (similar search is always scoped to same keyword)
    await vectorPool.query(`CREATE INDEX IF NOT EXISTS idx_nvv_t2_keyword ON niche_video_vectors_title_v2(keyword)`).catch(() => {});
    await vectorPool.query(`CREATE INDEX IF NOT EXISTS idx_nvv_th2_keyword ON niche_video_vectors_thumb_v2(keyword)`).catch(() => {});
    tablesReady = true;
  } catch (err) {
    console.error('[vector-db] ensureVectorTables failed:', (err as Error).message);
  }
}

/** Read the admin-configured similarity source, or default to title_v1. */
export async function getSimilaritySource(): Promise<EmbeddingSource> {
  try {
    const pool = await getPool();
    const res = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_similarity_source'");
    const v = res.rows[0]?.value;
    if (v === 'title_v2' || v === 'thumbnail_v2') return v;
  } catch { /* fall through */ }
  return 'title_v1';
}

/** Store a video embedding. `source` picks which table to write to. */
export async function upsertVector(
  videoId: number,
  keyword: string,
  title: string,
  embedding: number[],
  source: EmbeddingSource = 'title_v1',
): Promise<void> {
  await ensureVectorTables();
  const table = TABLE_BY_SOURCE[source];
  const embStr = '[' + embedding.join(',') + ']';
  await vectorPool.query(
    `INSERT INTO ${table} (video_id, keyword, title, embedding)
     VALUES ($1, $2, $3, $4::vector)
     ON CONFLICT (video_id) DO UPDATE SET keyword = $2, title = $3, embedding = $4::vector`,
    [videoId, keyword, title, embStr]
  );
}

/** Find similar videos by cosine similarity within same keyword.
 *  Source defaults to whatever admin_config.niche_similarity_source is set to. */
export async function findSimilar(
  videoId: number,
  options?: { limit?: number; minSimilarity?: number; source?: EmbeddingSource },
): Promise<Array<{ videoId: number; similarity: number }>> {
  const limit = options?.limit || 200;
  const minSimilarity = options?.minSimilarity || 0;
  const source = options?.source || await getSimilaritySource();
  const table = TABLE_BY_SOURCE[source];

  const src = await vectorPool.query(
    `SELECT keyword, embedding FROM ${table} WHERE video_id = $1`,
    [videoId]
  );
  if (src.rows.length === 0) return [];

  const { keyword, embedding } = src.rows[0];

  const result = await vectorPool.query(
    `SELECT video_id, 1 - (embedding <=> $1::vector) as similarity
     FROM ${table}
     WHERE keyword = $2 AND video_id != $3
       AND 1 - (embedding <=> $1::vector) >= $5
     ORDER BY embedding <=> $1::vector
     LIMIT $4`,
    [embedding, keyword, videoId, limit, minSimilarity]
  );

  return result.rows.map(r => ({
    videoId: r.video_id,
    similarity: Math.round(parseFloat(r.similarity) * 10000) / 10000,
  }));
}

/** Vector DB row counts per source — used by the admin stats view. */
export async function getVectorStats(): Promise<{
  title_v1: { totalVectors: number; keywords: number };
  title_v2: { totalVectors: number; keywords: number };
  thumbnail_v2: { totalVectors: number; keywords: number };
}> {
  await ensureVectorTables();
  async function stats(table: string) {
    try {
      const r = await vectorPool.query(`SELECT COUNT(*) as total, COUNT(DISTINCT keyword) as keywords FROM ${table}`);
      return { totalVectors: parseInt(r.rows[0].total), keywords: parseInt(r.rows[0].keywords) };
    } catch {
      return { totalVectors: 0, keywords: 0 };
    }
  }
  const [v1, v2, th2] = await Promise.all([
    stats(TABLE_BY_SOURCE.title_v1),
    stats(TABLE_BY_SOURCE.title_v2),
    stats(TABLE_BY_SOURCE.thumbnail_v2),
  ]);
  return { title_v1: v1, title_v2: v2, thumbnail_v2: th2 };
}

export { vectorPool };
