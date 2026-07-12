import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { CG_EVAL_VERSION } from '@/lib/content-gen/cg-eligibility';

/**
 * CG-eligibility KPI dashboard feed — everything the Video Seed "Discovery KPI"
 * panel needs, all cheap reads over the pre-stamped channel_cg_status table:
 *   - headline: eligible today / 7d avg / trend
 *   - daily series (eligible + discovered per day, last N days) with a
 *     provisional flag for days whose enrichment hasn't caught up
 *   - funnel: discovered → enriched → passed-hard-gates → eligible
 *   - gate-killer breakdown (which gate eliminates the most)
 *   - source attribution (novelty / content_gen / burst / other)
 *   - per-seed leaderboard (top seeds by cg-eligible yield)
 *   - golden feed: the actual channels that just passed
 *   - health: enricher subs-fill-rate + eval backlog (is a low number real
 *     or a stalled pipeline?)
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const url = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30'), 7), 90);

  const [series, headline, funnel, killers, sources, leaderboard, golden, health] = await Promise.all([
    // Daily discovered vs eligible (by discovered_at). "eligible" counts channels
    // discovered that day that ARE cg_eligible (matured); provisional flagged
    // client-side when that day's eval coverage is still low.
    pool.query(
      `SELECT to_char(date_trunc('day', discovered_at), 'YYYY-MM-DD') AS day,
              COUNT(*) AS discovered,
              COUNT(*) FILTER (WHERE cg_evaluated_at IS NOT NULL) AS evaluated,
              COUNT(*) FILTER (WHERE cg_eligible) AS eligible
         FROM channel_cg_status
        WHERE discovered_at > NOW() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY 1`,
      [String(days)],
    ),
    // Headline: eligible discovered in last 24h / 7d / prior 7d (for trend).
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE cg_eligible AND discovered_at > NOW() - INTERVAL '1 day')  AS elig_1d,
         COUNT(*) FILTER (WHERE cg_eligible AND discovered_at > NOW() - INTERVAL '7 days')  AS elig_7d,
         COUNT(*) FILTER (WHERE cg_eligible AND discovered_at > NOW() - INTERVAL '14 days' AND discovered_at <= NOW() - INTERVAL '7 days') AS elig_prev7d,
         COUNT(*) FILTER (WHERE cg_eligible) AS elig_total
       FROM channel_cg_status`,
    ),
    // Funnel over the window. passed_hard_gates = evaluated and failed NO hard
    // gate (may still fail only the English gate); eligible = failed nothing.
    pool.query(
      `SELECT
         COUNT(*) AS discovered,
         COUNT(*) FILTER (WHERE cg_evaluated_at IS NOT NULL) AS evaluated,
         COUNT(*) FILTER (WHERE cg_evaluated_at IS NOT NULL AND NOT (cg_fail_reasons && ARRAY['not_enriched','subs_band','used_channel','lang_analysis','topview_zero','view_sub_ratio','view_floor','age','recency','min_videos','median_ratio']::text[])) AS passed_hard_gates,
         COUNT(*) FILTER (WHERE cg_eligible) AS eligible
       FROM channel_cg_status
       WHERE discovered_at > NOW() - ($1 || ' days')::interval`,
      [String(days)],
    ),
    // Gate-killer breakdown: how many evaluated channels each gate eliminates
    // (channels can fail multiple gates → counts overlap).
    pool.query(
      `SELECT reason, COUNT(*) AS n
         FROM channel_cg_status, unnest(cg_fail_reasons) AS reason
        WHERE cg_evaluated_at IS NOT NULL
          AND discovered_at > NOW() - ($1 || ' days')::interval
        GROUP BY reason ORDER BY n DESC`,
      [String(days)],
    ),
    // Source attribution of eligible channels.
    pool.query(
      `SELECT COALESCE(discovered_source,'other') AS source,
              COUNT(*) FILTER (WHERE cg_eligible) AS eligible,
              COUNT(*) AS discovered
         FROM channel_cg_status
        WHERE discovered_at > NOW() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY eligible DESC`,
      [String(days)],
    ),
    // Per-seed leaderboard: top seeds by cg-eligible yield.
    pool.query(
      `SELECT s.discovered_by_seed_video_id AS seed_video_id,
              v.url AS seed_url, v.title AS seed_title,
              MAX(s.discovered_source) AS source,
              COUNT(*) AS channels_discovered,
              COUNT(*) FILTER (WHERE s.cg_eligible) AS cg_eligible,
              ROUND(100.0 * COUNT(*) FILTER (WHERE s.cg_eligible) / NULLIF(COUNT(*),0), 2) AS yield_pct
         FROM channel_cg_status s
         LEFT JOIN niche_spy_videos v ON v.id = s.discovered_by_seed_video_id
        WHERE s.discovered_by_seed_video_id IS NOT NULL
          AND s.cg_evaluated_at IS NOT NULL
        GROUP BY s.discovered_by_seed_video_id, v.url, v.title
       HAVING COUNT(*) FILTER (WHERE s.cg_eligible) > 0
        ORDER BY cg_eligible DESC, yield_pct DESC
        LIMIT 40`,
    ),
    // Golden feed: the actual channels that just passed.
    pool.query(
      `SELECT s.channel_id, sc.channel_name, sc.channel_handle, sc.channel_avatar,
              sc.subscriber_count, s.discovered_source, s.discovered_at, s.cg_evaluated_at,
              s.discovered_by_seed_video_id
         FROM channel_cg_status s
         JOIN niche_spy_channels sc ON sc.channel_id = s.channel_id
        WHERE s.cg_eligible
        ORDER BY s.cg_evaluated_at DESC NULLS LAST
        LIMIT 40`,
    ),
    // Health: enricher subs-fill-rate (last 24h) + eval backlog.
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM niche_spy_channels WHERE last_channel_fetched_at > NOW() - INTERVAL '24 hours') AS fetched_24h,
         (SELECT COUNT(*) FROM niche_spy_channels WHERE last_channel_fetched_at > NOW() - INTERVAL '24 hours' AND subscriber_count IS NOT NULL) AS fetched_subs_24h,
         (SELECT COUNT(*) FROM niche_spy_channels WHERE subscriber_count IS NULL) AS subs_backlog,
         (SELECT status FROM niche_yt_enrich_jobs ORDER BY id DESC LIMIT 1) AS enrich_status,
         (SELECT COUNT(*) FROM channel_cg_status) AS tracked,
         (SELECT COUNT(*) FROM channel_cg_status WHERE cg_evaluated_at IS NOT NULL) AS evaluated`,
    ),
  ]);

  const h = headline.rows[0];
  const hl = health.rows[0];
  const alertRow = await pool.query<{ value: string }>(`SELECT value FROM admin_config WHERE key = 'cg_kpi_alert'`);
  let alert: unknown = null;
  try { alert = alertRow.rows[0] ? JSON.parse(alertRow.rows[0].value) : null; } catch { alert = null; }
  return NextResponse.json({
    eval_version: CG_EVAL_VERSION,
    alert,
    headline: {
      eligible_1d: parseInt(h.elig_1d), eligible_7d: parseInt(h.elig_7d),
      eligible_prev7d: parseInt(h.elig_prev7d), eligible_total: parseInt(h.elig_total),
      avg_per_day_7d: Math.round((parseInt(h.elig_7d) / 7) * 10) / 10,
    },
    series: series.rows.map(r => ({
      day: r.day, discovered: parseInt(r.discovered),
      evaluated: parseInt(r.evaluated), eligible: parseInt(r.eligible),
    })),
    funnel: {
      discovered: parseInt(funnel.rows[0].discovered),
      evaluated: parseInt(funnel.rows[0].evaluated),
      passed_hard_gates: parseInt(funnel.rows[0].passed_hard_gates),
      eligible: parseInt(funnel.rows[0].eligible),
    },
    gate_killers: killers.rows.map(r => ({ reason: r.reason, n: parseInt(r.n) })),
    sources: sources.rows.map(r => ({ source: r.source, eligible: parseInt(r.eligible), discovered: parseInt(r.discovered) })),
    leaderboard: leaderboard.rows.map(r => ({
      seed_video_id: r.seed_video_id, seed_url: r.seed_url, seed_title: r.seed_title,
      source: r.source, channels_discovered: parseInt(r.channels_discovered),
      cg_eligible: parseInt(r.cg_eligible), yield_pct: r.yield_pct == null ? null : parseFloat(r.yield_pct),
    })),
    golden: golden.rows.map(r => ({
      channel_id: r.channel_id, channel_name: r.channel_name, channel_handle: r.channel_handle,
      channel_avatar: r.channel_avatar, subscriber_count: r.subscriber_count == null ? null : parseInt(r.subscriber_count),
      source: r.discovered_source, discovered_at: r.discovered_at, evaluated_at: r.cg_evaluated_at,
      seed_video_id: r.discovered_by_seed_video_id,
    })),
    health: {
      subs_fill_rate_24h: parseInt(hl.fetched_24h) > 0 ? Math.round(100 * parseInt(hl.fetched_subs_24h) / parseInt(hl.fetched_24h)) : null,
      subs_backlog: parseInt(hl.subs_backlog),
      enrich_status: hl.enrich_status,
      tracked: parseInt(hl.tracked),
      evaluated: parseInt(hl.evaluated),
    },
  });
}
