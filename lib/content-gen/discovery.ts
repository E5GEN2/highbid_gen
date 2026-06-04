/**
 * Channel discovery for content generation.
 *
 * Implements the rules from docs/content-gen/data-discovery-rules.json —
 * given a niche cluster, returns the top-K candidate channels we'd feature
 * in a generated listicle. Same hard filters + composite scoring spec.
 *
 * Hard filters (per data-discovery-rules.json):
 *   A. Scale     — subs ∈ [10K, 5M], top_video ≥ tiered_floor_by_age,
 *                  views/subs ratio ≥ 5×
 *   B. Recency   — channel age ≤ 730d, top video posted ≤ 12mo
 *   C. Topical   — channel sits in the requested cluster
 *   D. Proof     — ≥5 videos, median/top ratio ≥ 0.05 (not one-viral-wonder)
 *
 * Composite score weights: 0.30 recency + 0.25 virality + 0.20 scale
 *                          + 0.15 proof + 0.10 novelty.
 * Phase 2 boosts (consensus_picks, cohort.growth_multiplier) are deferred
 * until we have the corpus/cluster-cohort signals plumbed.
 */

import { getPool } from '../db';

export interface DiscoveryOptions {
  /** Cluster row in niche_tree_clusters whose channels we're picking from. */
  clusterId: number;
  /** How many top candidates to return after scoring. Default 10. */
  topK?: number;
  /** Override scale band floor (default 10_000). */
  minSubs?: number;
  /** Override scale band cap (default 5_000_000). */
  maxSubs?: number;
}

export interface DiscoveryCandidate {
  channel_id: string;
  channel_name: string;
  /** YouTube handle if known (@foo) — used for live screenshot URL construction. */
  channel_handle: string | null;
  channel_avatar: string | null;
  subscriber_count: number;
  channel_age_days: number;
  total_video_count: number | null;
  /** MAX(view_count) over this channel's videos that fall in the cluster. */
  top_video_views: number;
  top_video_id: number;
  top_video_title: string | null;
  top_video_posted_at: string | null;
  /** Distinct videos this channel has in the cluster. */
  videos_in_cluster: number;
  median_video_views: number;
  views_to_subs_ratio: number;
  /** Max novelty_score across this channel's videos in the cluster. */
  novelty_score: number | null;
  /** Per-component scores (0-1) used in the composite. */
  components: {
    recency: number;
    virality: number;
    scale: number;
    proof: number;
    novelty: number;
  };
  /** Final composite score (higher = better pick). */
  composite_score: number;
  /** Which tier (mature / mid_young / young / ultra_young) the channel falls in. */
  age_tier: 'mature' | 'mid_young' | 'young' | 'ultra_young';
}

/**
 * The age-tiered top-video-views floor (A2 from the spec).
 * Younger channels haven't had time to accumulate 1M+ views even if growing
 * fast — relaxing this is our edge over manual researchers who can only find
 * channels after they cross 1M.
 */
function topVideoFloorForAge(ageDays: number): number {
  if (ageDays > 365) return 1_000_000;
  if (ageDays > 180) return   500_000;
  if (ageDays >  90) return   200_000;
  return                       100_000;
}

function ageTier(ageDays: number): DiscoveryCandidate['age_tier'] {
  if (ageDays > 365) return 'mature';
  if (ageDays > 180) return 'mid_young';
  if (ageDays >  90) return 'young';
  return 'ultra_young';
}

/** Bell-curve weight centered on the 200K-sub sweet spot. */
function scaleScore(subs: number): number {
  const mean = 200_000;
  const sd   = 400_000;
  const z = (subs - mean) / sd;
  return Math.exp(-(z * z) / 2);
}

/**
 * Pull candidate channels for a cluster + apply hard filters + score.
 *
 * The SQL does the heavy lifting (group videos by channel, compute aggregates,
 * join channel metadata, apply hard filters). The composite score is computed
 * in Node because the bell-curve weight is easier in JS than in SQL.
 */
export async function discoverChannelsForCluster(
  opts: DiscoveryOptions,
): Promise<DiscoveryCandidate[]> {
  const pool = await getPool();
  const topK = Math.max(1, Math.min(100, opts.topK ?? 10));
  const minSubs = opts.minSubs ?? 10_000;
  const maxSubs = opts.maxSubs ?? 5_000_000;

  // The aggregation:
  //   - JOIN niche_tree_assignments → niche_spy_videos to find the cluster's
  //     videos and their channel_ids
  //   - JOIN niche_spy_channels for sub count + channel age
  //   - GROUP BY channel_id to compute per-channel aggregates (top view, median
  //     view, video count in this cluster, max novelty, etc.)
  //
  // Hard filters applied inline:
  //   A1: subscriber_count between [minSubs, maxSubs]
  //   A2: top_video_views ≥ tier floor (CASE on age)
  //   A3: top_video_views / subscriber_count ≥ 5
  //   B1: channel age days ≤ 730
  //   B2: top video posted within last 12 months
  //   D1: videos_in_cluster ≥ 5 (we relax to "in cluster" — overall channel
  //       video count might be much higher; here we require evidence that the
  //       channel is actually meaningfully present in this niche)
  //   D2: median/top ≥ 0.05 (rejects one-viral-wonders)
  //
  // We use niche_spy_channels.channel_created_at if present, else
  // first_upload_at, else MIN(niche_spy_videos.posted_at) for the channel.
  const sql = `
    WITH cluster_videos AS (
      SELECT
        v.id              AS video_id,
        v.title,
        v.view_count,
        v.posted_at,
        v.channel_id,
        v.channel_created_at,
        v.novelty_score
      FROM niche_tree_assignments a
      JOIN niche_spy_videos v ON v.id = a.video_id
      WHERE a.cluster_id = $1
        AND v.channel_id IS NOT NULL
        AND v.view_count IS NOT NULL
    ),
    per_channel AS (
      SELECT
        cv.channel_id,
        COUNT(*)::int                                            AS videos_in_cluster,
        MAX(cv.view_count)                                       AS top_video_views,
        (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cv.view_count))::bigint
                                                                  AS median_video_views,
        MAX(cv.novelty_score)                                    AS max_novelty,
        MIN(cv.channel_created_at)                               AS channel_created_at_v,
        MIN(cv.posted_at)                                        AS earliest_video_posted_at
      FROM cluster_videos cv
      GROUP BY cv.channel_id
    ),
    top_video_per_channel AS (
      SELECT DISTINCT ON (cv.channel_id)
        cv.channel_id,
        cv.video_id AS top_video_id,
        cv.title    AS top_video_title,
        cv.posted_at AS top_video_posted_at
      FROM cluster_videos cv
      ORDER BY cv.channel_id, cv.view_count DESC NULLS LAST
    ),
    enriched AS (
      SELECT
        pc.channel_id,
        sc.channel_name,
        sc.channel_handle,
        sc.channel_avatar,
        sc.subscriber_count,
        sc.video_count AS total_video_count,
        COALESCE(sc.channel_created_at, sc.first_upload_at, pc.channel_created_at_v, pc.earliest_video_posted_at)
                                                                 AS effective_created_at,
        pc.videos_in_cluster,
        pc.top_video_views,
        pc.median_video_views,
        pc.max_novelty,
        tv.top_video_id,
        tv.top_video_title,
        tv.top_video_posted_at
      FROM per_channel pc
      JOIN niche_spy_channels sc ON sc.channel_id = pc.channel_id
      JOIN top_video_per_channel tv ON tv.channel_id = pc.channel_id
      WHERE sc.subscriber_count IS NOT NULL
    )
    SELECT
      e.channel_id,
      e.channel_name,
      e.channel_handle,
      e.channel_avatar,
      e.subscriber_count,
      e.total_video_count,
      e.effective_created_at,
      e.videos_in_cluster,
      e.top_video_views,
      e.median_video_views,
      e.max_novelty,
      e.top_video_id,
      e.top_video_title,
      e.top_video_posted_at,
      EXTRACT(EPOCH FROM (NOW() - e.effective_created_at)) / 86400 AS channel_age_days
    FROM enriched e
    WHERE e.subscriber_count BETWEEN $2 AND $3
      AND e.top_video_views::float / e.subscriber_count >= 5
      AND e.top_video_views >= (
        CASE
          WHEN EXTRACT(EPOCH FROM (NOW() - e.effective_created_at))/86400 > 365 THEN 1000000
          WHEN EXTRACT(EPOCH FROM (NOW() - e.effective_created_at))/86400 > 180 THEN  500000
          WHEN EXTRACT(EPOCH FROM (NOW() - e.effective_created_at))/86400 >  90 THEN  200000
          ELSE                                                                       100000
        END
      )
      AND EXTRACT(EPOCH FROM (NOW() - e.effective_created_at))/86400 <= 730
      AND e.top_video_posted_at >= NOW() - INTERVAL '12 months'
      AND e.videos_in_cluster >= 5
      AND e.median_video_views::float / e.top_video_views >= 0.05
    ORDER BY e.top_video_views DESC NULLS LAST
    LIMIT 200
  `;

  const rows = await pool.query(sql, [opts.clusterId, minSubs, maxSubs]);

  // Score each candidate.
  const scored: DiscoveryCandidate[] = rows.rows.map((r) => {
    const ageDays = Number(r.channel_age_days) || 0;
    const subs    = Number(r.subscriber_count) || 0;
    const topV    = Number(r.top_video_views) || 0;
    const medV    = Number(r.median_video_views) || 0;
    const novelty = r.max_novelty != null ? Number(r.max_novelty) : null;

    const ratio = subs > 0 ? topV / subs : 0;

    const recency  = Math.exp(-ageDays / 365);
    const virality = Math.min(ratio / 100, 1.0);
    const scale    = scaleScore(subs);
    const proof    = Math.min(topV / 10_000_000, 1.0);
    // novelty_score in our DB is the mean cosine distance to K nearest
    // (already in [0, 1] range; higher = more novel).
    const noveltyComp = novelty != null ? Math.max(0, Math.min(1, novelty)) : 0.5;

    const composite =
      0.30 * recency +
      0.25 * virality +
      0.20 * scale +
      0.15 * proof +
      0.10 * noveltyComp;

    return {
      channel_id:           r.channel_id,
      channel_name:         r.channel_name,
      channel_handle:       r.channel_handle,
      channel_avatar:       r.channel_avatar,
      subscriber_count:     subs,
      channel_age_days:     Math.round(ageDays),
      total_video_count:    r.total_video_count != null ? Number(r.total_video_count) : null,
      top_video_views:      topV,
      top_video_id:         Number(r.top_video_id),
      top_video_title:      r.top_video_title,
      top_video_posted_at:  r.top_video_posted_at?.toISOString?.() ?? null,
      videos_in_cluster:    Number(r.videos_in_cluster),
      median_video_views:   medV,
      views_to_subs_ratio:  Math.round(ratio * 10) / 10,
      novelty_score:        novelty,
      components: {
        recency:  Math.round(recency  * 1000) / 1000,
        virality: Math.round(virality * 1000) / 1000,
        scale:    Math.round(scale    * 1000) / 1000,
        proof:    Math.round(proof    * 1000) / 1000,
        novelty:  Math.round(noveltyComp * 1000) / 1000,
      },
      composite_score: Math.round(composite * 10000) / 10000,
      age_tier:        ageTier(ageDays),
    };
  });

  // Sort by composite descending, take top-K.
  scored.sort((a, b) => b.composite_score - a.composite_score);
  return scored.slice(0, topK);
}

/**
 * Apply assembly gates across the full pool from N niche calls.
 *
 * Per data-discovery-rules.json:
 *   Gate 1. Cap consensus picks (Phase 2 — not implemented yet, requires
 *           corpus of referenced channels which we don't have at scale).
 *   Gate 2. Niche-cluster saturation — each niche gets at most K channels;
 *           no two niches share cluster_id. (Caller responsibility — we
 *           don't enforce here because this function operates on a single
 *           cluster's picks.)
 *   Gate 3. Scale diversity — within one listicle, want at least 1 channel
 *           per subscriber band [10K-100K], [100K-1M], [1M-5M] for
 *           narrative rhythm.
 *
 * This helper provides Gate 3 — given a flat list of candidates from many
 * clusters, return a balanced selection that hits the scale bands.
 */
export function balanceByScaleBand(
  candidates: DiscoveryCandidate[],
  targetTotal: number,
): DiscoveryCandidate[] {
  const small = candidates.filter((c) => c.subscriber_count <  100_000);
  const mid   = candidates.filter((c) => c.subscriber_count >= 100_000 && c.subscriber_count < 1_000_000);
  const big   = candidates.filter((c) => c.subscriber_count >= 1_000_000);

  const out: DiscoveryCandidate[] = [];
  const seen = new Set<string>();
  const take = (pool: DiscoveryCandidate[]) => {
    for (const c of pool) {
      if (seen.has(c.channel_id)) continue;
      out.push(c);
      seen.add(c.channel_id);
      return true;
    }
    return false;
  };

  // First pass — guarantee at least one from each band if available.
  take(small);
  take(mid);
  take(big);

  // Fill the remainder by overall composite score, skipping already-picked.
  for (const c of candidates) {
    if (out.length >= targetTotal) break;
    if (seen.has(c.channel_id)) continue;
    out.push(c);
    seen.add(c.channel_id);
  }

  return out.slice(0, targetTotal);
}
