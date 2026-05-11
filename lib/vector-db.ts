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

// Lazy: VECTOR_DB_URL is only read when something actually queries the
// pool, not at module load. Next.js's "Collecting page data" build pass
// imports this module without prod env vars, so eager throw breaks the
// build. Real callers hit the error at request time with a clear message.
let _vectorPool: Pool | null = null;
const vectorPool: Pool = new Proxy({} as Pool, {
  get(_t, prop) {
    if (!_vectorPool) {
      const url = process.env.VECTOR_DB_URL;
      if (!url) {
        throw new Error('VECTOR_DB_URL env var is required (use the Railway internal hostname pgvector-railway-….railway.internal to avoid public-network egress charges).');
      }
      _vectorPool = new Pool({
        connectionString: url,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
    }
    const v = Reflect.get(_vectorPool, prop, _vectorPool);
    return typeof v === 'function' ? v.bind(_vectorPool) : v;
  },
});

export type EmbeddingSource = 'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined_v2';

const TABLE_BY_SOURCE: Record<EmbeddingSource, string> = {
  title_v1: 'niche_video_vectors',
  title_v2: 'niche_video_vectors_title_v2',
  thumbnail_v2: 'niche_video_vectors_thumb_v2',
  combined_v2: 'niche_video_vectors_combined_v2',
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
    // combined_v2 — joint title+thumbnail multimodal embedding.
    await vectorPool.query(`
      CREATE TABLE IF NOT EXISTS niche_video_vectors_combined_v2 (
        video_id INTEGER PRIMARY KEY,
        keyword TEXT,
        title TEXT,
        embedding vector(3072)
      )
    `);
    // Index for filtering by keyword (similar search is always scoped to same keyword)
    await vectorPool.query(`CREATE INDEX IF NOT EXISTS idx_nvv_t2_keyword ON niche_video_vectors_title_v2(keyword)`).catch(() => {});
    await vectorPool.query(`CREATE INDEX IF NOT EXISTS idx_nvv_th2_keyword ON niche_video_vectors_thumb_v2(keyword)`).catch(() => {});
    await vectorPool.query(`CREATE INDEX IF NOT EXISTS idx_nvv_cb2_keyword ON niche_video_vectors_combined_v2(keyword)`).catch(() => {});

    // Cluster signature vectors — one per niche_tree_cluster, holding
    // the cluster's representative video's combined_v2 embedding. Used
    // by the user-facing semantic-niche-search endpoint to map a text
    // query → most-relevant niches across both L1 and L2.
    //
    // Why rep video instead of true centroid (avg of members): some
    // clusters have very wide spread, so an averaged centroid drifts
    // toward a "thematic average" that doesn't match any real video.
    // The closest-to-centroid rep is already the tightest single point
    // in the cluster — using its vector keeps the signature crisp and
    // grounded in something a user can recognise.
    await vectorPool.query(`
      CREATE TABLE IF NOT EXISTS niche_tree_cluster_vectors (
        cluster_id INTEGER PRIMARY KEY,
        level INTEGER NOT NULL,
        parent_cluster_id INTEGER,
        embedding vector(3072)
      )
    `);
    await vectorPool.query(`CREATE INDEX IF NOT EXISTS idx_ntcv_level ON niche_tree_cluster_vectors(level)`).catch(() => {});
    await vectorPool.query(`CREATE INDEX IF NOT EXISTS idx_ntcv_parent ON niche_tree_cluster_vectors(parent_cluster_id)`).catch(() => {});

    tablesReady = true;
  } catch (err) {
    console.error('[vector-db] ensureVectorTables failed:', (err as Error).message);
  }
}

/** Read the admin-configured similarity source, or default to combined_v2. */
export async function getSimilaritySource(): Promise<EmbeddingSource> {
  try {
    const pool = await getPool();
    const res = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_similarity_source'");
    const v = res.rows[0]?.value;
    if (v === 'title_v1' || v === 'title_v2' || v === 'thumbnail_v2' || v === 'combined_v2') return v;
  } catch { /* fall through */ }
  return 'combined_v2';
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

/**
 * Find videos most similar to an arbitrary embedding vector — used for
 * semantic search where the user types a text query, we embed it via
 * Gemini, and look for videos whose joint title+thumbnail embedding
 * sits closest in the same multimodal space.
 *
 * Unlike findSimilar() this isn't keyword-scoped — semantic search
 * spans the whole library by design (the whole point is "show me
 * videos that match this idea regardless of which scrape keyword
 * surfaced them").
 */
export async function findSimilarByVector(
  embedding: number[],
  options?: { limit?: number; minSimilarity?: number; source?: EmbeddingSource },
): Promise<Array<{ videoId: number; similarity: number }>> {
  const limit = options?.limit || 60;
  const minSimilarity = options?.minSimilarity || 0;
  const source = options?.source || await getSimilaritySource();
  const table = TABLE_BY_SOURCE[source];
  const embStr = '[' + embedding.join(',') + ']';

  const result = await vectorPool.query(
    `SELECT video_id, 1 - (embedding <=> $1::vector) AS similarity
       FROM ${table}
      WHERE 1 - (embedding <=> $1::vector) >= $3
   ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [embStr, limit, minSimilarity],
  );

  return result.rows.map(r => ({
    videoId: r.video_id,
    similarity: Math.round(parseFloat(r.similarity) * 10000) / 10000,
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Cluster signature vectors — one per niche_tree_cluster row, holding
// the rep video's combined_v2 embedding. Powers the "search niches by
// query meaning" endpoint that returns niche cards (L1 + L2) ranked
// by how close they sit to the user's text in the multimodal space.
// ─────────────────────────────────────────────────────────────────────

/**
 * Upsert one cluster's signature vector. Caller passes the cluster row's
 * id, level, parent (for filtering), and the embedding to use as its
 * signature (typically the rep video's combined_v2 vector).
 */
export async function upsertClusterVector(opts: {
  clusterId: number;
  level: number;
  parentClusterId: number | null;
  embedding: number[];
}): Promise<void> {
  await ensureVectorTables();
  const embStr = '[' + opts.embedding.join(',') + ']';
  await vectorPool.query(
    `INSERT INTO niche_tree_cluster_vectors (cluster_id, level, parent_cluster_id, embedding)
     VALUES ($1, $2, $3, $4::vector)
     ON CONFLICT (cluster_id) DO UPDATE
       SET level = EXCLUDED.level,
           parent_cluster_id = EXCLUDED.parent_cluster_id,
           embedding = EXCLUDED.embedding`,
    [opts.clusterId, opts.level, opts.parentClusterId, embStr],
  );
}

/**
 * Pull a single video's combined_v2 vector by video_id. Used by the
 * cluster-vector backfill: we look up each cluster's representative
 * video and copy its vector as the cluster's signature.
 */
export async function getCombinedVectorForVideo(videoId: number): Promise<number[] | null> {
  await ensureVectorTables();
  const r = await vectorPool.query<{ embedding: string }>(
    `SELECT embedding::text AS embedding FROM niche_video_vectors_combined_v2 WHERE video_id = $1`,
    [videoId],
  );
  if (r.rows.length === 0 || !r.rows[0].embedding) return null;
  // pgvector returns a string like '[0.012,-0.034,...]'.
  return JSON.parse(r.rows[0].embedding) as number[];
}

/**
 * Find clusters whose signature vector is closest to a given query
 * embedding. Returns cluster_id + similarity (cosine), descending.
 *
 * Filters: optional level (e.g. 1 = only L1, 2 = only L2, omit = both),
 * minSimilarity floor, limit.
 */
export async function findSimilarClustersByVector(
  embedding: number[],
  options?: { limit?: number; minSimilarity?: number; level?: number; clusterIdAllowlist?: number[] },
): Promise<Array<{ clusterId: number; level: number; parentClusterId: number | null; similarity: number }>> {
  await ensureVectorTables();
  const limit = options?.limit || 60;
  const minSimilarity = options?.minSimilarity || 0;
  const embStr = '[' + embedding.join(',') + ']';

  const where: string[] = [`1 - (embedding <=> $1::vector) >= $3`];
  const params: (string | number | number[])[] = [embStr, limit, minSimilarity];
  if (options?.level !== undefined) {
    where.push(`level = $${params.length + 1}`);
    params.push(options.level);
  }
  // Optional allowlist of cluster_ids — used by search-niches to scope
  // results to the active niche tree (latest L1 run + its L2 subdivides),
  // skipping zombie vectors left behind from old / cancelled runs.
  if (options?.clusterIdAllowlist && options.clusterIdAllowlist.length > 0) {
    where.push(`cluster_id = ANY($${params.length + 1}::int[])`);
    params.push(options.clusterIdAllowlist);
  }

  const result = await vectorPool.query<{ cluster_id: number; level: number; parent_cluster_id: number | null; similarity: string }>(
    `SELECT cluster_id, level, parent_cluster_id, 1 - (embedding <=> $1::vector) AS similarity
       FROM niche_tree_cluster_vectors
      WHERE ${where.join(' AND ')}
   ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    params,
  );

  return result.rows.map(r => ({
    clusterId: r.cluster_id,
    level: r.level,
    parentClusterId: r.parent_cluster_id,
    similarity: Math.round(parseFloat(r.similarity) * 10000) / 10000,
  }));
}

/** Returns the set of cluster_ids that already have a signature vector
 *  stored. Used by the backfill to skip clusters already done. */
export async function getExistingClusterVectorIds(): Promise<Set<number>> {
  await ensureVectorTables();
  const r = await vectorPool.query<{ cluster_id: number }>(
    `SELECT cluster_id FROM niche_tree_cluster_vectors`,
  );
  return new Set(r.rows.map(row => row.cluster_id));
}

/** Count of cluster signature vectors stored. Used by the backfill UI. */
export async function getClusterVectorCount(): Promise<{ total: number; byLevel: Record<number, number> }> {
  await ensureVectorTables();
  const r = await vectorPool.query<{ level: number; cnt: string }>(
    `SELECT level, COUNT(*)::text AS cnt FROM niche_tree_cluster_vectors GROUP BY level ORDER BY level`,
  );
  const byLevel: Record<number, number> = {};
  let total = 0;
  for (const row of r.rows) {
    byLevel[row.level] = parseInt(row.cnt);
    total += parseInt(row.cnt);
  }
  return { total, byLevel };
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

/**
 * Compute the "novelty" of a single video in the combined (title_v2 +
 * thumbnail_v2) embedding space.
 *
 * novelty = mean(cosine_distance) over the K nearest neighbors DB-wide,
 *           averaged across the title_v2 and thumbnail_v2 spaces.
 *
 * Intuition: videos whose title AND thumbnail sit in dense clusters have
 * low novelty (lots of lookalikes). Videos whose title OR thumbnail is
 * sparse have high novelty — either a new topic or a new visual angle.
 *
 * Returns null if the video has no embedding in either space (nothing to
 * score against). Uses ORDER BY embedding <=> vector (distance ascending)
 * + LIMIT K so pgvector's index is exercised — a KNN scan, not a full
 * table scan. Cosine distance is the '<=>' operator output (0 = identical,
 * 2 = opposite); we keep it as distance (not similarity) so higher =
 * more novel, which is the more intuitive ordering.
 *
 * K is clamped to 1..50 (default 10). K+1 rows are fetched because the
 * query includes the source video itself as its own 0-distance neighbor,
 * which we skip.
 */
export async function computeCombinedNovelty(
  videoId: number,
  options?: { k?: number },
): Promise<{ novelty: number | null; titleNovelty: number | null; thumbNovelty: number | null }> {
  const k = Math.max(1, Math.min(50, options?.k ?? 10));

  async function spaceKnn(table: string): Promise<number | null> {
    const src = await vectorPool.query(
      `SELECT embedding FROM ${table} WHERE video_id = $1`,
      [videoId],
    );
    if (src.rows.length === 0) return null;

    // Fetch k+1 because the source video itself appears at distance 0.
    const neighbors = await vectorPool.query(
      `SELECT video_id, embedding <=> $1::vector AS dist
       FROM ${table}
       WHERE video_id != $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [src.rows[0].embedding, videoId, k],
    );
    if (neighbors.rows.length === 0) return null;
    const distances = neighbors.rows.map(r => parseFloat(r.dist));
    return distances.reduce((a, b) => a + b, 0) / distances.length;
  }

  const [titleN, thumbN] = await Promise.all([
    spaceKnn(TABLE_BY_SOURCE.title_v2),
    spaceKnn(TABLE_BY_SOURCE.thumbnail_v2),
  ]);

  // Average the two space-novelties so a video scores high only if BOTH its
  // title and its thumbnail are in sparse regions. If one space is missing,
  // fall back to the other (slightly penalized by 10% so "full-signal"
  // videos outrank "half-signal" ones in the eventual ranking).
  let combined: number | null = null;
  if (titleN != null && thumbN != null) {
    combined = (titleN + thumbN) / 2;
  } else if (titleN != null) {
    combined = titleN * 0.9;
  } else if (thumbN != null) {
    combined = thumbN * 0.9;
  }

  return { novelty: combined, titleNovelty: titleN, thumbNovelty: thumbN };
}

/**
 * Single-space novelty against the combined_v2 multimodal embedding.
 *
 * This is the preferred novelty path now — combined_v2 is at 99% coverage
 * (vs 25% each for title_v2 / thumbnail_v2), so a video almost always has
 * a score. The combined_v2 space also matches what HDBSCAN clusters on,
 * so "novelty" maps to "distance from clusters" in the same geometric
 * basis — same signal, no axis mismatch.
 *
 * novelty = mean cosine distance to the K nearest neighbors in
 *           niche_video_vectors_combined_v2 (excluding self).
 */
export async function computeCombinedV2Novelty(
  videoId: number,
  options?: { k?: number },
): Promise<number | null> {
  const k = Math.max(1, Math.min(50, options?.k ?? 10));
  const src = await vectorPool.query(
    `SELECT embedding FROM niche_video_vectors_combined_v2 WHERE video_id = $1`,
    [videoId],
  );
  if (src.rows.length === 0) return null;
  const neighbors = await vectorPool.query<{ dist: string }>(
    `SELECT embedding <=> $1::vector AS dist
       FROM niche_video_vectors_combined_v2
      WHERE video_id != $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [src.rows[0].embedding, videoId, k],
  );
  if (neighbors.rows.length === 0) return null;
  const distances = neighbors.rows.map(r => parseFloat(r.dist));
  return distances.reduce((a, b) => a + b, 0) / distances.length;
}

/**
 * Batch novelty — writes novelty_score for every video with a
 * combined_v2 embedding.
 *
 * Previously this used title_v2 + thumbnail_v2 (each at ~25% coverage)
 * via TWO KNN queries per video. That capped novelty at ~11% of the
 * dataset and ran out of time on big runs. Switched to combined_v2 —
 * 99% coverage, single KNN per video, half the round trips.
 *
 * mode='missing' (default): only score videos with NULL novelty_score.
 *                           Cheap re-runs after partial failures.
 * mode='all':               re-score everything. Use after a new
 *                           clustering run if you want fresh values.
 *
 * Parallelized with a small worker pool — each worker pulls from a
 * shared queue and writes one row at a time. pgvector handles the
 * concurrent KNN queries fine via HNSW.
 */
export async function recomputeAllNovelty(
  options?: { k?: number; limit?: number; mode?: 'missing' | 'all'; threads?: number },
): Promise<{ scored: number; total: number; mode: string; durationMs: number }> {
  const started = Date.now();
  const k = Math.max(1, Math.min(50, options?.k ?? 10));
  const limit = options?.limit ?? 1_000_000;
  const mode = options?.mode ?? 'missing';
  const threads = Math.max(1, Math.min(options?.threads ?? 20, 50));

  const mainPool = await getPool();

  // Pull the target list from the MAIN db: videos with combined_v2
  // embedded, optionally filtered to those without a novelty_score yet.
  // Using the main db because the vector db doesn't know which videos
  // already have novelty written.
  const targetRes = await mainPool.query<{ id: number }>(
    mode === 'missing'
      ? `SELECT id FROM niche_spy_videos
          WHERE combined_embedded_v2_at IS NOT NULL
            AND novelty_score IS NULL
          ORDER BY id
          LIMIT $1`
      : `SELECT id FROM niche_spy_videos
          WHERE combined_embedded_v2_at IS NOT NULL
          ORDER BY id
          LIMIT $1`,
    [limit],
  );

  const total = targetRes.rows.length;
  if (total === 0) return { scored: 0, total: 0, mode, durationMs: Date.now() - started };

  let scored = 0;
  let idx = 0;
  async function worker() {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= total) return;
      const videoId = targetRes.rows[myIdx].id;
      try {
        const novelty = await computeCombinedV2Novelty(videoId, { k });
        if (novelty == null) continue;
        await mainPool.query(
          `UPDATE niche_spy_videos
             SET novelty_score = $1, novelty_updated_at = NOW()
           WHERE id = $2`,
          [novelty, videoId],
        );
        scored++;
      } catch (err) {
        console.warn(`[novelty] video ${videoId} failed:`, (err as Error).message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(threads, total) }, () => worker()));

  return { scored, total, mode, durationMs: Date.now() - started };
}

export { vectorPool };
