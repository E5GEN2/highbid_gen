/**
 * Similar-channel discovery for channel_b_proof / saturation_callout —
 * embedding similarity over the WHOLE rofe library (user design
 * 2026-06-11): take the hero channel's top video, KNN its
 * combined_embedding_v2 (3072-dim, 533K videos) on the dedicated
 * pgvector DB, aggregate hits to channels.
 *
 * Connections:
 *  - vector DB: VECTOR_DB_URL (pgvector; table niche_video_vectors_combined_v2)
 *  - main DB:   HB_RAILWAY_DB_URL when set (local runs — the local mirror
 *               has neither the embeddings nor the arbitrary candidate
 *               video rows), else DATABASE_URL (Railway prod).
 *
 * Tuning (probed on phantomized: Size Cipher/Nonagon/MrUnnerving at
 * 0.83-0.88; 169 channels >= 0.55):
 *  - channel B requires sim >= CHANNEL_B_MIN_SIM (same-format bar)
 *  - saturation fires when >= SATURATION_MIN_CHANNELS channels clear
 *    SATURATION_MIN_SIM (worked-example rule: cluster_size > 20)
 */

import pg from 'pg';

const CHANNEL_B_MIN_SIM = 0.78;
const SATURATION_MIN_SIM = 0.55;
const SATURATION_MIN_CHANNELS = 20;
const KNN_LIMIT = 300;

export interface SimilarChannel {
  channel_id: string;
  channel_name: string | null;
  similarity: number;
  subscriber_count: number | null;
}

export interface SimilarChannelsResult {
  /** Best same-format matches (sim >= CHANNEL_B_MIN_SIM), ranked. */
  channels: SimilarChannel[];
  /** # of distinct channels with sim >= SATURATION_MIN_SIM. */
  saturationCount: number;
  saturated: boolean;
  /** Top channel ids (looser bar) for the saturation logos montage. */
  montagePool: string[];
}

let mainPool: pg.Pool | null = null;
let vecPool: pg.Pool | null = null;

function getMainPool(): pg.Pool {
  if (!mainPool) {
    const url = process.env.HB_RAILWAY_DB_URL || process.env.DATABASE_URL;
    if (!url) throw new Error('similar-channels: no DB url');
    mainPool = new pg.Pool({ connectionString: url, ssl: false, max: 3 });
    // Swallow idle-client 'error' (transient Railway-proxy drop) — without a handler
    // it's an unhandled event that crashes the render (read ETIMEDOUT, 2026-06-27).
    mainPool.on('error', (e) => console.warn(`[similar-channels] idle main-pool client error (ignored): ${e.message}`));
  }
  return mainPool;
}
function getVecPool(): pg.Pool {
  if (!vecPool) {
    const url = process.env.VECTOR_DB_URL;
    if (!url) throw new Error('similar-channels: VECTOR_DB_URL not set');
    vecPool = new pg.Pool({ connectionString: url, ssl: false, max: 3 });
    vecPool.on('error', (e) => console.warn(`[similar-channels] idle vec-pool client error (ignored): ${e.message}`));
  }
  return vecPool;
}

/**
 * Find channels similar to the hero's top video. `exclude` removes the
 * hero itself plus the other channels of the current listicle (channel B
 * must be a fresh face, not item #7 of the same video).
 */
export async function findSimilarChannels(
  heroChannelId: string,
  exclude: string[] = [],
): Promise<SimilarChannelsResult> {
  const main = getMainPool();
  const vec = getVecPool();

  const top = await main.query<{ id: number; combined_embedding_v2: number[] }>(
    `SELECT id, combined_embedding_v2 FROM niche_spy_videos
      WHERE channel_id = $1 AND combined_embedding_v2 IS NOT NULL
      ORDER BY view_count DESC NULLS LAST LIMIT 1`, [heroChannelId]);
  if (top.rows.length === 0) return { channels: [], saturationCount: 0, saturated: false, montagePool: [] };

  const emb = '[' + top.rows[0].combined_embedding_v2.join(',') + ']';
  const knn = await vec.query<{ video_id: number; sim: string }>(
    `SELECT video_id, 1 - (embedding <=> $1::vector) AS sim
       FROM niche_video_vectors_combined_v2
      ORDER BY embedding <=> $1::vector
      LIMIT $2`, [emb, KNN_LIMIT]);

  const ids = knn.rows.map(r => r.video_id);
  const map = await main.query<{ id: number; channel_id: string }>(
    `SELECT id, channel_id FROM niche_spy_videos WHERE id = ANY($1)`, [ids]);
  const chOf = new Map(map.rows.map(r => [r.id, r.channel_id]));

  const excluded = new Set([heroChannelId, ...exclude]);
  const hits = new Map<string, number[]>();
  for (const r of knn.rows) {
    const ch = chOf.get(r.video_id);
    if (!ch || excluded.has(ch)) continue;
    const sim = parseFloat(r.sim);
    if (!hits.has(ch)) hits.set(ch, []);
    hits.get(ch)!.push(sim);
  }
  // FORMAT-CONSISTENCY scoring (2026-06-11): a channel whose WHOLE
  // CATALOG matches beats a channel with one lucky close video — e.g.
  // Size Cipher (many size-comparison hits) must outrank Nonagon (one
  // adjacent explainer). score = 0.6*best + 0.3*second + count bonus.
  const best = new Map<string, number>();   // best sim (for thresholds)
  const score = new Map<string, number>();  // ranking score
  for (const [ch, sims] of hits) {
    sims.sort((a, b) => b - a);
    best.set(ch, sims[0]);
    score.set(ch, 0.6 * sims[0] + 0.3 * (sims[1] ?? sims[0] * 0.9) + 0.015 * Math.min(sims.length, 6));
  }

  const saturationCount = [...best.values()].filter(s => s >= SATURATION_MIN_SIM).length;
  // Top-10 (was 3): the channel_b loop tries these in order until one clears the
  // min-stats gate + relationship + capture-feasibility checks. Top-3 was too
  // tight — the closest matches are often tiny niche-mates (<5K subs) while the
  // big qualifying channels sit at rank 4-8 (user 2026-06-26: e.g. "Old Money
  // Dynasty" had 83 gate-passing candidates but ranks 1-5 were all <1.3K subs,
  // the real B at rank 6/8). Widening surfaces them so channel_b populates.
  const strong = [...score.entries()]
    .filter(([ch]) => best.get(ch)! >= CHANNEL_B_MIN_SIM)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  let channels: SimilarChannel[] = [];
  if (strong.length) {
    const rows = await main.query<{ channel_id: string; channel_name: string | null; subscriber_count: number | null }>(
      `SELECT channel_id, channel_name, subscriber_count FROM niche_spy_channels WHERE channel_id = ANY($1)`,
      [strong.map(([c]) => c)]);
    const info = new Map(rows.rows.map(r => [r.channel_id, r]));
    channels = strong.map(([channel_id]) => ({
      channel_id,
      similarity: Math.round((best.get(channel_id) ?? 0) * 1000) / 1000,
      channel_name: info.get(channel_id)?.channel_name ?? null,
      subscriber_count: info.get(channel_id)?.subscriber_count != null ? Number(info.get(channel_id)!.subscriber_count) : null,
    }));
  }
  const montagePool = [...score.entries()]
    .filter(([ch]) => best.get(ch)! >= SATURATION_MIN_SIM)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([c]) => c);
  return { channels, saturationCount, saturated: saturationCount >= SATURATION_MIN_CHANNELS, montagePool };
}
