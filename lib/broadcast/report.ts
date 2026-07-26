/**
 * Mining-pulse report — the TIME-triggered heartbeat post: live pipeline stats
 * + corpus scale. All numbers come straight from the DB at compose time (never
 * invented, never cached). The "gold insight" posts (discovery spotlight,
 * growth story) are now their own EVENT-triggered formats — see
 * lib/broadcast/{spotlight,growth}.ts — so the pulse stays a pure heartbeat.
 *
 * Platform-agnostic: the senders render it per platform (Telegram HTML /
 * Discord markdown).
 */
import type { Pool } from 'pg';

export interface BroadcastStats {
  chans2h: string; vids2h: string; edges2h: string;
  chans24h: string;
  vidsTotal: string; chansTotal: string; edgesTotal: string;
  tracked: string; snapshots: string;
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
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(v >= 10_000 ? 0 : 1) + 'K';
  return String(Math.round(v));
}

/** Live pulse stats — cheap indexed window counts + estimated totals. */
async function buildStats(pool: Pool): Promise<BroadcastStats> {
  const q = await pool.query<{ k: string; v: string }>(`
    SELECT 'chans_2h' k, COUNT(*)::text v FROM channel_cg_status WHERE discovered_at > NOW()-INTERVAL '2 hours'
    UNION ALL SELECT 'chans_24h', COUNT(*)::text FROM channel_cg_status WHERE discovered_at > NOW()-INTERVAL '24 hours'
    UNION ALL SELECT 'vids_2h', COUNT(*)::text FROM niche_spy_videos WHERE COALESCE(fetched_at,synced_at) > NOW()-INTERVAL '2 hours'
    UNION ALL SELECT 'edges_2h', COUNT(*)::text FROM niche_seed_expansions WHERE detected_at > NOW()-INTERVAL '2 hours'
    UNION ALL SELECT 'vids_total', reltuples::bigint::text FROM pg_class WHERE relname='niche_spy_videos'
    UNION ALL SELECT 'chans_total', reltuples::bigint::text FROM pg_class WHERE relname='niche_spy_channels'
    UNION ALL SELECT 'edges_total', reltuples::bigint::text FROM pg_class WHERE relname='niche_seed_expansions'
    UNION ALL SELECT 'tracked', COUNT(*)::text FROM growth_tracked_channels
    UNION ALL SELECT 'snapshots', reltuples::bigint::text FROM pg_class WHERE relname='channel_growth_snapshots'
  `);
  const m: Record<string, string> = {};
  for (const r of q.rows) m[r.k] = r.v;
  return {
    chans2h: fmt(m.chans_2h), vids2h: fmt(m.vids_2h), edges2h: fmt(m.edges_2h),
    chans24h: fmt(m.chans_24h),
    vidsTotal: fmt(m.vids_total), chansTotal: fmt(m.chans_total), edgesTotal: fmt(m.edges_total),
    tracked: fmt(m.tracked), snapshots: fmt(m.snapshots),
  };
}

/** Build the heartbeat report (stats only). rotationIdx accepted for caller
 *  compatibility but no longer used — insights are event-driven now. */
export async function buildBroadcastReport(pool: Pool, _rotationIdx?: number): Promise<BroadcastReport> {
  const stats = await buildStats(pool);
  return { title: 'rofe.ai mining pulse', stats, insight: null, featuredKey: null, kind: 'pulse' };
}
