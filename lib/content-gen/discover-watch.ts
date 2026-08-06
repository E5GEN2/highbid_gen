/**
 * DISCOVER WATCH — the "expensive" half of the Niche Watcher.
 *
 * The cheap watcher (lib/niche-watcher.ts) re-measures channels we ALREADY know in a
 * watched niche, via YT Data keys. It can never surface a channel we haven't seen.
 * This lane sends xgodo niche-spy AGENTS into those same niches to discover NEW
 * channels — the (A)/expensive half of the watch split that was designed but never
 * built (the watch API already writes watch_type='discover'; nothing consumed it, so
 * a user could spend a slot and get literally nothing).
 *
 * DESIGN STANCE (from the original watcher design): a forced watch is a user-driven
 * PRIORITY OVERLAY on the same discovery agents — NOT a separate crawl engine. So this
 * reuses the existing dispatch path and only changes WHICH clusters get picked and
 * from WHOSE budget.
 *
 * ── Budget ───────────────────────────────────────────────────────────────────
 * A dedicated slice of xgodo threads (default 3), carved out before novelty/respy
 * take theirs, so user-watched niches always get served and can never be starved by
 * the system's own yield-chasing. Equally, it is CAPPED, so watches can't eat the
 * fleet.
 *
 * ── Target set ───────────────────────────────────────────────────────────────
 * The very same clusters the cheap watcher pulses (`user_niche_watches`), so a watch
 * gives the user both halves: existing channels re-measured AND new ones discovered.
 *
 * ── Output ───────────────────────────────────────────────────────────────────
 * None special, by design. Discovered channels land in niche_spy_videos /
 * niche_spy_channels like any other crawl output and the clustering engine assigns
 * them to clusters from their videos. No bespoke notification path to maintain.
 *
 * ── Cadence is MEASURED, not guessed ─────────────────────────────────────────
 * Rows are tagged source='discover_watch', so stampSeedYield() fills new_channels +
 * crawl_minutes for them exactly as it does for every other mode. That makes
 * new-channels-per-thread-hour directly comparable across cadences, so the interval
 * below is a starting point to TUNE from evidence, not a constant to trust:
 *   - measured yield SATURATES ~24h after a cluster's last crawl (re-crawling inside
 *     12h costs ~40% of the yield), and there is no measured gain from waiting beyond
 *     ~24-72h, so anything under a day is provably wasteful.
 *   - a completed revisit crawl yields ~15-27 new channels.
 * Start at 48h and let the yield data move it.
 */
import { getPool } from '../db';

/**
 * `niche_watch_state.last_discover_at` — this lane's cadence gate, kept separate from
 * the cheap watcher's `last_watched_at` so the two halves pace independently (cheap is
 * 8h/channel, discovery is days/cluster).
 *
 * Created HERE rather than in lib/db.ts initSchema deliberately: db.ts is a shared file
 * that other agents are editing concurrently, and this keeps the change inside the
 * module that owns it. Runs at most once per process, and role-level lock_timeout=30s
 * means it can never queue behind a long lock holder (the failure mode that stalled the
 * pool for 11h on 2026-08-04).
 */
let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const pool = await getPool();
      await pool.query(
        `ALTER TABLE niche_watch_state ADD COLUMN IF NOT EXISTS last_discover_at TIMESTAMPTZ`,
      ).catch((e) => console.warn('[discover-watch] schema init skipped:', (e as Error).message));
    })();
  }
  return schemaReady;
}

export interface DiscoverWatchCandidate {
  cluster_id: number;
  video_id: number;
  url: string;
  title: string | null;
  hours_since_last: number | null;
  watchers: number;
}

/**
 * Watched clusters that are DUE a discovery crawl, with one un-seeded seed video each.
 * Ordered by staleness (longest-waiting first) so coverage rotates fairly rather than
 * repeatedly favouring the same niche.
 */
export async function findDiscoverWatchCandidates(
  limit: number,
  cadenceHours: number,
): Promise<DiscoverWatchCandidate[]> {
  await ensureSchema();
  const pool = await getPool();
  const res = await pool.query<{
    cluster_id: string; video_id: string; url: string; title: string | null;
    hours_since: string | null; watchers: string;
  }>(
    `WITH latest_run AS (
       SELECT id FROM niche_tree_runs
        WHERE kind = 'global' AND status = 'done'
        ORDER BY started_at DESC NULLS LAST LIMIT 1
     ),
     -- Target set = the niches we are already LISTENING to, plus any per-user watches.
     --
     -- The primary source is `listeners.cluster_ids` (lib/listener.ts): the Listener
     -- polls known channels in a semantically-chosen bucket for new UPLOADS, so it can
     -- only ever see channels we already have. This lane crawls those same niches for
     -- channels we DON'T have — the two halves of one idea, pointed at one target set.
     -- (`user_niche_watches` is the separate per-user watch-slot feature; unioned in so
     -- a user watch is served too, but it is not the main source.)
     watched AS (
       SELECT cluster_id, COUNT(*) AS watchers FROM (
         SELECT unnest(l.cluster_ids) AS cluster_id
           FROM listeners l WHERE l.enabled
         UNION ALL
         SELECT cluster_id FROM user_niche_watches
       ) t
       WHERE cluster_id IS NOT NULL
       GROUP BY cluster_id
     ),
     due AS (
       SELECT w.cluster_id, w.watchers,
              EXTRACT(EPOCH FROM (NOW() - s.last_discover_at))/3600.0 AS hours_since
         FROM watched w
         LEFT JOIN niche_watch_state s ON s.cluster_id = w.cluster_id
        WHERE s.last_discover_at IS NULL
           OR s.last_discover_at < NOW() - ($2 || ' hours')::interval
     ),
     -- One un-seeded video per due cluster to act as the crawl entry point.
     pick AS (
       SELECT DISTINCT ON (a.cluster_id)
              a.cluster_id, v.id AS video_id, v.url, v.title
         FROM niche_tree_assignments a
         JOIN niche_spy_videos v ON v.id = a.video_id
        WHERE a.run_id = (SELECT id FROM latest_run)
          AND a.cluster_id IN (SELECT cluster_id FROM due)
          AND v.url IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM niche_discovery_seeds s2
                 WHERE s2.seed_video_id = v.id AND s2.status <> 'failed')
        ORDER BY a.cluster_id, v.view_count DESC NULLS LAST
     )
     SELECT p.cluster_id, p.video_id, p.url, p.title, d.hours_since, d.watchers
       FROM pick p JOIN due d ON d.cluster_id = p.cluster_id
      ORDER BY d.hours_since DESC NULLS FIRST
      LIMIT $1`,
    [limit, String(cadenceHours)],
  );
  return res.rows.map(r => ({
    cluster_id: Number(r.cluster_id),
    video_id: Number(r.video_id),
    url: r.url,
    title: r.title,
    hours_since_last: r.hours_since == null ? null : parseFloat(r.hours_since),
    watchers: parseInt(r.watchers),
  }));
}

/** Stamp a cluster as discovery-crawled so the cadence gate holds it back. */
export async function markDiscoverCrawled(clusterId: number): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO niche_watch_state (cluster_id, last_discover_at)
     VALUES ($1, NOW())
     ON CONFLICT (cluster_id) DO UPDATE SET last_discover_at = NOW()`,
    [clusterId],
  ).catch(() => {});
}
