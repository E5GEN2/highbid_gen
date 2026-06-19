import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * Seed-supply gauge for the Video Seed tab: how much ELIGIBLE novelty seed supply
 * exists, the replenishment inflow, and how many concurrent threads that sustains.
 * Answers "will the supply hold N threads?" visually.
 *
 * The pool query aggregates all of niche_spy_videos per channel (heavy), so the
 * result is cached in-process for SUPPLY_TTL_MS — polling never re-runs it. The
 * scheduler already runs an equivalent candidate query every tick, so one cached
 * recompute per 10 min is negligible incremental load.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SUPPLY_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; data: unknown } | null = null;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  if (cache && Date.now() - cache.at < SUPPLY_TTL_MS) {
    return NextResponse.json({ ...(cache.data as object), cached: true, ageSec: Math.round((Date.now() - cache.at) / 1000) });
  }

  const pool = await getPool();

  // ── Eligible pool at three novelty floors + inflow (one heavy pass) ──────
  // Mirrors lib/content-gen/seed-candidates.ts eligibility (A1–D2). candidate_videos
  // uses the most-inclusive floor (pct=50); the higher floors are FILTER counts.
  const poolRes = await pool.query<{
    fresh_80: string; fresh_65: string; fresh_50: string;
    total_50: string; inflow_24h: string; inflow_7d: string;
  }>(
    `WITH cutoffs AS (
       SELECT PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY novelty_score) AS c80,
              PERCENTILE_CONT(0.65) WITHIN GROUP (ORDER BY novelty_score) AS c65,
              PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY novelty_score) AS c50
         FROM niche_spy_videos WHERE novelty_score IS NOT NULL
     ),
     candidate_videos AS (
       SELECT v.id, v.view_count, v.posted_at, v.novelty_score, v.channel_id, v.combined_embedded_v2_at
         FROM niche_spy_videos v, cutoffs
        WHERE v.novelty_score IS NOT NULL AND v.novelty_score >= cutoffs.c50
          AND v.channel_id IS NOT NULL AND v.view_count IS NOT NULL
     ),
     per_channel AS (
       SELECT v.channel_id, COUNT(*)::int AS videos_indexed, MAX(v.view_count) AS top_view,
              (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.view_count))::bigint AS median_view,
              MIN(v.channel_created_at) AS chan_created_v, MIN(v.posted_at) AS earliest_video_posted_at
         FROM niche_spy_videos v WHERE v.channel_id IS NOT NULL AND v.view_count IS NOT NULL
        GROUP BY v.channel_id
     ),
     enriched AS (
       SELECT cv.id AS video_id, cv.posted_at AS vpa, cv.novelty_score AS nov, cv.combined_embedded_v2_at AS emb,
              sc.subscriber_count AS subs,
              EXTRACT(EPOCH FROM (NOW() - COALESCE(sc.channel_created_at, sc.first_upload_at, pc.chan_created_v, pc.earliest_video_posted_at)))/86400 AS age_days,
              pc.videos_indexed AS vi, pc.top_view AS ctv, pc.median_view AS cmv
         FROM candidate_videos cv
         JOIN per_channel pc ON pc.channel_id = cv.channel_id
         JOIN niche_spy_channels sc ON sc.channel_id = cv.channel_id
        WHERE sc.subscriber_count IS NOT NULL
     ),
     eligible AS (
       SELECT e.*,
              NOT EXISTS (SELECT 1 FROM niche_discovery_seeds s WHERE s.seed_video_id = e.video_id AND s.status <> 'failed') AS fresh
         FROM enriched e, cutoffs
        WHERE e.subs BETWEEN 10000 AND 5000000
          AND e.ctv >= CASE WHEN e.age_days>365 THEN 1000000 WHEN e.age_days>180 THEN 500000 WHEN e.age_days>90 THEN 200000 ELSE 100000 END
          AND e.ctv > 0 AND e.ctv::float/NULLIF(e.subs,0) >= 5 AND e.age_days <= 730
          AND e.vpa >= NOW()-INTERVAL '12 months' AND e.vi >= 5 AND e.cmv::float/NULLIF(e.ctv,0) >= 0.05
     )
     SELECT
       COUNT(*) FILTER (WHERE fresh AND nov >= (SELECT c80 FROM cutoffs)) AS fresh_80,
       COUNT(*) FILTER (WHERE fresh AND nov >= (SELECT c65 FROM cutoffs)) AS fresh_65,
       COUNT(*) FILTER (WHERE fresh) AS fresh_50,
       COUNT(*) AS total_50,
       COUNT(*) FILTER (WHERE fresh AND emb > NOW()-INTERVAL '24 hours') AS inflow_24h,
       COUNT(*) FILTER (WHERE fresh AND emb > NOW()-INTERVAL '7 days')  AS inflow_7d
     FROM eligible`,
  );

  // ── Cheap: consumption, current floor, avg task duration ─────────────────
  const [dispRes, floorRes, durRes] = await Promise.all([
    pool.query<{ d1h: string; d24h: string }>(
      `SELECT COUNT(*) FILTER (WHERE dispatched_at > NOW()-INTERVAL '1 hour') AS d1h,
              COUNT(*) FILTER (WHERE dispatched_at > NOW()-INTERVAL '24 hours') AS d24h
         FROM niche_discovery_seeds WHERE source='novelty'`),
    pool.query<{ value: string }>(`SELECT value FROM admin_config WHERE key='auto_seed_min_novelty_pct'`),
    pool.query<{ avg_min: string }>(
      `SELECT AVG(EXTRACT(EPOCH FROM (last_seen_at - first_seen_at))/60.0) AS avg_min
         FROM agent_task_log
        WHERE (kind='seed' OR keyword LIKE 'nd\\_%') AND status='completed' AND last_seen_at > NOW()-INTERVAL '12 hours'`),
  ]);

  const p = poolRes.rows[0];
  const fresh80 = parseInt(p.fresh_80) || 0;
  const fresh65 = parseInt(p.fresh_65) || 0;
  const fresh50 = parseInt(p.fresh_50) || 0;
  const inflow24h = parseInt(p.inflow_24h) || 0;
  const inflow7d = parseInt(p.inflow_7d) || 0;
  const dispatch24h = parseInt(dispRes.rows[0]?.d24h) || 0;
  const dispatch1h = parseInt(dispRes.rows[0]?.d1h) || 0;
  const floor = parseInt(floorRes.rows[0]?.value || '65') || 65;
  const avgTaskMin = Math.max(1, parseFloat(durRes.rows[0]?.avg_min || '43') || 43);

  // ── Derived thread math ──────────────────────────────────────────────────
  const inflowPerHr = inflow24h / 24;                       // replenishment, eligible/hr
  const perThreadPerHr = 60 / avgTaskMin;                   // seed dispatches per thread per hr
  const sustainableThreads = Math.round(inflowPerHr / perThreadPerHr);  // steady-state, inflow-limited
  const freshAtFloor = floor >= 80 ? fresh80 : floor >= 65 ? fresh65 : fresh50;
  const bufferHoursAt = (threads: number) => {
    const net = threads * perThreadPerHr - inflowPerHr;
    return net <= 0 ? null : Math.round(fresh50 / net);     // buffer drains the pct=50 ceiling
  };

  const data = {
    ok: true,
    pools: { fresh80, fresh65, fresh50, total50: parseInt(p.total_50) || 0 },
    inflow: { per24h: inflow24h, per7d: inflow7d, perHr: Math.round(inflowPerHr * 10) / 10 },
    consumption: { dispatch1h, dispatch24h, perThreadPerHr: Math.round(perThreadPerHr * 100) / 100, avgTaskMin: Math.round(avgTaskMin * 10) / 10 },
    floor,
    freshAtFloor,
    derived: {
      sustainableThreads,
      bufferHoursAt20: bufferHoursAt(20),
      bufferHoursAt40: bufferHoursAt(40),
    },
    computedAt: new Date().toISOString(),
  };

  cache = { at: Date.now(), data };
  return NextResponse.json({ ...data, cached: false, ageSec: 0 });
}
