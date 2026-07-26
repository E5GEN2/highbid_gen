/**
 * Broadcast report builder — composes the periodic "mining pulse" post:
 * live pipeline stats + one rotating featured insight. All numbers come
 * straight from the DB at compose time (never invented, never cached).
 *
 * Platform-agnostic output: the senders render Segments per platform
 * (Telegram HTML / Discord markdown).
 */
import type { Pool } from 'pg';

export interface BroadcastStats {
  chans2h: string; vids2h: string; edges2h: string;
  chans24h: string;
  vidsTotal: string; chansTotal: string; edgesTotal: string;
  tracked: string; snapshots: string;
}

export interface BroadcastReport {
  title: string;          // e.g. "rofe.ai mining pulse"
  stats: BroadcastStats;  // pre-formatted display numbers (fmt applied)
  insight: { emoji: string; label: string; text: string } | null;
  featuredKey: string | null;  // dedup key (e.g. 'chan:<id>') recorded on the post
  kind: string;           // which insight rotation fired (for logging/rotation)
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

/** Rotation slot 0 — discovery spotlight: the most impressive channel found
 *  in the last 48h (young + already big; ranked by subs-per-day-of-age). */
async function discoverySpotlight(pool: Pool): Promise<{ text: string; key: string } | null> {
  const r = await pool.query<{ channel_id: string; channel_name: string | null; subs: string; vids: number; age_days: number }>(
    `SELECT c.channel_id, c.channel_name, c.subscriber_count::text AS subs, c.video_count AS vids,
            GREATEST(EXTRACT(day FROM NOW()-c.channel_created_at)::int, 1) AS age_days
       FROM channel_cg_status s
       JOIN niche_spy_channels c ON c.channel_id = s.channel_id
      WHERE s.discovered_at > NOW()-INTERVAL '48 hours'
        AND c.subscriber_count >= 10000
        AND c.channel_created_at > NOW()-INTERVAL '18 months'
        AND NOT EXISTS (SELECT 1 FROM broadcast_posts b
                         WHERE b.featured_key = 'chan:'||c.channel_id
                           AND b.posted_at > NOW()-INTERVAL '14 days')
      ORDER BY c.subscriber_count::float / GREATEST(EXTRACT(day FROM NOW()-c.channel_created_at), 30) DESC
      LIMIT 1`,
  );
  const row = r.rows[0];
  if (!row) return null;
  const months = Math.max(1, Math.round(row.age_days / 30));
  return {
    text: `Just found: "${row.channel_name ?? row.channel_id}" — ${fmt(row.subs)} subscribers in only ~${months} month${months > 1 ? 's' : ''} (${row.vids} videos). A brand-new channel already taking off.`,
    key: `chan:${row.channel_id}`,
  };
}

/** Rotation slot 1 — growth story: biggest relative subscriber jump among
 *  tracked channels over the last ~week (needs 2+ snapshots, real growth). */
async function growthStory(pool: Pool): Promise<{ text: string; key: string } | null> {
  const r = await pool.query<{ channel_id: string; channel_name: string | null; subs0: string; subs1: string; days: number }>(
    `WITH win AS (
       SELECT channel_id, MIN(day) d0, MAX(day) d1
         FROM channel_growth_snapshots
        WHERE day > CURRENT_DATE - 8 AND subscriber_count IS NOT NULL
        GROUP BY channel_id
       HAVING COUNT(DISTINCT day) >= 2 AND MAX(day) > MIN(day)
     ), pairs AS (
       SELECT w.channel_id, (w.d1 - w.d0) AS days,
              (SELECT s.subscriber_count FROM channel_growth_snapshots s
                WHERE s.channel_id = w.channel_id AND s.day = w.d0
                ORDER BY s.captured_at ASC LIMIT 1) AS subs0,
              (SELECT s.subscriber_count FROM channel_growth_snapshots s
                WHERE s.channel_id = w.channel_id AND s.day = w.d1
                ORDER BY s.captured_at DESC LIMIT 1) AS subs1
         FROM win w
     )
     SELECT p.channel_id, c.channel_name, p.subs0::text AS subs0, p.subs1::text AS subs1, p.days
       FROM pairs p
       JOIN niche_spy_channels c ON c.channel_id = p.channel_id
      WHERE p.subs0 >= 100 AND p.subs1 > p.subs0 * 1.3
        AND NOT EXISTS (SELECT 1 FROM broadcast_posts b
                         WHERE b.featured_key = 'chan:'||p.channel_id
                           AND b.posted_at > NOW()-INTERVAL '14 days')
      ORDER BY p.subs1::float / GREATEST(p.subs0::float, 1) DESC
      LIMIT 1`,
  );
  const row = r.rows[0];
  if (!row) return null;
  const x = (parseFloat(row.subs1) / Math.max(parseFloat(row.subs0), 1)).toFixed(1);
  return {
    text: `"${row.channel_name ?? row.channel_id}" jumped from ${fmt(row.subs0)} to ${fmt(row.subs1)} subscribers in just ${row.days} day${row.days > 1 ? 's' : ''} — that's ${x}× bigger. We spotted it early and have been watching it grow.`,
    key: `chan:${row.channel_id}`,
  };
}

/** Rotation slot 2 — big number: an aggregate flex from the last 24h. */
async function bigNumber(pool: Pool): Promise<{ text: string; key: null } | null> {
  const r = await pool.query<{ vids24: string; enr24: string; newborn: string }>(
    `SELECT
       (SELECT COUNT(*) FROM niche_spy_videos WHERE COALESCE(fetched_at,synced_at) > NOW()-INTERVAL '24 hours')::text AS vids24,
       (SELECT COUNT(*) FROM niche_spy_videos WHERE enriched_at > NOW()-INTERVAL '24 hours')::text AS enr24,
       (SELECT COUNT(*) FROM niche_spy_channels WHERE channel_created_at > NOW()-INTERVAL '30 days')::text AS newborn`,
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    text: `In the last 24 hours we analyzed ${fmt(row.vids24)} videos and updated the stats on ${fmt(row.enr24)} more. We're now tracking ${fmt(row.newborn)} channels that are less than a month old.`,
    key: null,
  };
}

const ROTATION: Array<{ kind: string; emoji: string; label: string; fn: (p: Pool) => Promise<{ text: string; key: string | null } | null> }> = [
  { kind: 'spotlight', emoji: '🔭', label: 'Discovery spotlight', fn: discoverySpotlight },
  { kind: 'growth',    emoji: '🌱', label: 'Growth story',        fn: growthStory },
  { kind: 'bignum',    emoji: '⛏️', label: 'Mining numbers',      fn: bigNumber },
];

/**
 * Build the full report. `rotationIdx` picks the insight slot; if that slot
 * has nothing fresh (e.g. no un-featured spotlight candidate), fall through
 * to the next so a post always carries SOME insight when possible.
 */
export async function buildBroadcastReport(pool: Pool, rotationIdx: number): Promise<BroadcastReport> {
  const stats = await buildStats(pool);
  for (let i = 0; i < ROTATION.length; i++) {
    const slot = ROTATION[(rotationIdx + i) % ROTATION.length];
    try {
      const got = await slot.fn(pool);
      if (got) {
        return {
          title: 'rofe.ai mining pulse',
          stats,
          insight: { emoji: slot.emoji, label: slot.label, text: got.text },
          featuredKey: got.key,
          kind: slot.kind,
        };
      }
    } catch (err) {
      console.error(`[broadcast] insight ${slot.kind} failed:`, (err as Error).message);
    }
  }
  return { title: 'rofe.ai mining pulse', stats, insight: null, featuredKey: null, kind: 'stats_only' };
}
