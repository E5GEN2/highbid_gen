/**
 * Channel discovery for content generation.
 *
 * Implements the rules from docs/content-gen/data-discovery-rules.json —
 * sweeps our DB for channels passing the hard filters, attaches the cluster
 * each one sits in (their top video's cluster = their "showcase niche"),
 * scores by composite, and returns top-K.
 *
 * DIRECTION: discovery is across the DB. Cluster is the OUTPUT label that
 * tells us which niche to feature the channel under in the listicle. It's
 * NOT an input filter (we don't ask "give me channels for cluster X" — we
 * ask "give me channels passing the rules, what cluster does each one
 * belong to?").
 *
 * Optional scoping:
 *   scopeRunId    — limit to videos in this specific clustering run
 *   scopeClusterId — limit to videos in a specific cluster (rare; for
 *                    debugging a single niche)
 *
 * Hard filters (per data-discovery-rules.json):
 *   A. Scale     — subs ∈ [10K, 5M], top_video ≥ tiered_floor_by_age,
 *                  views/subs ratio ≥ 5×
 *   B. Recency   — channel age ≤ 730d, top video posted ≤ 12mo
 *   C. Topical   — channel's top video is in SOME cluster (not a specific
 *                  one unless scopeClusterId given)
 *   D. Proof     — ≥5 videos in our index, median/top ratio ≥ 0.05
 *
 * Composite score weights: 0.30 recency + 0.25 virality + 0.20 scale
 *                          + 0.15 proof + 0.10 novelty.
 */

import { getPool } from '../db';

export interface DiscoveryOptions {
  /** How many top candidates to return after scoring. Default 50. */
  topK?: number;
  /** Override scale band floor (default 10_000). */
  minSubs?: number;
  /** Override scale band cap (default 5_000_000). */
  maxSubs?: number;
  /** Optional: limit videos to a specific clustering run id. */
  scopeRunId?: number;
  /** Optional: limit to one cluster (rare — for debugging a single niche). */
  scopeClusterId?: number;
}

export interface ChannelCluster {
  cluster_id: number;
  /** 1 = top-level niche, 2 = sub-niche (subdivided from an L1). */
  level: 1 | 2;
  cluster_label: string | null;
  /** Only for L2: the L1 parent cluster id. Null for L1 clusters. */
  parent_cluster_id: number | null;
  /** Distinct videos in this cluster overall (across the cluster, not just this channel). */
  cluster_video_count: number;
  /** This channel's video count in this cluster. */
  channel_videos_in_cluster: number;
  /** Clustering run that produced this assignment. */
  run_id: number;
  run_kind: string | null;
}

/**
 * A channel can sit in BOTH an L1 niche AND an L2 sub-niche (or one or
 * neither). The listicle assembler decides which granularity to use:
 *   - L1 = broad-niche listicle ("Top 10 faceless YouTube niches")
 *   - L2 = specific-sub-niche listicle ("Top 10 niches inside
 *          Faceless YouTube") — finer-grained, more specific
 *
 * Both are populated by the latest assignment at each level when
 * available.
 */
export interface ShowcaseClusters {
  l1: ChannelCluster | null;
  l2: ChannelCluster | null;
}

export interface DiscoveryCandidate {
  channel_id: string;
  channel_name: string;
  channel_handle: string | null;
  channel_avatar: string | null;
  subscriber_count: number;
  channel_age_days: number;
  total_video_count: number | null;
  /** MAX(view_count) over this channel's videos in our index. */
  top_video_views: number;
  top_video_id: number;
  top_video_title: string | null;
  top_video_thumbnail: string | null;
  /** YouTube watch URL from niche_spy_videos.url — used by the GUI to open the video. */
  top_video_url: string | null;
  top_video_posted_at: string | null;
  /** Distinct videos this channel has in our niche_spy_videos index. */
  videos_indexed: number;
  median_video_views: number;
  views_to_subs_ratio: number;
  /** Max novelty_score across this channel's indexed videos. */
  novelty_score: number | null;
  /**
   * The clusters this channel's top video sits in — split by level.
   * Either or both may be null. The listicle assembler chooses which
   * granularity to build at.
   */
  showcase_clusters: ShowcaseClusters;
  components: {
    recency: number;
    virality: number;
    scale: number;
    proof: number;
    novelty: number;
  };
  composite_score: number;
  age_tier: 'mature' | 'mid_young' | 'young' | 'ultra_young';
}

/** Predominantly-non-Latin-script detector for the English-only pool gate.
 *  Counts letters (\p{L}); true when ≥50% are non-Latin script (Cyrillic, CJK,
 *  Tamil, Arabic, Devanagari, Thai, Hangul, …). Accented Latin (café), digits,
 *  emoji and punctuation never trigger it, so genuine English channels are
 *  never dropped. Latin-script non-English (es/pt/fr) is left to the
 *  language-analysis gate, which catches them when analysis exists. */
function looksNonEnglishByScript(text: string | null | undefined): boolean {
  if (!text) return false;
  let letters = 0, nonLatin = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    if (!/\p{Script=Latin}/u.test(ch)) nonLatin++;
  }
  return letters > 0 && nonLatin / letters >= 0.5;
}

/** Explicit foreign-language labels that appear in otherwise-Latin channel
 *  names ("… en Español", "ZuZoo en Español", "Crime Dynasty Español") — these
 *  are Latin-script so the ratio check above misses them, but the label is an
 *  unambiguous self-declaration of non-English content. High precision: each
 *  token is a language endonym, matched as a whole word. */
const FOREIGN_LANG_LABEL =
  /\b(?:en\s+)?(?:espa[nñ]ol|portugu[eê]s|fran[cç]ais|italiano|deutsch|t[uü]rk[cç]e|bahasa|polski|nederlands|svenska|tagalog)\b/iu;

/** The English-only pool decision used to filter draft/hero candidates that
 *  the SQL language gate misses (no/empty analysis). Exported so the
 *  cg-eligibility tracker (lib/content-gen/cg-eligibility.ts) reuses the EXACT
 *  same script gate rather than re-implementing it (single source of truth). */
export function isNonEnglishChannel(name: string | null | undefined, title: string | null | undefined): boolean {
  return looksNonEnglishByScript(name)
      || looksNonEnglishByScript(title)
      || FOREIGN_LANG_LABEL.test(name ?? '');
}

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

function scaleScore(subs: number): number {
  const mean = 200_000;
  const sd   = 400_000;
  const z = (subs - mean) / sd;
  return Math.exp(-(z * z) / 2);
}

/**
 * Sweep the DB for candidate channels passing the discovery rules.
 *
 * Strategy: do the channel aggregation across ALL of niche_spy_videos (or
 * scoped to a run / cluster if given), apply hard filters, then in a
 * second pass find each surviving channel's top-video's cluster
 * assignment (their "showcase niche").
 */
export async function discoverChannels(
  opts: DiscoveryOptions = {},
): Promise<DiscoveryCandidate[]> {
  const pool = await getPool();
  const topK = Math.max(1, Math.min(500, opts.topK ?? 50));
  const minSubs = opts.minSubs ?? 10_000;
  const maxSubs = opts.maxSubs ?? 5_000_000;

  // ── PASS 1: aggregate per channel, apply hard filters ──────────────
  //
  // The scope CTE picks which niche_spy_videos rows we consider:
  //   - default: all rows with channel_id + view_count not null
  //   - scoped to a run: rows that have an assignment in that run
  //   - scoped to a cluster: rows assigned to that cluster
  //
  // The hard filters all run on per-channel aggregates against
  // niche_spy_channels enrichment data (subs, age).
  const params: (number | undefined)[] = [minSubs, maxSubs];
  let scopeJoin = '';
  if (opts.scopeRunId != null) {
    scopeJoin = `JOIN niche_tree_assignments sa ON sa.video_id = v.id AND sa.run_id = $${params.length + 1}`;
    params.push(opts.scopeRunId);
  } else if (opts.scopeClusterId != null) {
    scopeJoin = `JOIN niche_tree_assignments sa ON sa.video_id = v.id AND sa.cluster_id = $${params.length + 1}`;
    params.push(opts.scopeClusterId);
  }

  const sql = `
    WITH per_channel AS (
      SELECT
        v.channel_id,
        COUNT(*)::int                                            AS videos_indexed,
        MAX(v.view_count)                                        AS top_video_views,
        (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.view_count))::bigint
                                                                  AS median_video_views,
        MAX(v.novelty_score)                                     AS max_novelty,
        MIN(v.channel_created_at)                                AS channel_created_at_v,
        MIN(v.posted_at)                                         AS earliest_video_posted_at
      FROM niche_spy_videos v
      ${scopeJoin}
      WHERE v.channel_id IS NOT NULL
        AND v.view_count IS NOT NULL
        AND v.thumbnail_dead_at IS NULL
      GROUP BY v.channel_id
    ),
    top_video_per_channel AS (
      -- thumbnail_dead_at IS NULL excludes videos taken down on YouTube.
      -- Without this we'd pick a dead-video as a channel's "top" and
      -- show a broken thumbnail in the GUI / a dead URL in the script.
      SELECT DISTINCT ON (v.channel_id)
        v.channel_id,
        v.id AS top_video_id,
        v.title AS top_video_title,
        v.thumbnail AS top_video_thumbnail,
        v.url AS top_video_url,
        v.posted_at AS top_video_posted_at
      FROM niche_spy_videos v
      ${scopeJoin}
      WHERE v.channel_id IS NOT NULL
        AND v.view_count IS NOT NULL
        AND v.thumbnail_dead_at IS NULL
      ORDER BY v.channel_id, v.view_count DESC NULLS LAST
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
        pc.videos_indexed,
        pc.top_video_views,
        pc.median_video_views,
        pc.max_novelty,
        tv.top_video_id,
        tv.top_video_title,
        tv.top_video_thumbnail,
        tv.top_video_url,
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
      e.videos_indexed,
      e.top_video_views,
      e.median_video_views,
      e.max_novelty,
      e.top_video_id,
      e.top_video_title,
      e.top_video_thumbnail,
      e.top_video_url,
      e.top_video_posted_at,
      EXTRACT(EPOCH FROM (NOW() - e.effective_created_at)) / 86400 AS channel_age_days
    FROM enriched e
    WHERE e.subscriber_count BETWEEN $1 AND $2
      AND e.channel_id NOT IN (SELECT channel_id FROM content_gen_used_channels)
      -- ENGLISH-ONLY hero/draft pool (user 2026-06-20 #5): drop channels whose
      -- analysis says a non-English primary language. Channels with no analysis
      -- or an English language ("en", "en-US", …) stay. Because drafts regen
      -- from this pool, an existing group with a non-English member simply
      -- refills that slot with the next English candidate — it is NOT deleted.
      -- Non-English SIMILAR channels (channel_b / saturation) are unaffected:
      -- this gate is only on the draft/hero pool.
      AND NOT EXISTS (
        SELECT 1 FROM channel_analysis ca
        WHERE ca.channel_id = e.channel_id AND ca.language IS NOT NULL AND ca.language NOT ILIKE 'en%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM content_gen_channel_analysis cga
        WHERE cga.channel_id = e.channel_id AND cga.language IS NOT NULL AND cga.language NOT ILIKE 'en%'
      )
      AND e.top_video_views > 0
      AND e.top_video_views::float / NULLIF(e.subscriber_count, 0) >= 5
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
      AND e.videos_indexed >= 5
      AND e.median_video_views::float / NULLIF(e.top_video_views, 0) >= 0.05
    ORDER BY e.top_video_views DESC NULLS LAST
    LIMIT 500
  `;

  const rows = await pool.query(sql, params);

  if (rows.rows.length === 0) return [];

  // ── PASS 2: attach the showcase_cluster per candidate ──────────────
  //
  // For each candidate's top_video_id, find what cluster (if any) it's
  // assigned to in the LATEST clustering run that has an assignment for
  // it. Joining niche_tree_clusters for the label + niche_tree_runs for
  // the run kind. Channels whose top video isn't in any cluster get
  // showcase_cluster=null (still surfaced — caller can decide to drop
  // or rank lower).
  const topVideoIds = rows.rows.map((r) => Number(r.top_video_id));
  /** Map<top_video_id, { l1, l2 }>. Either entry can be null. */
  const clusterMap = new Map<number, ShowcaseClusters>();
  // Fetch latest L1 and latest L2 per video — `DISTINCT ON (video_id, level)`
  // ordered by run.started_at picks the most recent assignment at each level.
  // COALESCE picks the best available label (user-edited → ai → auto).
  const clusterRes = await pool.query<{
    video_id: number;
    level: number;
    cluster_id: number;
    cluster_label: string | null;
    parent_cluster_id: number | null;
    cluster_video_count: number;
    run_id: number;
    run_kind: string | null;
  }>(
    // We have multiple global runs over time + subdivide runs per L1
    // parent. To get ONE canonical (L1, L2) per video, restrict to:
    //   L1: clusters from THE latest done global run
    //   L2: clusters from the latest subdivide for each L1 parent
    // Aligns discover output with overwatch's ready_clusters list so
    // candidates' showcase cluster_id is the same id the overwatch
    // surfaces.
    `WITH latest_global AS (
       SELECT id FROM niche_tree_runs
       WHERE kind = 'global' AND status = 'done'
       ORDER BY started_at DESC NULLS LAST LIMIT 1
     ),
     latest_subdivide_per_parent AS (
       SELECT DISTINCT ON (parent_cluster_id) id, parent_cluster_id
       FROM niche_tree_runs
       WHERE kind = 'subdivide' AND status = 'done'
       ORDER BY parent_cluster_id, started_at DESC NULLS LAST
     )
     SELECT DISTINCT ON (a.video_id, c.level)
       a.video_id,
       c.level,
       a.cluster_id,
       COALESCE(c.label, c.ai_label, c.auto_label) AS cluster_label,
       c.parent_cluster_id,
       c.video_count AS cluster_video_count,
       a.run_id,
       r.kind AS run_kind
     FROM niche_tree_assignments a
     JOIN niche_tree_clusters c ON c.id = a.cluster_id
     JOIN niche_tree_runs r ON r.id = a.run_id
     WHERE a.video_id = ANY($1::int[])
       AND a.cluster_id IS NOT NULL
       AND (
         (c.level = 1 AND r.id = (SELECT id FROM latest_global))
         OR
         (c.level = 2 AND r.id IN (SELECT id FROM latest_subdivide_per_parent))
       )
     ORDER BY a.video_id, c.level, r.started_at DESC NULLS LAST`,
    [topVideoIds],
  );
  for (const r of clusterRes.rows) {
    const vid = Number(r.video_id);
    const existing = clusterMap.get(vid) ?? { l1: null, l2: null };
    const cc: ChannelCluster = {
      cluster_id:                Number(r.cluster_id),
      level:                     Number(r.level) === 2 ? 2 : 1,
      cluster_label:             r.cluster_label,
      parent_cluster_id:         r.parent_cluster_id != null ? Number(r.parent_cluster_id) : null,
      cluster_video_count:       Number(r.cluster_video_count) || 0,
      channel_videos_in_cluster: 0,
      run_id:                    Number(r.run_id),
      run_kind:                  r.run_kind,
    };
    if (cc.level === 1) existing.l1 = cc;
    else                existing.l2 = cc;
    clusterMap.set(vid, existing);
  }

  // Count, per (channel, cluster_id), how many of THIS channel's videos
  // sit in the cluster. Computed across both L1 and L2 cluster ids we
  // care about. Gives us "this channel has N videos in this niche" — a
  // narrative signal.
  const allClusterIds = new Set<number>();
  for (const cm of clusterMap.values()) {
    if (cm.l1) allClusterIds.add(cm.l1.cluster_id);
    if (cm.l2) allClusterIds.add(cm.l2.cluster_id);
  }
  if (allClusterIds.size > 0) {
    const channelIds = rows.rows.map((r) => r.channel_id);
    const countRes = await pool.query<{
      channel_id: string;
      cluster_id: number;
      n: number;
    }>(
      `SELECT v.channel_id, a.cluster_id, COUNT(*)::int AS n
         FROM niche_spy_videos v
         JOIN niche_tree_assignments a ON a.video_id = v.id
        WHERE v.channel_id = ANY($1::text[])
          AND a.cluster_id = ANY($2::int[])
        GROUP BY v.channel_id, a.cluster_id`,
      [channelIds, Array.from(allClusterIds)],
    );
    const channelClusterCount = new Map<string, number>();
    for (const cr of countRes.rows) {
      channelClusterCount.set(`${cr.channel_id}:${cr.cluster_id}`, Number(cr.n));
    }
    for (const r of rows.rows) {
      const sc = clusterMap.get(Number(r.top_video_id));
      if (!sc) continue;
      if (sc.l1) sc.l1.channel_videos_in_cluster = channelClusterCount.get(`${r.channel_id}:${sc.l1.cluster_id}`) ?? 1;
      if (sc.l2) sc.l2.channel_videos_in_cluster = channelClusterCount.get(`${r.channel_id}:${sc.l2.cluster_id}`) ?? 1;
    }
  }

  // ── Score + return ──────────────────────────────────────────────────
  const scoredAll: DiscoveryCandidate[] = rows.rows.map((r) => {
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
      top_video_thumbnail:  r.top_video_thumbnail,
      top_video_url:        r.top_video_url,
      top_video_posted_at:  r.top_video_posted_at?.toISOString?.() ?? null,
      videos_indexed:       Number(r.videos_indexed),
      median_video_views:   medV,
      views_to_subs_ratio:  Math.round(ratio * 10) / 10,
      novelty_score:        novelty,
      showcase_clusters:    clusterMap.get(Number(r.top_video_id)) ?? { l1: null, l2: null },
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

  // Non-Latin-script gate — strengthens the English-only pool filter (#5). The
  // language gate in the SQL above only drops channels with a KNOWN non-English
  // analysis; most foreign channels in the pool have NO analysis and slipped
  // through (the Tamil "வானிமணி தமிழில்", Russian "Советский След", Chinese
  // "星際考古隊", …). The channel NAME / top-video title is the strongest signal,
  // so drop candidates that are predominantly non-Latin script. Accented Latin
  // and emoji never trigger it, so English channels are untouched. Replace-not-
  // delete still holds: drafts regen from this pool, so a dropped channel's
  // slot refills with the next English candidate.
  const scored = scoredAll.filter((c) => !isNonEnglishChannel(c.channel_name, c.top_video_title));

  scored.sort((a, b) => b.composite_score - a.composite_score);

  // Live-thumbnail revalidation. Our thumbnail_dead_at column only gets
  // populated by the periodic validator after 3 consecutive 404s; in
  // between runs, videos can be taken down and we'd still pick them as a
  // channel's "top video". HEAD-check the top thumbnail of every scored
  // candidate, write thumbnail_dead_at back for any that 404 so future
  // discovery calls skip them at SQL level, then drop the now-dead ones
  // from THIS response.
  //
  // Bounded to topK*2 to keep wall-clock small. Parallel with no
  // concurrency cap — these are tiny HEAD requests to a CDN.
  const head = await pool.connect();
  try {
    const checkPool = scored.slice(0, topK * 2);
    const results = await Promise.allSettled(checkPool.map(async (c) => {
      if (!c.top_video_thumbnail) return { c, alive: false };
      try {
        const res = await fetch(c.top_video_thumbnail, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        return { c, alive: res.ok };
      } catch {
        // Network failure / timeout / DNS — treat as dead. Fail-closed.
        return { c, alive: false };
      }
    }));
    const alive: DiscoveryCandidate[] = [];
    const deadVideoIds: number[] = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      if (r.value.alive) alive.push(r.value.c);
      else                deadVideoIds.push(r.value.c.top_video_id);
    }
    if (deadVideoIds.length > 0) {
      // Fire-and-forget the DB update so we don't block the response on
      // the write. Next discovery call's SQL will filter these out.
      void head.query(
        `UPDATE niche_spy_videos
            SET thumbnail_dead_at = NOW()
          WHERE id = ANY($1::int[])
            AND thumbnail_dead_at IS NULL`,
        [deadVideoIds],
      ).catch((e) => {
        console.warn('[discoverChannels] failed to mark thumbnails dead:', (e as Error).message);
      });
    }
    return alive.slice(0, topK);
  } finally {
    head.release();
  }
}

/**
 * Group discovered candidates by their showcase_cluster at a given level.
 *
 *   level=1: broad niches ("Faceless YouTube Niches")
 *   level=2: sub-niches ("Funny Stickman Fails")
 *
 * Each group becomes a candidate "niche" for the listicle at the chosen
 * granularity. The listicle assembler then picks N niches (e.g. via
 * scale-diversity Gate 3) and 1-3 channels per niche.
 *
 * Candidates whose top video doesn't have a cluster at the requested
 * level are dropped from the grouping (they have nothing to be featured
 * under at that granularity).
 */
export function groupByCluster(
  candidates: DiscoveryCandidate[],
  level: 1 | 2 = 2,
): Array<{ cluster: ChannelCluster; channels: DiscoveryCandidate[] }> {
  const groups = new Map<number, { cluster: ChannelCluster; channels: DiscoveryCandidate[] }>();
  for (const c of candidates) {
    const sc = level === 1 ? c.showcase_clusters.l1 : c.showcase_clusters.l2;
    if (!sc) continue;
    const key = sc.cluster_id;
    if (!groups.has(key)) {
      groups.set(key, { cluster: sc, channels: [] });
    }
    groups.get(key)!.channels.push(c);
  }
  return Array.from(groups.values()).sort((a, b) => {
    const sumA = a.channels.reduce((s, c) => s + c.composite_score, 0);
    const sumB = b.channels.reduce((s, c) => s + c.composite_score, 0);
    return sumB - sumA;
  });
}

/**
 * Scale-diversity gate (Gate 3 from data-discovery-rules.json). Given
 * a flat list of candidates, return a balanced selection that hits the
 * three subscriber bands ([10K-100K], [100K-1M], [1M-5M]) for the
 * narrative rhythm the corpus shows working ("this tiny channel ... AND
 * this big one ...").
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

  take(small);
  take(mid);
  take(big);

  for (const c of candidates) {
    if (out.length >= targetTotal) break;
    if (seen.has(c.channel_id)) continue;
    out.push(c);
    seen.add(c.channel_id);
  }

  return out.slice(0, targetTotal);
}
