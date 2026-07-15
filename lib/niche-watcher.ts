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
  newVideos: number;   // brand-new videos assigned into watched clusters this tick
}

async function isEnabled(): Promise<boolean> {
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(`SELECT value FROM admin_config WHERE key = 'niche_watcher_enabled'`);
  return (r.rows[0]?.value ?? 'true') !== 'false';   // default ON
}

export async function runNicheWatcherTick(): Promise<NicheWatcherResult> {
  const base: NicheWatcherResult = { enabled: true, skipped: false, channels: 0, statsUpdated: 0, recentPulled: 0, newVideos: 0 };
  if (!(await isEnabled())) return { ...base, enabled: false };

  const pool = await getPool();
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [WATCHER_LOCK]);
    if (!lock.rows[0]?.locked) return { ...base, skipped: true };
    try {
      // Most-stale channels in currently-watched (cheap) niches, due for a
      // re-pulse. DISTINCT ON (channel_id) maps each channel to ONE watched
      // cluster so a genuinely-new upload from it can be assigned back there.
      // Bounded + rides niche_tree_assignments.cluster_id (few watched clusters).
      const r = await pool.query<{ channel_id: string; cluster_id: number }>(
        `WITH watched AS (
           SELECT DISTINCT cluster_id FROM user_niche_watches WHERE watch_type = 'cheap'
         ),
         watched_channels AS (
           SELECT DISTINCT ON (v.channel_id) v.channel_id, a.cluster_id
             FROM niche_tree_assignments a
             JOIN niche_spy_videos v ON v.id = a.video_id
            WHERE a.cluster_id IN (SELECT cluster_id FROM watched)
              AND v.channel_id IS NOT NULL
            ORDER BY v.channel_id, a.cluster_id
         )
         SELECT wc.channel_id, wc.cluster_id
           FROM watched_channels wc
           JOIN niche_spy_channels sc ON sc.channel_id = wc.channel_id
          WHERE sc.last_recent_videos_fetched_at IS NULL
             OR sc.last_recent_videos_fetched_at < NOW() - ($2 || ' hours')::interval
          ORDER BY sc.last_recent_videos_fetched_at ASC NULLS FIRST
          LIMIT $1`,
        [WATCH_BATCH, String(WATCH_CADENCE_HOURS)],
      );
      if (r.rows.length === 0) return base;
      const channelCluster = new Map<string, number>();
      for (const row of r.rows) channelCluster.set(row.channel_id, row.cluster_id);
      const ids = [...channelCluster.keys()];

      const res = await reMeasureChannels(ids, { recentUploads: true, maxRecent: 10 });

      // Assign the brand-new videos into their channel's watched cluster,
      // stamped assigned_at=NOW() so the /fresh feed can surface them and flag
      // "new since your last visit". Fresh inserts have no prior assignment, so
      // no conflict handling is needed. run_id comes from the cluster row.
      const newVideos = res.newVideos.filter(nv => channelCluster.has(nv.channelId));
      if (newVideos.length > 0) {
        const clusterIds = [...new Set(newVideos.map(nv => channelCluster.get(nv.channelId)!))];
        const runRes = await pool.query<{ id: number; run_id: number }>(
          `SELECT id, run_id FROM niche_tree_clusters WHERE id = ANY($1::int[])`, [clusterIds],
        );
        const clusterRun = new Map<number, number>();
        for (const row of runRes.rows) clusterRun.set(row.id, row.run_id);

        const seen = new Set<number>();   // dedup videoId across channel rows
        const vals: string[] = [];
        const params: number[] = [];
        let p = 0;
        for (const nv of newVideos) {
          if (seen.has(nv.videoId)) continue;
          const clusterId = channelCluster.get(nv.channelId)!;
          const runId = clusterRun.get(clusterId);
          if (runId == null) continue;
          seen.add(nv.videoId);
          vals.push(`($${++p}, $${++p}, $${++p}, 0, NOW())`);
          params.push(runId, clusterId, nv.videoId);
        }
        if (vals.length > 0) {
          await pool.query(
            `INSERT INTO niche_tree_assignments (run_id, cluster_id, video_id, cluster_index, assigned_at)
             VALUES ${vals.join(', ')}`,
            params,
          ).then(() => { base.newVideos = vals.length; }).catch(() => {});
        }
      }

      // Informational per-niche "last pulsed" stamp for the watched clusters.
      await pool.query(
        `INSERT INTO niche_watch_state (cluster_id, last_watched_at)
         SELECT DISTINCT cluster_id, NOW() FROM user_niche_watches WHERE watch_type = 'cheap'
         ON CONFLICT (cluster_id) DO UPDATE SET last_watched_at = NOW()`,
      ).catch(() => {});

      return { enabled: true, skipped: false, channels: ids.length, statsUpdated: res.statsUpdated, recentPulled: res.recentPulled, newVideos: base.newVideos };
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [WATCHER_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
