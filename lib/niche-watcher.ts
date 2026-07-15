import { getPool } from '@/lib/db';
import { reMeasureChannels } from '@/lib/channel-remeasure';

/**
 * Niche Watcher tick — the cheap (YT-key) pulse. Each tick picks the most-STALE
 * channels that belong to a currently-watched niche and hands them to the shared
 * reMeasureChannels engine (fresh stats + recent uploads). Cadence is CHANNEL-
 * level (a channel gets re-pulsed every WATCH_CADENCE_HOURS), which self-paces
 * without a cursor and naturally covers a niche over successive ticks.
 *
 * Runs on its OWN interval (not the 60s runAll) — reMeasure is sequential over a
 * bounded batch and could take ~10-20s; it must not stall the flywheel ticks.
 * Kill switch: admin_config niche_watcher_enabled='false'.
 */
const WATCH_BATCH = 12;            // channels re-measured per tick (recent-uploads is 1 YT call each → keep small)
const WATCH_CADENCE_HOURS = 8;
const WATCHER_LOCK = 728412002;    // cluster-wide advisory mutex (distinct from cg-sweep's)

export interface NicheWatcherResult {
  enabled: boolean;
  skipped: boolean;
  channels: number;
  statsUpdated: number;
  recentPulled: number;
}

async function isEnabled(): Promise<boolean> {
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(`SELECT value FROM admin_config WHERE key = 'niche_watcher_enabled'`);
  return (r.rows[0]?.value ?? 'true') !== 'false';   // default ON
}

export async function runNicheWatcherTick(): Promise<NicheWatcherResult> {
  const base: NicheWatcherResult = { enabled: true, skipped: false, channels: 0, statsUpdated: 0, recentPulled: 0 };
  if (!(await isEnabled())) return { ...base, enabled: false };

  const pool = await getPool();
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [WATCHER_LOCK]);
    if (!lock.rows[0]?.locked) return { ...base, skipped: true };
    try {
      // Most-stale channels in currently-watched (cheap) niches, due for a re-pulse.
      // Bounded + rides niche_tree_assignments.cluster_id (few watched clusters).
      const r = await pool.query<{ channel_id: string }>(
        `WITH watched AS (
           SELECT DISTINCT cluster_id FROM user_niche_watches WHERE watch_type = 'cheap'
         ),
         watched_channels AS (
           SELECT DISTINCT v.channel_id
             FROM niche_tree_assignments a
             JOIN niche_spy_videos v ON v.id = a.video_id
            WHERE a.cluster_id IN (SELECT cluster_id FROM watched)
              AND v.channel_id IS NOT NULL
         )
         SELECT wc.channel_id
           FROM watched_channels wc
           JOIN niche_spy_channels sc ON sc.channel_id = wc.channel_id
          WHERE sc.last_recent_videos_fetched_at IS NULL
             OR sc.last_recent_videos_fetched_at < NOW() - ($2 || ' hours')::interval
          ORDER BY sc.last_recent_videos_fetched_at ASC NULLS FIRST
          LIMIT $1`,
        [WATCH_BATCH, String(WATCH_CADENCE_HOURS)],
      );
      const ids = r.rows.map(x => x.channel_id);
      if (ids.length === 0) return base;

      const res = await reMeasureChannels(ids, { recentUploads: true, maxRecent: 10 });

      // Informational per-niche "last pulsed" stamp for the watched clusters.
      await pool.query(
        `INSERT INTO niche_watch_state (cluster_id, last_watched_at)
         SELECT DISTINCT cluster_id, NOW() FROM user_niche_watches WHERE watch_type = 'cheap'
         ON CONFLICT (cluster_id) DO UPDATE SET last_watched_at = NOW()`,
      ).catch(() => {});

      return { enabled: true, skipped: false, channels: ids.length, statsUpdated: res.statsUpdated, recentPulled: res.recentPulled };
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [WATCHER_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
