/**
 * Semantic niche search.
 *
 * Embeds a text query in the same combined_v2 multimodal space the
 * cluster signatures live in, then cosine-searches across both L1 and
 * L2 niches. Used by /api/niche-spy/search-niches to drive the
 * user-facing "search by meaning → cluster cards" experience.
 *
 * Cluster signature = the cluster's representative video's
 * combined_embedding_v2 (closest-to-centroid video). See
 * vector-db.ts → upsertClusterVector for why we use rep instead of
 * a true averaged centroid.
 */

import { getPool } from './db';
import { batchEmbedInputs } from './embeddings';
import { upsertClusterVector, getCombinedVectorForVideo, getExistingClusterVectorIds, findSimilarClustersByVector } from './vector-db';

export interface ClusterBackfillProgress {
  total: number;
  processed: number;
  upserted: number;
  skipped: number;          // cluster has no rep video, or rep video has no combined_v2 vector
  errors: number;
}

/**
 * One-shot backfill that walks every niche_tree_clusters row whose
 * representative_video_id has a combined_v2 vector and upserts the
 * cluster's signature into niche_tree_cluster_vectors.
 *
 * Safe to re-run — uses ON CONFLICT cluster_id DO UPDATE so the
 * signature gets refreshed if a cluster's rep video changes.
 *
 * `mode='missing'` only writes signatures for clusters that don't
 * already have one (cheap re-run after partial failures). `mode='all'`
 * forces a refresh — use after a re-cluster run when reps may have
 * shifted.
 */
export async function backfillClusterVectors(opts?: {
  mode?: 'missing' | 'all';
  threads?: number;
  onProgress?: (p: ClusterBackfillProgress) => void;
}): Promise<ClusterBackfillProgress> {
  const pool = await getPool();
  const mode = opts?.mode ?? 'missing';
  const threads = Math.max(1, Math.min(opts?.threads ?? 10, 30));

  // Pull every cluster with a rep video. Filter out ones that already
  // have a signature stored when mode='missing'. The cluster vectors
  // live on a SEPARATE pgvector DB, so we have to query that side
  // separately and subtract — there's no cross-DB join we can lean on.
  const all = await pool.query<{
    id: number; level: number; parent_cluster_id: number | null; representative_video_id: number | null;
  }>(
    `SELECT id, level, parent_cluster_id, representative_video_id
       FROM niche_tree_clusters
      WHERE representative_video_id IS NOT NULL
   ORDER BY level ASC, id ASC`,
  );

  let toProcess = all.rows;
  if (mode === 'missing') {
    try {
      const have = await getExistingClusterVectorIds();
      toProcess = toProcess.filter(c => !have.has(c.id));
    } catch (err) {
      console.warn('[niche-search] could not read existing cluster vectors, processing all:', (err as Error).message);
    }
  }

  const total = toProcess.length;
  let processed = 0, upserted = 0, skipped = 0, errors = 0;

  const emit = () => opts?.onProgress?.({ total, processed, upserted, skipped, errors });
  emit();

  // Shared queue + worker pool — same pattern as the refresh-views
  // worker. Each thread pulls from the queue, looks up the rep video's
  // vector, and upserts the cluster signature. Failures don't block
  // siblings — one missing video shouldn't stall the whole backfill.
  const queue: typeof toProcess = [...toProcess];

  async function worker() {
    while (queue.length > 0) {
      const cluster = queue.shift();
      if (!cluster) return;
      try {
        const repId = cluster.representative_video_id;
        if (!repId) {
          skipped++;
          processed++;
          emit();
          continue;
        }
        const vec = await getCombinedVectorForVideo(repId);
        if (!vec || vec.length === 0) {
          skipped++;
          processed++;
          emit();
          continue;
        }
        await upsertClusterVector({
          clusterId: cluster.id,
          level: cluster.level,
          parentClusterId: cluster.parent_cluster_id,
          embedding: vec,
        });
        upserted++;
      } catch (err) {
        errors++;
        console.warn(`[niche-search] backfill cluster ${cluster.id} failed:`, (err as Error).message);
      } finally {
        processed++;
        emit();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(threads, queue.length) }, () => worker()));

  return { total, processed, upserted, skipped, errors };
}

/**
 * Embed a text query then search cluster signatures. Returns top-N
 * cluster_id + similarity scores. Caller is responsible for hydrating
 * the cluster cards from main DB.
 *
 * Caches the query embedding via the same search_queries table the
 * video search uses — same query string + same source = no Gemini
 * round trip.
 */
export async function searchNichesByText(opts: {
  query: string;
  limit?: number;
  minSimilarity?: number;
  level?: number;
}): Promise<{
  hitFromCache: boolean;
  results: Array<{ clusterId: number; level: number; parentClusterId: number | null; similarity: number }>;
}> {
  const pool = await getPool();
  const raw = opts.query.trim();
  if (!raw) throw new Error('query required');

  const normalised = raw.toLowerCase().replace(/\s+/g, ' ');
  const source = 'combined_v2';

  // Cache lookup — same normalised query + same source means we can
  // reuse the existing video-search cache (the embedding is identical;
  // we're just using it against a different table).
  let embedding: number[] | null = null;
  let hitFromCache = false;
  const cached = await pool.query<{ id: number; embedding: number[] | null; source: string }>(
    `SELECT id, embedding, source FROM search_queries WHERE query = $1`,
    [normalised],
  );
  if (cached.rows.length > 0 && cached.rows[0].embedding && cached.rows[0].source === source) {
    embedding = cached.rows[0].embedding;
    hitFromCache = true;
    await pool.query(
      `UPDATE search_queries SET hit_count = hit_count + 1, last_seen_at = NOW() WHERE id = $1`,
      [cached.rows[0].id],
    );
  }

  if (!embedding) {
    const embeddings = await batchEmbedInputs([{ type: 'text', text: raw }], 'gemini-embedding-2-preview');
    if (embeddings.length === 0 || !embeddings[0] || embeddings[0].length === 0) {
      throw new Error('embedding returned empty vector');
    }
    embedding = embeddings[0];
    await pool.query(
      `INSERT INTO search_queries (query, embedding, source)
       VALUES ($1, $2::real[], $3)
       ON CONFLICT (query) DO UPDATE
          SET embedding = EXCLUDED.embedding,
              source = EXCLUDED.source,
              hit_count = search_queries.hit_count + 1,
              last_seen_at = NOW()`,
      [normalised, `{${embedding.join(',')}}`, source],
    );
  }

  const results = await findSimilarClustersByVector(embedding!, {
    limit: opts.limit ?? 60,
    minSimilarity: opts.minSimilarity ?? 0,
    level: opts.level,
  });
  return { hitFromCache, results };
}
