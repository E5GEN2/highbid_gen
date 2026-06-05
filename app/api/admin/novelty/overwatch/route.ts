import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { findSeedCandidates } from '@/lib/content-gen/seed-candidates';

/**
 * GET /api/admin/novelty/overwatch
 *
 * Single-shot system snapshot for the novelty pipeline + seed flow.
 * Built so I can monitor the pipeline myself without curl-and-jq
 * acrobatics. Mirrors the content-gen overwatch in spirit.
 *
 * Returns:
 *   population         — total videos, coverage of combined_v2 embedding,
 *                         coverage of novelty score
 *   distribution       — novelty score percentiles (p50/p75/p90/p95/p99/p999)
 *                         + absolute score at each percentile
 *   freshness          — last novelty_updated_at; how stale the index is
 *   seed_funnel        — rule-by-rule survival when going from
 *                         scored→cutoff→A1→A2→A3→B1→B2→D1→D2
 *   binding_constraint — which rule kills the most in the seed funnel
 *   niche_coverage     — of high-novelty videos: how many are in an L1/L2
 *                         cluster vs. completely orphan (true blue ocean
 *                         is "orphan" — embedding-isolated AND outside
 *                         any niche cluster)
 *   sample_top_seeds   — preview of top-5 seed candidates
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }
  const sp = req.nextUrl.searchParams;
  // Default 80 = "top 20% novelty" for the cutoff in the seed funnel.
  const minNoveltyPct = Math.max(0, Math.min(99.9, parseFloat(sp.get('minNoveltyPct') ?? '80')));

  const pool = await getPool();
  const t0 = Date.now();

  // ── 1. POPULATION + COVERAGE + FRESHNESS ────────────────────────────
  const popRes = await pool.query<{
    total_videos: string;
    with_combined_v2: string;
    with_novelty: string;
    last_updated: string | null;
    updated_last_24h: string;
    updated_last_7d: string;
    fresh_stale_gap_hours: number | null;
  }>(`
    SELECT
      COUNT(*) AS total_videos,
      COUNT(*) FILTER (WHERE combined_embedded_v2_at IS NOT NULL) AS with_combined_v2,
      COUNT(*) FILTER (WHERE novelty_score IS NOT NULL)          AS with_novelty,
      MAX(novelty_updated_at)::text AS last_updated,
      COUNT(*) FILTER (WHERE novelty_updated_at > NOW() - INTERVAL '24 hours') AS updated_last_24h,
      COUNT(*) FILTER (WHERE novelty_updated_at > NOW() - INTERVAL '7 days')  AS updated_last_7d,
      EXTRACT(EPOCH FROM (NOW() - MAX(novelty_updated_at))) / 3600 AS fresh_stale_gap_hours
    FROM niche_spy_videos
  `);
  const p = popRes.rows[0];
  const total = parseInt(p.total_videos);
  const embedded = parseInt(p.with_combined_v2);
  const scored = parseInt(p.with_novelty);

  // ── 2. DISTRIBUTION — percentile cutoffs ────────────────────────────
  const distRes = await pool.query<{
    p50: number | null;
    p75: number | null;
    p90: number | null;
    p95: number | null;
    p99: number | null;
    p999: number | null;
    p_min: number | null;
    p_max: number | null;
  }>(`
    SELECT
      PERCENTILE_CONT(0.50)  WITHIN GROUP (ORDER BY novelty_score) AS p50,
      PERCENTILE_CONT(0.75)  WITHIN GROUP (ORDER BY novelty_score) AS p75,
      PERCENTILE_CONT(0.90)  WITHIN GROUP (ORDER BY novelty_score) AS p90,
      PERCENTILE_CONT(0.95)  WITHIN GROUP (ORDER BY novelty_score) AS p95,
      PERCENTILE_CONT(0.99)  WITHIN GROUP (ORDER BY novelty_score) AS p99,
      PERCENTILE_CONT(0.999) WITHIN GROUP (ORDER BY novelty_score) AS p999,
      MIN(novelty_score) AS p_min,
      MAX(novelty_score) AS p_max
    FROM niche_spy_videos WHERE novelty_score IS NOT NULL
  `);
  const dist = distRes.rows[0];

  // ── 3. SEED FUNNEL — rule-by-rule survival ──────────────────────────
  // Apply each filter independently against the top-X% novelty pool
  // to see where channels die. Built so we can answer:
  //   "I bumped minNoveltyPct to 90 and got zero seeds — which rule
  //    is now the binding constraint?"
  //
  // We use one big CTE with the same per-channel aggregates the
  // seed-candidates query uses, then count survivors per rule.
  const cutoffRes = await pool.query<{ cutoff: number | null }>(
    `SELECT PERCENTILE_CONT($1) WITHIN GROUP (ORDER BY novelty_score) AS cutoff
       FROM niche_spy_videos WHERE novelty_score IS NOT NULL`,
    [minNoveltyPct / 100],
  );
  const noveltyCutoff = cutoffRes.rows[0]?.cutoff ?? 0;

  const funnelRes = await pool.query<{
    above_cutoff: string;
    pass_a1: string;
    pass_a2: string;
    pass_a3: string;
    pass_b1: string;
    pass_b2: string;
    pass_d1: string;
    pass_d2: string;
    pass_all: string;
  }>(
    `WITH novel AS (
       SELECT v.id, v.url, v.view_count, v.posted_at, v.channel_id
       FROM niche_spy_videos v
       WHERE v.novelty_score IS NOT NULL
         AND v.novelty_score >= $1
         AND v.channel_id IS NOT NULL
         AND v.view_count IS NOT NULL
     ),
     per_channel AS (
       SELECT v.channel_id,
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
         n.id AS video_id,
         n.posted_at AS video_posted_at,
         sc.subscriber_count,
         COALESCE(sc.channel_created_at, sc.first_upload_at, pc.chan_created_v, pc.earliest_video_posted_at) AS effective_created_at,
         EXTRACT(EPOCH FROM (NOW() - COALESCE(sc.channel_created_at, sc.first_upload_at, pc.chan_created_v, pc.earliest_video_posted_at)))/86400 AS channel_age_days,
         pc.videos_indexed,
         pc.top_view,
         pc.median_view
       FROM novel n
       JOIN per_channel pc ON pc.channel_id = n.channel_id
       JOIN niche_spy_channels sc ON sc.channel_id = n.channel_id
       WHERE sc.subscriber_count IS NOT NULL
     ),
     checks AS (
       SELECT
         (subscriber_count BETWEEN 10000 AND 5000000) AS pass_a1,
         (top_view > 0 AND top_view >= CASE
           WHEN channel_age_days > 365 THEN 1000000
           WHEN channel_age_days > 180 THEN  500000
           WHEN channel_age_days >  90 THEN  200000
           ELSE                              100000
         END) AS pass_a2,
         (top_view > 0 AND subscriber_count > 0 AND
          top_view::float / NULLIF(subscriber_count, 0) >= 5) AS pass_a3,
         (channel_age_days <= 730) AS pass_b1,
         (video_posted_at >= NOW() - INTERVAL '12 months') AS pass_b2,
         (videos_indexed >= 5) AS pass_d1,
         (top_view > 0 AND median_view::float / NULLIF(top_view, 0) >= 0.05) AS pass_d2
       FROM enriched
     )
     SELECT
       COUNT(*) AS above_cutoff,
       COUNT(*) FILTER (WHERE pass_a1) AS pass_a1,
       COUNT(*) FILTER (WHERE pass_a2) AS pass_a2,
       COUNT(*) FILTER (WHERE pass_a3) AS pass_a3,
       COUNT(*) FILTER (WHERE pass_b1) AS pass_b1,
       COUNT(*) FILTER (WHERE pass_b2) AS pass_b2,
       COUNT(*) FILTER (WHERE pass_d1) AS pass_d1,
       COUNT(*) FILTER (WHERE pass_d2) AS pass_d2,
       COUNT(*) FILTER (WHERE pass_a1 AND pass_a2 AND pass_a3
                         AND pass_b1 AND pass_b2
                         AND pass_d1 AND pass_d2) AS pass_all
     FROM checks`,
    [noveltyCutoff],
  );
  const f = funnelRes.rows[0];
  const aboveCutoff = parseInt(f.above_cutoff);

  const pct = (n: string | number): string => {
    const v = typeof n === 'string' ? parseInt(n) : n;
    if (!aboveCutoff) return '0.0';
    return (100 * v / aboveCutoff).toFixed(1);
  };

  const funnel = {
    starting_pool_above_cutoff: aboveCutoff,
    pass_a1_subs_band:          { count: parseInt(f.pass_a1), pct: pct(f.pass_a1) },
    pass_a2_top_video_floor:    { count: parseInt(f.pass_a2), pct: pct(f.pass_a2) },
    pass_a3_ratio_5x:           { count: parseInt(f.pass_a3), pct: pct(f.pass_a3) },
    pass_b1_age_le_730:         { count: parseInt(f.pass_b1), pct: pct(f.pass_b1) },
    pass_b2_video_recent_12mo:  { count: parseInt(f.pass_b2), pct: pct(f.pass_b2) },
    pass_d1_videos_ge_5:        { count: parseInt(f.pass_d1), pct: pct(f.pass_d1) },
    pass_d2_not_one_viral_wonder: { count: parseInt(f.pass_d2), pct: pct(f.pass_d2) },
    pass_all_filters:           { count: parseInt(f.pass_all), pct: pct(f.pass_all) },
  };

  const independentSurvival = [
    { rule: 'A1 (subs band)',           passing: parseInt(f.pass_a1) },
    { rule: 'A2 (top-video floor)',     passing: parseInt(f.pass_a2) },
    { rule: 'A3 (ratio ≥5×)',           passing: parseInt(f.pass_a3) },
    { rule: 'B1 (age ≤730d)',           passing: parseInt(f.pass_b1) },
    { rule: 'B2 (video ≤12mo)',         passing: parseInt(f.pass_b2) },
    { rule: 'D1 (≥5 videos)',           passing: parseInt(f.pass_d1) },
    { rule: 'D2 (not one-viral-wonder)', passing: parseInt(f.pass_d2) },
  ]
    .map((x) => ({
      ...x,
      killing_pct: aboveCutoff ? 100 - (100 * x.passing / aboveCutoff) : 0,
    }))
    .sort((a, b) => b.killing_pct - a.killing_pct);

  // ── 4. NICHE COVERAGE — orphans are the true blue ocean ─────────────
  // For the high-novelty pool, how many videos are completely outside
  // any cluster (true greenfield discoveries) vs already-clustered?
  const orphanRes = await pool.query<{
    total: string;
    in_some_cluster: string;
    in_l1_only: string;
    in_l2: string;
    orphan: string;
  }>(
    `WITH novel AS (
       SELECT v.id
       FROM niche_spy_videos v
       WHERE v.novelty_score IS NOT NULL
         AND v.novelty_score >= $1
     ),
     latest_global AS (
       SELECT id FROM niche_tree_runs
       WHERE kind = 'global' AND status = 'done'
       ORDER BY started_at DESC NULLS LAST LIMIT 1
     ),
     classified AS (
       SELECT n.id,
              EXISTS (
                SELECT 1 FROM niche_tree_assignments a
                JOIN niche_tree_clusters c ON c.id = a.cluster_id
                WHERE a.video_id = n.id AND c.level = 1
                  AND a.run_id = (SELECT id FROM latest_global)
              ) AS in_l1,
              EXISTS (
                SELECT 1 FROM niche_tree_assignments a
                JOIN niche_tree_clusters c ON c.id = a.cluster_id
                JOIN niche_tree_runs r ON r.id = a.run_id
                WHERE a.video_id = n.id AND c.level = 2
                  AND r.kind = 'subdivide' AND r.status = 'done'
              ) AS in_l2
       FROM novel n
     )
     SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE in_l1 OR in_l2) AS in_some_cluster,
       COUNT(*) FILTER (WHERE in_l1 AND NOT in_l2) AS in_l1_only,
       COUNT(*) FILTER (WHERE in_l2) AS in_l2,
       COUNT(*) FILTER (WHERE NOT in_l1 AND NOT in_l2) AS orphan
     FROM classified`,
    [noveltyCutoff],
  );
  const o = orphanRes.rows[0];
  const orphanTotal = parseInt(o.total);
  const niche_coverage = {
    high_novelty_total: orphanTotal,
    in_some_cluster:    { count: parseInt(o.in_some_cluster), pct: pct(o.in_some_cluster) },
    in_l1_only:         { count: parseInt(o.in_l1_only),      pct: pct(o.in_l1_only) },
    in_l2_sub_niche:    { count: parseInt(o.in_l2),           pct: pct(o.in_l2) },
    orphan_blue_ocean:  { count: parseInt(o.orphan),          pct: pct(o.orphan) },
    note: 'Orphan = high novelty AND outside any cluster — true greenfield territory for xgodo seeding.',
  };

  // ── 5. SAMPLE TOP SEEDS (top 5) ─────────────────────────────────────
  const sampleSeeds = (await findSeedCandidates({ topK: 5, minNoveltyPct })).map((s) => ({
    video_id:        s.video_id,
    video_url:       s.video_url,
    video_title:     s.video_title,
    view_count:      s.view_count,
    novelty_score:   s.novelty_score,
    novelty_percentile: s.novelty_percentile,
    channel_name:    s.channel.channel_name,
    channel_subs:    s.channel.subscriber_count,
    channel_age:     s.channel.channel_age_days,
    seed_score:      s.seed_score,
  }));

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - t0,
    at: new Date().toISOString(),
    population: {
      total_videos:     total,
      with_combined_v2: { count: embedded, pct: total ? (100 * embedded / total).toFixed(1) : '0' },
      with_novelty:     { count: scored,   pct: total ? (100 * scored   / total).toFixed(1) : '0' },
    },
    distribution: {
      cutoff_at_minNoveltyPct: { percentile: minNoveltyPct, absolute_score: noveltyCutoff },
      p50:  dist.p50  ?? null,
      p75:  dist.p75  ?? null,
      p90:  dist.p90  ?? null,
      p95:  dist.p95  ?? null,
      p99:  dist.p99  ?? null,
      p999: dist.p999 ?? null,
      min:  dist.p_min ?? null,
      max:  dist.p_max ?? null,
    },
    freshness: {
      last_novelty_updated_at:     p.last_updated,
      updated_last_24h:            parseInt(p.updated_last_24h),
      updated_last_7d:             parseInt(p.updated_last_7d),
      hours_since_most_recent:     p.fresh_stale_gap_hours != null
        ? Math.round(Number(p.fresh_stale_gap_hours) * 10) / 10
        : null,
    },
    seed_funnel: funnel,
    binding_constraint: {
      ranked_by_killing_pct: independentSurvival,
      note: 'Rule killing the most channels in isolation = most leverage from relaxing it.',
    },
    niche_coverage,
    sample_top_seeds: sampleSeeds,
  });
}
