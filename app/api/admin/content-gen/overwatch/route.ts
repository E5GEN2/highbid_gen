import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/content-gen/overwatch
 *
 * Single-shot system snapshot for the content-gen discovery pipeline.
 * Built so I (or anyone debugging) can answer at-a-glance:
 *
 *   - "How big is our pool of indexable channels?"           → population.*
 *   - "Where are channels dying in the filter chain?"        → funnel.*
 *   - "Which niches are READY to generate listicles for?"    → ready_clusters.*
 *   - "What's the typical viable candidate look like?"       → sample_top_candidates
 *   - "Is enrichment keeping up?"                            → recent_enrichment_stats
 *
 * The funnel is the load-bearing diagnostic — tells us which rule is
 * binding. If A2 (top-video floor) kills 95% of channels, we know we
 * need more recent breakouts in our index. If B1 (recency) kills 90%,
 * we're indexing too many old channels.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }
  const pool = await getPool();
  const t0 = Date.now();

  // ── 1. POPULATION snapshot ─────────────────────────────────────────
  const popRes = await pool.query<{
    total_videos: string;
    distinct_channels: string;
    enriched_channels: string;
    channels_with_age: string;
    channels_in_some_cluster: string;
  }>(`
    SELECT
      COUNT(*)                                                  AS total_videos,
      COUNT(DISTINCT v.channel_id) FILTER (WHERE v.channel_id IS NOT NULL)
                                                                AS distinct_channels,
      COUNT(DISTINCT v.channel_id) FILTER (WHERE v.channel_id IS NOT NULL
                                            AND sc.subscriber_count IS NOT NULL)
                                                                AS enriched_channels,
      COUNT(DISTINCT v.channel_id) FILTER (WHERE v.channel_id IS NOT NULL
                                            AND COALESCE(sc.channel_created_at, sc.first_upload_at) IS NOT NULL)
                                                                AS channels_with_age,
      COUNT(DISTINCT v.channel_id) FILTER (WHERE v.channel_id IS NOT NULL
                                            AND EXISTS (SELECT 1 FROM niche_tree_assignments a WHERE a.video_id = v.id))
                                                                AS channels_in_some_cluster
    FROM niche_spy_videos v
    LEFT JOIN niche_spy_channels sc ON sc.channel_id = v.channel_id
    WHERE v.channel_id IS NOT NULL AND v.view_count IS NOT NULL
  `);

  const population = {
    total_videos:              parseInt(popRes.rows[0]?.total_videos ?? '0'),
    distinct_channels:         parseInt(popRes.rows[0]?.distinct_channels ?? '0'),
    enriched_channels:         parseInt(popRes.rows[0]?.enriched_channels ?? '0'),
    channels_with_age:         parseInt(popRes.rows[0]?.channels_with_age ?? '0'),
    channels_in_some_cluster:  parseInt(popRes.rows[0]?.channels_in_some_cluster ?? '0'),
  };

  // ── 2. FUNNEL — rule-by-rule survival ───────────────────────────────
  //
  // For each filter (A1, A2, A3, B1, B2, D1, D2) compute the count of
  // channels passing JUST THAT FILTER. Plus the count passing ALL filters
  // together (= the actual candidate pool).
  //
  // Each filter is evaluated independently against the per-channel
  // aggregates so we can see which one is the binding constraint
  // (smallest survivor count).
  //
  // CTE structure: build per-channel aggregates once, then independent
  // filter checks via boolean columns. Fast on indexed columns.
  const funnelRes = await pool.query<{
    enriched: string;
    a1_subs_in_band: string;
    a2_top_video_floor: string;
    a3_ratio_min_5x: string;
    b1_age_le_730: string;
    b2_top_video_recent: string;
    d1_videos_ge_5: string;
    d2_not_one_viral_wonder: string;
    all_passing: string;
  }>(`
    WITH per_channel AS (
      SELECT
        v.channel_id,
        COUNT(*)::int                    AS videos_indexed,
        MAX(v.view_count)                AS top_video_views,
        (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.view_count))::bigint
                                          AS median_video_views,
        MAX(v.posted_at)                 AS top_video_posted_at,
        MIN(v.channel_created_at)        AS channel_created_at_v,
        MIN(v.posted_at)                 AS earliest_video_posted_at
      FROM niche_spy_videos v
      WHERE v.channel_id IS NOT NULL AND v.view_count IS NOT NULL
      GROUP BY v.channel_id
    ),
    enriched AS (
      SELECT
        pc.channel_id,
        sc.subscriber_count,
        COALESCE(sc.channel_created_at, sc.first_upload_at, pc.channel_created_at_v, pc.earliest_video_posted_at)
                                          AS effective_created_at,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(sc.channel_created_at, sc.first_upload_at, pc.channel_created_at_v, pc.earliest_video_posted_at))) / 86400
                                          AS age_days,
        pc.top_video_views,
        pc.median_video_views,
        pc.top_video_posted_at,
        pc.videos_indexed
      FROM per_channel pc
      JOIN niche_spy_channels sc ON sc.channel_id = pc.channel_id
      WHERE sc.subscriber_count IS NOT NULL
    ),
    checks AS (
      SELECT
        (subscriber_count BETWEEN 10000 AND 5000000)                       AS pass_a1,
        (top_video_views >= CASE
                              WHEN age_days > 365 THEN 1000000
                              WHEN age_days > 180 THEN  500000
                              WHEN age_days >  90 THEN  200000
                              ELSE                      100000
                            END)                                            AS pass_a2,
        (subscriber_count > 0 AND top_video_views IS NOT NULL
          AND top_video_views::float / NULLIF(subscriber_count, 0) >= 5)         AS pass_a3,
        (age_days <= 730)                                                   AS pass_b1,
        (top_video_posted_at >= NOW() - INTERVAL '12 months')              AS pass_b2,
        (videos_indexed >= 5)                                               AS pass_d1,
        (top_video_views > 0 AND median_video_views IS NOT NULL
          AND median_video_views::float / NULLIF(top_video_views, 0) >= 0.05)  AS pass_d2
      FROM enriched
    )
    SELECT
      COUNT(*)                                                              AS enriched,
      COUNT(*) FILTER (WHERE pass_a1)                                      AS a1_subs_in_band,
      COUNT(*) FILTER (WHERE pass_a2)                                      AS a2_top_video_floor,
      COUNT(*) FILTER (WHERE pass_a3)                                      AS a3_ratio_min_5x,
      COUNT(*) FILTER (WHERE pass_b1)                                      AS b1_age_le_730,
      COUNT(*) FILTER (WHERE pass_b2)                                      AS b2_top_video_recent,
      COUNT(*) FILTER (WHERE pass_d1)                                      AS d1_videos_ge_5,
      COUNT(*) FILTER (WHERE pass_d2)                                      AS d2_not_one_viral_wonder,
      COUNT(*) FILTER (WHERE pass_a1 AND pass_a2 AND pass_a3 AND pass_b1 AND pass_b2 AND pass_d1 AND pass_d2) AS all_passing
    FROM checks
  `);

  const f = funnelRes.rows[0];
  const totalEnriched = parseInt(f.enriched);
  const funnel = {
    starting_population:        totalEnriched,
    pass_a1_subs_band:          { count: parseInt(f.a1_subs_in_band),         pct: pct(f.a1_subs_in_band, totalEnriched) },
    pass_a2_top_video_floor:    { count: parseInt(f.a2_top_video_floor),       pct: pct(f.a2_top_video_floor, totalEnriched) },
    pass_a3_ratio_5x:           { count: parseInt(f.a3_ratio_min_5x),          pct: pct(f.a3_ratio_min_5x, totalEnriched) },
    pass_b1_age_le_730:         { count: parseInt(f.b1_age_le_730),            pct: pct(f.b1_age_le_730, totalEnriched) },
    pass_b2_top_video_recent:   { count: parseInt(f.b2_top_video_recent),      pct: pct(f.b2_top_video_recent, totalEnriched) },
    pass_d1_videos_ge_5:        { count: parseInt(f.d1_videos_ge_5),           pct: pct(f.d1_videos_ge_5, totalEnriched) },
    pass_d2_not_one_viral_wonder: { count: parseInt(f.d2_not_one_viral_wonder), pct: pct(f.d2_not_one_viral_wonder, totalEnriched) },
    pass_all_filters:           { count: parseInt(f.all_passing),              pct: pct(f.all_passing, totalEnriched) },
  };

  // Binding-constraint helper — which rule kills the most channels in
  // isolation? Useful at a glance.
  const independentSurvival: Array<{ rule: string; passing: number; killing_pct: number }> = [
    { rule: 'A1 (subs band)',           passing: parseInt(f.a1_subs_in_band),         killing_pct: 100 - parseFloat(pct(f.a1_subs_in_band, totalEnriched)) },
    { rule: 'A2 (top-video floor)',     passing: parseInt(f.a2_top_video_floor),      killing_pct: 100 - parseFloat(pct(f.a2_top_video_floor, totalEnriched)) },
    { rule: 'A3 (ratio ≥5×)',           passing: parseInt(f.a3_ratio_min_5x),         killing_pct: 100 - parseFloat(pct(f.a3_ratio_min_5x, totalEnriched)) },
    { rule: 'B1 (age ≤730d)',           passing: parseInt(f.b1_age_le_730),           killing_pct: 100 - parseFloat(pct(f.b1_age_le_730, totalEnriched)) },
    { rule: 'B2 (top video ≤12mo)',     passing: parseInt(f.b2_top_video_recent),     killing_pct: 100 - parseFloat(pct(f.b2_top_video_recent, totalEnriched)) },
    { rule: 'D1 (≥5 videos)',           passing: parseInt(f.d1_videos_ge_5),          killing_pct: 100 - parseFloat(pct(f.d1_videos_ge_5, totalEnriched)) },
    { rule: 'D2 (not one-viral-wonder)', passing: parseInt(f.d2_not_one_viral_wonder), killing_pct: 100 - parseFloat(pct(f.d2_not_one_viral_wonder, totalEnriched)) },
  ].sort((a, b) => b.killing_pct - a.killing_pct);

  // ── 3. SAMPLE TOP CANDIDATES (top 10 passing all filters) ──────────
  // Lightweight version of the discover endpoint — same query but only
  // returns top-10 for a sanity check that the picker is working.
  const sampleRes = await pool.query<{
    channel_id: string;
    channel_name: string;
    subscriber_count: string;
    age_days: string;
    top_video_views: string;
    top_video_title: string;
    videos_indexed: string;
  }>(`
    WITH per_channel AS (
      SELECT v.channel_id,
             COUNT(*)::int AS videos_indexed,
             MAX(v.view_count) AS top_video_views,
             (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.view_count))::bigint AS median_views,
             MAX(v.posted_at) AS top_video_posted_at,
             MIN(v.channel_created_at) AS chan_created_v,
             MIN(v.posted_at) AS earliest_video_posted_at
      FROM niche_spy_videos v
      WHERE v.channel_id IS NOT NULL AND v.view_count IS NOT NULL
      GROUP BY v.channel_id
    ),
    enriched AS (
      SELECT
        pc.channel_id,
        sc.channel_name,
        sc.subscriber_count,
        COALESCE(sc.channel_created_at, sc.first_upload_at, pc.chan_created_v, pc.earliest_video_posted_at) AS effective_created_at,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(sc.channel_created_at, sc.first_upload_at, pc.chan_created_v, pc.earliest_video_posted_at))) / 86400 AS age_days,
        pc.top_video_views,
        pc.median_views,
        pc.top_video_posted_at,
        pc.videos_indexed
      FROM per_channel pc
      JOIN niche_spy_channels sc ON sc.channel_id = pc.channel_id
      WHERE sc.subscriber_count IS NOT NULL
    ),
    passing AS (
      SELECT e.*,
             (SELECT v.title FROM niche_spy_videos v
              WHERE v.channel_id = e.channel_id
                AND v.view_count = e.top_video_views
              LIMIT 1) AS top_video_title
      FROM enriched e
      WHERE e.subscriber_count BETWEEN 10000 AND 5000000
        AND e.top_video_views > 0
        AND e.top_video_views::float / NULLIF(e.subscriber_count, 0) >= 5
        AND e.top_video_views >= CASE
            WHEN e.age_days > 365 THEN 1000000
            WHEN e.age_days > 180 THEN  500000
            WHEN e.age_days >  90 THEN  200000
            ELSE                        100000
          END
        AND e.age_days <= 730
        AND e.top_video_posted_at >= NOW() - INTERVAL '12 months'
        AND e.videos_indexed >= 5
        AND e.median_views::float / NULLIF(e.top_video_views, 0) >= 0.05
    )
    SELECT channel_id, channel_name, subscriber_count, age_days, top_video_views, top_video_title, videos_indexed
    FROM passing
    ORDER BY top_video_views DESC
    LIMIT 10
  `);

  const sample_top_candidates = sampleRes.rows.map((r) => ({
    channel_id:       r.channel_id,
    channel_name:     r.channel_name,
    subscriber_count: parseInt(r.subscriber_count),
    age_days:         Math.round(parseFloat(r.age_days)),
    top_video_views:  parseInt(r.top_video_views),
    top_video_title:  r.top_video_title,
    videos_indexed:   parseInt(r.videos_indexed),
  }));

  // ── 4. READY CLUSTERS — niches with ≥2 candidates available ─────────
  // For each cluster, count how many of the cluster's videos belong to a
  // channel that passes ALL discovery filters. Clusters with ≥2 such
  // channels are "ready niches" — we could generate a listicle from them.
  const readyRes = await pool.query<{
    cluster_id: number;
    level: number;
    cluster_label: string | null;
    parent_cluster_id: number | null;
    cluster_video_count: number;
    viable_channel_count: string;
    run_kind: string | null;
    started_at: string;
  }>(`
    WITH per_channel AS (
      SELECT v.channel_id,
             MAX(v.view_count) AS top_video_views,
             (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.view_count))::bigint AS median_views,
             MAX(v.posted_at) AS top_video_posted_at,
             COUNT(*)::int AS videos_indexed,
             MIN(v.channel_created_at) AS chan_created_v,
             MIN(v.posted_at) AS earliest_video_posted_at
      FROM niche_spy_videos v
      WHERE v.channel_id IS NOT NULL AND v.view_count IS NOT NULL
      GROUP BY v.channel_id
    ),
    viable_channels AS (
      SELECT pc.channel_id
      FROM per_channel pc
      JOIN niche_spy_channels sc ON sc.channel_id = pc.channel_id
      WHERE sc.subscriber_count BETWEEN 10000 AND 5000000
        AND sc.subscriber_count IS NOT NULL
        AND pc.top_video_views > 0
        AND pc.top_video_views::float / NULLIF(sc.subscriber_count, 0) >= 5
        AND pc.top_video_views >= CASE
            WHEN EXTRACT(EPOCH FROM (NOW() - COALESCE(sc.channel_created_at, sc.first_upload_at, pc.chan_created_v, pc.earliest_video_posted_at)))/86400 > 365 THEN 1000000
            WHEN EXTRACT(EPOCH FROM (NOW() - COALESCE(sc.channel_created_at, sc.first_upload_at, pc.chan_created_v, pc.earliest_video_posted_at)))/86400 > 180 THEN  500000
            WHEN EXTRACT(EPOCH FROM (NOW() - COALESCE(sc.channel_created_at, sc.first_upload_at, pc.chan_created_v, pc.earliest_video_posted_at)))/86400 >  90 THEN  200000
            ELSE                                                                                                                                                  100000
          END
        AND EXTRACT(EPOCH FROM (NOW() - COALESCE(sc.channel_created_at, sc.first_upload_at, pc.chan_created_v, pc.earliest_video_posted_at)))/86400 <= 730
        AND pc.top_video_posted_at >= NOW() - INTERVAL '12 months'
        AND pc.videos_indexed >= 5
        AND pc.median_views::float / NULLIF(pc.top_video_views, 0) >= 0.05
    )
    SELECT
      c.id AS cluster_id,
      c.level AS level,
      COALESCE(c.label, c.ai_label, c.auto_label) AS cluster_label,
      c.parent_cluster_id,
      c.video_count AS cluster_video_count,
      COUNT(DISTINCT v.channel_id) AS viable_channel_count,
      r.kind AS run_kind,
      r.started_at::text AS started_at
    FROM niche_tree_clusters c
    JOIN niche_tree_runs r ON r.id = c.run_id
    JOIN niche_tree_assignments a ON a.cluster_id = c.id
    JOIN niche_spy_videos v ON v.id = a.video_id
    WHERE v.channel_id IN (SELECT channel_id FROM viable_channels)
    GROUP BY c.id, c.level, c.label, c.ai_label, c.auto_label, c.parent_cluster_id, c.video_count, r.kind, r.started_at
    HAVING COUNT(DISTINCT v.channel_id) >= 2
    ORDER BY c.level, COUNT(DISTINCT v.channel_id) DESC, r.started_at DESC
    LIMIT 60
  `);

  const ready_l1 = readyRes.rows.filter((r) => Number(r.level) === 1).slice(0, 20).map((r) => ({
    cluster_id:           Number(r.cluster_id),
    cluster_label:        r.cluster_label,
    cluster_video_count:  Number(r.cluster_video_count) || 0,
    viable_channel_count: parseInt(r.viable_channel_count),
    run_kind:             r.run_kind,
    started_at:           r.started_at,
  }));
  const ready_l2 = readyRes.rows.filter((r) => Number(r.level) === 2).slice(0, 20).map((r) => ({
    cluster_id:           Number(r.cluster_id),
    cluster_label:        r.cluster_label,
    parent_cluster_id:    r.parent_cluster_id != null ? Number(r.parent_cluster_id) : null,
    cluster_video_count:  Number(r.cluster_video_count) || 0,
    viable_channel_count: parseInt(r.viable_channel_count),
    run_kind:             r.run_kind,
    started_at:           r.started_at,
  }));

  // ── 5. RECENT ENRICHMENT activity ──────────────────────────────────
  const enrichRes = await pool.query<{
    enriched_last_24h: string;
    enriched_last_7d: string;
    needs_enrichment: string;
  }>(`
    SELECT
      COUNT(DISTINCT v.channel_id) FILTER (WHERE sc.last_channel_fetched_at > NOW() - INTERVAL '24 hours') AS enriched_last_24h,
      COUNT(DISTINCT v.channel_id) FILTER (WHERE sc.last_channel_fetched_at > NOW() - INTERVAL '7 days')   AS enriched_last_7d,
      COUNT(DISTINCT v.channel_id) FILTER (WHERE sc.subscriber_count IS NULL)                              AS needs_enrichment
    FROM niche_spy_videos v
    LEFT JOIN niche_spy_channels sc ON sc.channel_id = v.channel_id
    WHERE v.channel_id IS NOT NULL
  `);

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - t0,
    at: new Date().toISOString(),
    population,
    funnel,
    binding_constraint: {
      ranked_by_killing_pct: independentSurvival,
      note: 'The rule killing the largest % of channels is the binding constraint — most leverage from relaxing it.',
    },
    sample_top_candidates,
    ready_clusters: {
      note: 'Clusters with ≥2 viable candidates — listicle-ready niches. Split by level: L1 = broad niches (e.g. "Faceless YouTube Niches"), L2 = sub-niches (e.g. "Funny Stickman Fails"). Listicle assembler picks which granularity to build at.',
      l1_count: ready_l1.length,
      l2_count: ready_l2.length,
      top_l1_niches:    ready_l1,
      top_l2_subniches: ready_l2,
    },
    recent_enrichment_stats: {
      enriched_last_24h: parseInt(enrichRes.rows[0]?.enriched_last_24h ?? '0'),
      enriched_last_7d:  parseInt(enrichRes.rows[0]?.enriched_last_7d ?? '0'),
      needs_enrichment:  parseInt(enrichRes.rows[0]?.needs_enrichment ?? '0'),
    },
  });
}

function pct(numerator: string | number, denominator: number): string {
  const n = typeof numerator === 'string' ? parseInt(numerator) : numerator;
  if (!denominator) return '0.0';
  return (100 * n / denominator).toFixed(1);
}
