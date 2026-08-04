/**
 * Mining-pulse report — the TIME-triggered heartbeat post: live pipeline stats
 * + corpus scale. All numbers come straight from the DB at compose time (never
 * invented, never cached). The "gold insight" posts (discovery spotlight,
 * growth story) are now their own EVENT-triggered formats — see
 * lib/broadcast/{spotlight,growth}.ts — so the pulse stays a pure heartbeat.
 *
 * Detail level (2026-07-26): the pulse now breaks NEW discoveries down by
 * subscriber-size group (the "tiny channels" KPI) and reports the growth-watch
 * cohort in depth (size mix, how many are already growing, days of history)
 * rather than a bare total. All added queries are day-indexed / bounded and
 * measured cheap (<~0.6s total) since the pulse composes on a tick.
 *
 * Platform-agnostic: the senders render it per platform (Telegram HTML /
 * Discord markdown).
 */
import type { Pool } from 'pg';

/** One subscriber-size group, with new-discovery counts for 2h + 24h windows. */
export interface SizeBucket { key: string; emoji: string; label: string; d2h: number; d24h: number }

/** Deep per-group breakdown for the genesis (tiny) cohort — how many are
 *  growing vs stalled vs shrinking, at what rate, and their content volume. */
export interface TinyGroupDetail {
  key: string; emoji: string; label: string;
  n: number;
  growing: number; flat: number; dropped: number;
  avgGain: number;      // avg subs gained since catch, among growers
  perDay: number;       // avg subs/day, among growers
  vids1_5: number; vids6_20: number; vids21: number;
}

/** Canonical subscriber-size groups (shared shape for discovery + tracking). */
export const SIZE_DEFS: Array<{ key: string; emoji: string; label: string }> = [
  { key: 'lt10',      emoji: '🥚', label: '0 – 10 subs' },
  { key: 's10_100',   emoji: '🐣', label: '10 – 100 subs' },
  { key: 's100_1k',   emoji: '🌱', label: '100 – 1K' },
  { key: 's1k_10k',   emoji: '🌿', label: '1K – 10K' },
  { key: 's10k_100k', emoji: '📈', label: '10K – 100K' },
  { key: 's100k_1m',  emoji: '🔥', label: '100K – 1M' },
  { key: 's1m',       emoji: '⭐', label: '1M+' },
];

export interface BroadcastStats {
  // New-discovery windows
  chans2h: number; chans24h: number;
  vids2h: number; edges2h: number;
  discBySize: SizeBucket[];
  // Corpus scale
  vidsTotal: string; chansTotal: string; edgesTotal: string;
  // Growth-watch cohort
  tracked: number; trackedGrowing: number;
  tinyGroups: TinyGroupDetail[];   // 🥚 0-10 and 🐣 10-100, in depth
  trk100_1k: number; trk1k_10k: number; trk10k: number;
  historyDays: number;       // calendar days of daily history so far
  historyAvgDepth: number;   // avg measurements (days) per tracked channel
  historyDeep: number;       // channels with 5+ days of history
  measurementsTotal: string;
  // Listener — niche upload watching (0 when no listener is enabled)
  listenerChannels: number; listenerVideos24h: number; listenerOverdue: number;
}

export interface BroadcastReport {
  title: string;
  stats: BroadcastStats;
  insight: { emoji: string; label: string; text: string } | null;  // reserved; pulse is stats-only
  featuredKey: string | null;
  kind: string;
}

export function fmt(n: number | string | null | undefined): string {
  const v = typeof n === 'string' ? parseFloat(n) : (n ?? 0);
  if (!isFinite(v)) return '0';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(v >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(Math.round(v));
}

const SIZE_CASE = `CASE
  WHEN c.subscriber_count IS NULL      THEN 'unknown'
  WHEN c.subscriber_count < 10         THEN 'lt10'
  WHEN c.subscriber_count < 100        THEN 's10_100'
  WHEN c.subscriber_count < 1000       THEN 's100_1k'
  WHEN c.subscriber_count < 10000      THEN 's1k_10k'
  WHEN c.subscriber_count < 100000     THEN 's10k_100k'
  WHEN c.subscriber_count < 1000000    THEN 's100k_1m'
  ELSE 's1m' END`;

/** Live pulse stats — cheap indexed window counts + estimated totals + the
 *  discovery size-breakdown and growth-cohort depth. */
async function buildStats(pool: Pool): Promise<BroadcastStats> {
  // Windows + corpus totals (reltuples estimates — no full counts).
  const base = await pool.query<{ k: string; v: string }>(`
    SELECT 'chans_2h' k, COUNT(*)::text v FROM channel_cg_status WHERE discovered_at > NOW()-INTERVAL '2 hours'
    UNION ALL SELECT 'chans_24h', COUNT(*)::text FROM channel_cg_status WHERE discovered_at > NOW()-INTERVAL '24 hours'
    UNION ALL SELECT 'vids_2h', COUNT(*)::text FROM niche_spy_videos WHERE COALESCE(fetched_at,synced_at) > NOW()-INTERVAL '2 hours'
    UNION ALL SELECT 'edges_2h', COUNT(*)::text FROM niche_seed_expansions WHERE detected_at > NOW()-INTERVAL '2 hours'
    UNION ALL SELECT 'vids_total', reltuples::bigint::text FROM pg_class WHERE relname='niche_spy_videos'
    UNION ALL SELECT 'chans_total', reltuples::bigint::text FROM pg_class WHERE relname='niche_spy_channels'
    UNION ALL SELECT 'edges_total', reltuples::bigint::text FROM pg_class WHERE relname='niche_seed_expansions'
    UNION ALL SELECT 'snaps_total', reltuples::bigint::text FROM pg_class WHERE relname='channel_growth_snapshots'
  `);
  const m: Record<string, string> = {};
  for (const r of base.rows) m[r.k] = r.v;

  // NEW discoveries in the last 24h, bucketed by subscriber size, split 2h/24h.
  // Scans only the 24h discovery slice (~few thousand rows via idx_ccs_discovered_at).
  const disc = await pool.query<{ bucket: string; d2h: number; d24h: number }>(`
    SELECT ${SIZE_CASE} AS bucket,
           COUNT(*) FILTER (WHERE s.discovered_at > NOW()-INTERVAL '2 hours')::int  AS d2h,
           COUNT(*) FILTER (WHERE s.discovered_at > NOW()-INTERVAL '24 hours')::int AS d24h
      FROM channel_cg_status s
      JOIN niche_spy_channels c ON c.channel_id = s.channel_id
     WHERE s.discovered_at > NOW()-INTERVAL '24 hours'
     GROUP BY bucket`);
  const dm: Record<string, { d2h: number; d24h: number }> = {};
  for (const r of disc.rows) dm[r.bucket] = { d2h: r.d2h, d24h: r.d24h };
  const discBySize: SizeBucket[] = SIZE_DEFS.map(d => ({
    ...d, d2h: dm[d.key]?.d2h ?? 0, d24h: dm[d.key]?.d24h ?? 0,
  }));

  // Growth-watch cohort: total, how many already grew, size mix. One scan of
  // growth_tracked_channels (~65K rows, ~50ms).
  const trk = await pool.query<{ total: number; growing: number; s100_1k: number; s1k_10k: number; s10k: number }>(`
    SELECT COUNT(*)::int total,
           COUNT(*) FILTER (WHERE showed_life)::int growing,
           COUNT(*) FILTER (WHERE COALESCE(last_subs,first_caught_subs) BETWEEN 100 AND 999)::int s100_1k,
           COUNT(*) FILTER (WHERE COALESCE(last_subs,first_caught_subs) BETWEEN 1000 AND 9999)::int s1k_10k,
           COUNT(*) FILTER (WHERE COALESCE(last_subs,first_caught_subs) >= 10000)::int s10k
      FROM growth_tracked_channels`);
  const t = trk.rows[0];

  // Genesis cohort (subs < 100) in depth, split 0–10 / 10–100: growing vs
  // stalled vs shrinking, growth rate among growers, and content-volume mix.
  // Single ~90ms scan of the sub-100 slice.
  const tinyQ = await pool.query<{
    grp: string; n: number; growing: number; flat: number; dropped: number;
    avg_gain: string | null; per_day: string | null; v1_5: number; v6_20: number; v21: number;
  }>(`
    WITH t AS (
      SELECT CASE WHEN COALESCE(last_subs,first_caught_subs) < 10 THEN 'lt10' ELSE 's10_100' END grp,
             COALESCE(last_subs,first_caught_subs) - COALESCE(first_caught_subs,0) gain,
             COALESCE(last_video_count, first_caught_video_count, 0) vids,
             GREATEST(EXTRACT(EPOCH FROM (NOW()-first_caught_at))/86400, 0.5) age_days
        FROM growth_tracked_channels
       WHERE COALESCE(last_subs,first_caught_subs) < 100
    )
    SELECT grp,
           COUNT(*)::int n,
           COUNT(*) FILTER (WHERE gain > 0)::int growing,
           COUNT(*) FILTER (WHERE gain = 0)::int flat,
           COUNT(*) FILTER (WHERE gain < 0)::int dropped,
           ROUND(AVG(gain) FILTER (WHERE gain > 0), 1)          avg_gain,
           ROUND(AVG(gain / age_days) FILTER (WHERE gain > 0), 2) per_day,
           COUNT(*) FILTER (WHERE vids BETWEEN 1 AND 5)::int  v1_5,
           COUNT(*) FILTER (WHERE vids BETWEEN 6 AND 20)::int v6_20,
           COUNT(*) FILTER (WHERE vids > 20)::int             v21
      FROM t GROUP BY grp`);
  const tm: Record<string, typeof tinyQ.rows[number]> = {};
  for (const r of tinyQ.rows) tm[r.grp] = r;
  const tinyGroups: TinyGroupDetail[] = SIZE_DEFS.filter(d => d.key === 'lt10' || d.key === 's10_100').map(d => {
    const r = tm[d.key];
    return {
      key: d.key, emoji: d.emoji, label: d.label,
      n: r?.n ?? 0, growing: r?.growing ?? 0, flat: r?.flat ?? 0, dropped: r?.dropped ?? 0,
      avgGain: r?.avg_gain ? parseFloat(r.avg_gain) : 0,
      perDay: r?.per_day ? parseFloat(r.per_day) : 0,
      vids1_5: r?.v1_5 ?? 0, vids6_20: r?.v6_20 ?? 0, vids21: r?.v21 ?? 0,
    };
  });

  // History depth: calendar span + per-channel measurement depth. The per-channel
  // GROUP BY scans the snapshots table once (~200ms at current size); grows
  // linearly with history length — revisit (sample/bound) if it crosses ~1s.
  const hist = await pool.query<{ days: number; avg_depth: string | null; deep: number }>(`
    WITH per_chan AS (SELECT channel_id, COUNT(*) d FROM channel_growth_snapshots GROUP BY channel_id)
    SELECT (SELECT COUNT(DISTINCT day) FROM channel_growth_snapshots)::int AS days,
           ROUND(AVG(d), 1)                    AS avg_depth,
           COUNT(*) FILTER (WHERE d >= 5)::int  AS deep
      FROM per_chan`);
  const h = hist.rows[0];

  return {
    chans2h: parseInt(m.chans_2h) || 0,
    chans24h: parseInt(m.chans_24h) || 0,
    vids2h: parseInt(m.vids_2h) || 0,
    edges2h: parseInt(m.edges_2h) || 0,
    discBySize,
    vidsTotal: fmt(m.vids_total), chansTotal: fmt(m.chans_total), edgesTotal: fmt(m.edges_total),
    tracked: t?.total ?? 0,
    trackedGrowing: t?.growing ?? 0,
    // Listener defaults; filled in by buildBroadcastReport below (0 when none enabled).
    listenerChannels: 0, listenerVideos24h: 0, listenerOverdue: 0,
    tinyGroups,
    trk100_1k: t?.s100_1k ?? 0, trk1k_10k: t?.s1k_10k ?? 0, trk10k: t?.s10k ?? 0,
    historyDays: h?.days ?? 0,
    historyAvgDepth: h?.avg_depth ? parseFloat(h.avg_depth) : 0,
    historyDeep: h?.deep ?? 0,
    measurementsTotal: fmt(m.snaps_total),
  };
}

/** Build the heartbeat report (stats only). rotationIdx accepted for caller
 *  compatibility but no longer used — insights are event-driven now. */
export async function buildBroadcastReport(pool: Pool, _rotationIdx?: number): Promise<BroadcastReport> {
  const stats = await buildStats(pool);
  // Listener status — folded into the daily pulse so its health is reported
  // without anyone having to ask. Zeros when no listener is enabled.
  const lsn = await pool.query<{ ch: string; v24: string; overdue: string }>(
    `SELECT
       (SELECT COUNT(*) FROM listener_channels lc JOIN listeners l ON l.id=lc.listener_id AND l.enabled)::text AS ch,
       (SELECT COUNT(*) FROM listener_videos WHERE detected_at > NOW()-INTERVAL '24 hours')::text AS v24,
       (SELECT COUNT(*) FROM listener_channels lc JOIN listeners l ON l.id=lc.listener_id AND l.enabled
         WHERE lc.last_checked_at IS NULL
            OR lc.last_checked_at < NOW()-(l.poll_interval_hours||' hours')::interval)::text AS overdue`
  ).catch(() => null);
  stats.listenerChannels  = parseInt(lsn?.rows[0]?.ch   ?? '0');
  stats.listenerVideos24h = parseInt(lsn?.rows[0]?.v24  ?? '0');
  stats.listenerOverdue   = parseInt(lsn?.rows[0]?.overdue ?? '0');

  return { title: 'rofe.ai mining pulse', stats, insight: null, featuredKey: null, kind: 'pulse' };
}
