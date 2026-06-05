/**
 * Seed candidates for the niche-discovery flywheel.
 *
 * Bridges the per-video novelty signal with the per-channel content-gen
 * discovery rules. The result is a list of seed videos that are:
 *   - geometrically isolated in our combined_v2 embedding space (novel),
 *   - posted on a channel that already passes our discovery quality bar
 *     (A1-D2 from data-discovery-rules.json),
 *   - currently gaining views (traction signal).
 *
 * These seeds get fed to xgodo bots via the existing /api/niche-spy/
 * video-seed/expand path. The bots crawl YouTube's related-video graph
 * from each seed → discovered videos land in niche_spy_videos →
 * next clustering run can form new niches around the seed territory.
 *
 * See docs/content-gen/novelty-audit.md for the full design.
 */

import { getPool } from '../db';

export interface SeedCandidate {
  video_id: number;
  video_url: string;
  video_title: string | null;
  video_thumbnail: string | null;
  view_count: number;
  posted_at: string | null;
  novelty_score: number;
  /** 0-1 percentile rank vs. all scored videos. */
  novelty_percentile: number | null;
  channel: {
    channel_id: string;
    channel_name: string | null;
    channel_handle: string | null;
    channel_avatar: string | null;
    subscriber_count: number;
    channel_age_days: number;
    age_tier: 'mature' | 'mid_young' | 'young' | 'ultra_young';
    /** Channel's overall top video views (used by A2 + A3 filters). */
    channel_top_views: number;
    /** Channel's median view count across indexed videos (D2 filter). */
    channel_median_views: number;
    /** Count of channel's videos in our index. */
    videos_indexed: number;
    /** Views-to-subs ratio on top video. */
    views_to_subs_ratio: number;
    /** Channel-quality composite score (matches discoverChannels). */
    composite_score: number;
    peer_outlier_score: number | null;
  };
  /** Combined seed ranking score: isolation × channel quality × traction. */
  seed_score: number;
  /** Sub-scores for debugging / explanation. */
  components: {
    isolation: number;
    channel_quality: number;
    traction: number;
  };
}

export interface SeedDiscoveryOptions {
  /** How many seed candidates to return. Default 30, max 200. */
  topK?: number;
  /** Only consider videos above this novelty percentile (0-100). Default 80 = top 20%. */
  minNoveltyPct?: number;
  /** Min subs (default 10K). */
  minSubs?: number;
  /** Max subs (default 5M). */
  maxSubs?: number;
  /** If true, restrict to the channel's #1 top-view video as the seed. Default false. */
  topVideoOnly?: boolean;
  /** Optionally restrict to long-form only (skip /shorts/ URLs). Default false (any). */
  longFormOnly?: boolean;
}

function ageTier(ageDays: number): SeedCandidate['channel']['age_tier'] {
  if (ageDays > 365) return 'mature';
  if (ageDays > 180) return 'mid_young';
  if (ageDays >  90) return 'young';
  return 'ultra_young';
}

function scaleScore(subs: number): number {
  const mean = 200_000;
  const sd   = 400_000;
  const z = (subs - mean) / sd;
  return Math.exp(-(z * z) / 2);
}

/**
 * Returns seed candidate videos. One row per qualifying (channel, video)
 * pair — typically the channel's most-novel scored video. Channels that
 * fail content-gen filters are excluded; videos below the novelty
 * percentile floor are excluded.
 */
export async function findSeedCandidates(opts: SeedDiscoveryOptions = {}): Promise<SeedCandidate[]> {
  const pool = await getPool();
  const topK = Math.max(1, Math.min(200, opts.topK ?? 30));
  const minNoveltyPct = Math.max(0, Math.min(99.9, opts.minNoveltyPct ?? 80));
  const minSubs = opts.minSubs ?? 10_000;
  const maxSubs = opts.maxSubs ?? 5_000_000;

  // 1) Convert the novelty percentile floor into an absolute novelty
  //    score cutoff. Stored separately from the main query so we can
  //    also use it to report the per-row percentile in the response.
  const cutoffRes = await pool.query<{ cutoff: number | null }>(
    `SELECT PERCENTILE_CONT($1) WITHIN GROUP (ORDER BY novelty_score) AS cutoff
       FROM niche_spy_videos
      WHERE novelty_score IS NOT NULL`,
    [minNoveltyPct / 100],
  );
  const noveltyCutoff = cutoffRes.rows[0]?.cutoff ?? 0;

  // 2) Find seed candidates. The CTE structure:
  //    - candidate_videos: videos in the top novelty bucket (optionally
  //      restricted to long-form / channel top video).
  //    - per_channel: aggregates for content-gen filters (top view,
  //      median view, count, age).
  //    - The main SELECT joins with enrichment + applies A1-D2 filters.
  //
  // Note A2 is age-tiered EXACTLY as in lib/content-gen/discovery.ts.
  // Keep these two SQL fragments in sync — both encode the rule.
  const longFormClause = opts.longFormOnly ? `AND v.url NOT ILIKE '%/shorts/%'` : '';
  const topVideoOnlyClause = opts.topVideoOnly
    ? `AND v.view_count = (
         SELECT MAX(view_count) FROM niche_spy_videos x
         WHERE x.channel_id = v.channel_id AND x.view_count IS NOT NULL
       )`
    : '';

  const rowsRes = await pool.query(
    `WITH candidate_videos AS (
       SELECT v.id, v.url, v.title, v.thumbnail, v.view_count, v.posted_at,
              v.novelty_score, v.channel_id
       FROM niche_spy_videos v
       WHERE v.novelty_score IS NOT NULL
         AND v.novelty_score >= $1
         AND v.channel_id IS NOT NULL
         AND v.view_count IS NOT NULL
         ${longFormClause}
         ${topVideoOnlyClause}
     ),
     per_channel AS (
       SELECT
         v.channel_id,
         COUNT(*)::int AS videos_indexed,
         MAX(v.view_count) AS top_view,
         (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.view_count))::bigint AS median_view,
         MIN(v.channel_created_at) AS chan_created_v,
         MIN(v.posted_at) AS earliest_video_posted_at
       FROM niche_spy_videos v
       WHERE v.channel_id IS NOT NULL AND v.view_count IS NOT NULL
       GROUP BY v.channel_id
     ),
     enriched AS (
       SELECT
         cv.id AS video_id,
         cv.url AS video_url,
         cv.title AS video_title,
         cv.thumbnail AS video_thumbnail,
         cv.view_count AS video_view_count,
         cv.posted_at AS video_posted_at,
         cv.novelty_score,
         pc.channel_id,
         sc.channel_name,
         sc.channel_handle,
         sc.channel_avatar,
         sc.subscriber_count,
         sc.peer_outlier_score,
         COALESCE(sc.channel_created_at, sc.first_upload_at, pc.chan_created_v, pc.earliest_video_posted_at) AS effective_created_at,
         EXTRACT(EPOCH FROM (NOW() - COALESCE(sc.channel_created_at, sc.first_upload_at, pc.chan_created_v, pc.earliest_video_posted_at)))/86400 AS channel_age_days,
         pc.videos_indexed,
         pc.top_view AS channel_top_view,
         pc.median_view AS channel_median_view
       FROM candidate_videos cv
       JOIN per_channel pc ON pc.channel_id = cv.channel_id
       JOIN niche_spy_channels sc ON sc.channel_id = cv.channel_id
       WHERE sc.subscriber_count IS NOT NULL
     )
     SELECT * FROM enriched e
     WHERE
       -- A1: subs band
       e.subscriber_count BETWEEN $2 AND $3
       -- A2: tiered top-video views floor (channel-level)
       AND e.channel_top_view >= CASE
         WHEN e.channel_age_days > 365 THEN 1000000
         WHEN e.channel_age_days > 180 THEN  500000
         WHEN e.channel_age_days >  90 THEN  200000
         ELSE                                100000
       END
       -- A3: top-views / subs ratio
       AND e.channel_top_view > 0
       AND e.channel_top_view::float / NULLIF(e.subscriber_count, 0) >= 5
       -- B1: channel age cap
       AND e.channel_age_days <= 730
       -- B2: this video (the seed) posted within 12 months — keep seeds fresh
       AND e.video_posted_at >= NOW() - INTERVAL '12 months'
       -- D1: ≥5 videos in our index
       AND e.videos_indexed >= 5
       -- D2: not a one-viral-wonder
       AND e.channel_median_view::float / NULLIF(e.channel_top_view, 0) >= 0.05
     ORDER BY e.novelty_score * LN(1 + GREATEST(e.video_view_count, 1)) DESC
     LIMIT 500`,
    [noveltyCutoff, minSubs, maxSubs],
  );

  if (rowsRes.rows.length === 0) return [];

  // 3) Compute per-row percentile rank for the rows we're returning.
  const ids = rowsRes.rows.map((r) => Number(r.video_id));
  const pctRes = await pool.query<{ id: number; pct: number }>(
    `WITH all_scored AS (
       SELECT id, novelty_score,
              PERCENT_RANK() OVER (ORDER BY novelty_score) AS pct
       FROM niche_spy_videos
       WHERE novelty_score IS NOT NULL
     )
     SELECT id, pct FROM all_scored WHERE id = ANY($1::int[])`,
    [ids],
  );
  const pctById = new Map<number, number>(pctRes.rows.map((r) => [Number(r.id), parseFloat(String(r.pct))]));

  // 4) Score + shape the output.
  const seeds: SeedCandidate[] = rowsRes.rows.map((r) => {
    const ageDays = Number(r.channel_age_days) || 0;
    const subs    = Number(r.subscriber_count) || 0;
    const topV    = Number(r.channel_top_view) || 0;
    const medV    = Number(r.channel_median_view) || 0;
    const novelty = Number(r.novelty_score) || 0;
    const views   = Number(r.video_view_count) || 0;
    const peerOut = r.peer_outlier_score != null ? Number(r.peer_outlier_score) : null;
    const ratio   = subs > 0 ? topV / subs : 0;

    // Channel composite — matches lib/content-gen/discovery.ts.
    const recency     = Math.exp(-ageDays / 365);
    const virality    = Math.min(ratio / 100, 1.0);
    const scaleComp   = scaleScore(subs);
    const proofComp   = Math.min(topV / 10_000_000, 1.0);
    const composite   =
      0.30 * recency +
      0.25 * virality +
      0.20 * scaleComp +
      0.15 * proofComp +
      0.10 * 0.5; // novelty component placeholder — we surface the video's novelty separately

    // Seed ranking sub-scores.
    const isolation       = Math.max(0, Math.min(1, novelty));
    const channelQuality  = Math.max(0, Math.min(1, composite));
    // Log-damp + normalise traction so 100M views doesn't dominate.
    const traction        = Math.log1p(views) / Math.log1p(10_000_000);

    const seedScore = isolation * channelQuality * (0.4 + 0.6 * traction);

    return {
      video_id:        Number(r.video_id),
      video_url:       r.video_url,
      video_title:     r.video_title,
      video_thumbnail: r.video_thumbnail,
      view_count:      views,
      posted_at:       r.video_posted_at?.toISOString?.() ?? null,
      novelty_score:   novelty,
      novelty_percentile: pctById.get(Number(r.video_id)) ?? null,
      channel: {
        channel_id:           r.channel_id,
        channel_name:         r.channel_name,
        channel_handle:       r.channel_handle,
        channel_avatar:       r.channel_avatar,
        subscriber_count:     subs,
        channel_age_days:     Math.round(ageDays),
        age_tier:             ageTier(ageDays),
        channel_top_views:    topV,
        channel_median_views: medV,
        videos_indexed:       Number(r.videos_indexed) || 0,
        views_to_subs_ratio:  Math.round(ratio * 10) / 10,
        composite_score:      Math.round(composite * 10000) / 10000,
        peer_outlier_score:   peerOut,
      },
      seed_score:      Math.round(seedScore * 10000) / 10000,
      components: {
        isolation:       Math.round(isolation       * 1000) / 1000,
        channel_quality: Math.round(channelQuality  * 1000) / 1000,
        traction:        Math.round(traction        * 1000) / 1000,
      },
    };
  });

  seeds.sort((a, b) => b.seed_score - a.seed_score);
  return seeds.slice(0, topK);
}
