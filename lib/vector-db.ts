/**
 * pgvector database client for similarity search.
 * Separate from main DB — only stores vectors.
 */

import { Pool } from 'pg';

const VECTOR_DB_URL = process.env.VECTOR_DB_URL ||
  'postgresql://postgres:rLcWspOFJIPFDMbJSDdNlynLgcnupOfY@gondola.proxy.rlwy.net:10303/railway';

const vectorPool = new Pool({
  connectionString: VECTOR_DB_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

/** Store a video embedding */
export async function upsertVector(videoId: number, keyword: string, title: string, embedding: number[]): Promise<void> {
  const embStr = '[' + embedding.join(',') + ']';
  await vectorPool.query(
    `INSERT INTO niche_video_vectors (video_id, keyword, title, embedding)
     VALUES ($1, $2, $3, $4::vector)
     ON CONFLICT (video_id) DO UPDATE SET keyword = $2, title = $3, embedding = $4::vector`,
    [videoId, keyword, title, embStr]
  );
}

/** Find similar videos by cosine similarity within same keyword */
export async function findSimilar(videoId: number, limit: number = 30): Promise<Array<{ videoId: number; similarity: number }>> {
  // Get the source vector's keyword
  const src = await vectorPool.query(
    'SELECT keyword, embedding FROM niche_video_vectors WHERE video_id = $1',
    [videoId]
  );
  if (src.rows.length === 0) return [];

  const { keyword, embedding } = src.rows[0];

  // pgvector cosine distance: <=> operator. Similarity = 1 - distance.
  const result = await vectorPool.query(
    `SELECT video_id, 1 - (embedding <=> $1::vector) as similarity
     FROM niche_video_vectors
     WHERE keyword = $2 AND video_id != $3
     ORDER BY embedding <=> $1::vector
     LIMIT $4`,
    [embedding, keyword, videoId, limit]
  );

  return result.rows.map(r => ({
    videoId: r.video_id,
    similarity: Math.round(parseFloat(r.similarity) * 10000) / 10000,
  }));
}

/** Get vector DB stats */
export async function getVectorStats(): Promise<{ totalVectors: number; keywords: number }> {
  const r = await vectorPool.query(
    'SELECT COUNT(*) as total, COUNT(DISTINCT keyword) as keywords FROM niche_video_vectors'
  );
  return {
    totalVectors: parseInt(r.rows[0].total),
    keywords: parseInt(r.rows[0].keywords),
  };
}

export { vectorPool };
