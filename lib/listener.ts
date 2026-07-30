/**
 * LISTENER — watch new uploads from every channel inside a semantically-chosen
 * niche bucket (e.g. "faceless youtube").
 *
 * This is NOT channel discovery. The channels are already known; the listener
 * monitors what a niche PRODUCES over time. It sits alongside, and deliberately
 * does not duplicate:
 *   spy loops (novelty/respy)  — find NEW channels via expensive agent crawls
 *   Growth Watcher             — tracks growth of small (<100-sub) channels
 *   listener (this)            — cheap API polling of uploads in a chosen niche
 *
 * The bucket is defined by MEANING, not by keywords or a hand-picked cluster
 * list: the query is embedded and kNN'd against `niche_tree_cluster_vectors`
 * (reusing searchNichesByText, which also caches the query embedding), then
 * every channel with a video in those clusters is enrolled.
 *
 * Membership is MATERIALISED rather than recomputed per poll. Clusters are
 * rebuilt ~weekly, and a listener silently changing who it listens to under the
 * operator would make its output impossible to interpret. `refreshListenerMembers`
 * re-runs enrolment deliberately.
 *
 * Polling reuses `pullRecentUploadsForChannel` — the same primitive the enricher
 * and Growth Watcher use, so uploads land in `niche_spy_videos` exactly as they
 * do everywhere else and stay compatible with the embedding/clustering pipeline.
 */
import { getPool } from './db';
import { searchNichesByText } from './niche-search';
import { pullRecentUploadsForChannel } from './channel-remeasure';
import { getYtPairForThread, banYtKey } from './yt-keys';

export interface Listener {
  id: number;
  name: string;
  query: string;
  cluster_ids: number[];
  enabled: boolean;
  channels_enrolled: number;
  videos_found: number;
  last_polled_at: string | null;
}

/**
 * Create a listener from a free-text niche query. Resolves the query to clusters
 * semantically, then enrols every channel appearing in them.
 */
export async function createListener(opts: {
  name: string;
  query: string;
  maxClusters?: number;
  minSimilarity?: number;
  level?: number;
}): Promise<{ listener_id: number; clusters: number; channels: number; matched: Array<{ clusterId: number; similarity: number }> }> {
  const pool = await getPool();
  const minSimilarity = opts.minSimilarity ?? 0.35;
  const search = await searchNichesByText({
    query: opts.query,
    limit: opts.maxClusters ?? 25,
    minSimilarity,
    level: opts.level,
  });
  const clusterIds = search.results.map(r => r.clusterId);
  if (clusterIds.length === 0) {
    throw new Error(`no niches matched "${opts.query}" at similarity >= ${minSimilarity}`);
  }

  const ins = await pool.query<{ id: number }>(
    `INSERT INTO listeners (name, query, cluster_ids, min_similarity) VALUES ($1,$2,$3,$4) RETURNING id`,
    [opts.name, opts.query, clusterIds, minSimilarity],
  );
  const listenerId = ins.rows[0].id;
  const channels = await refreshListenerMembers(listenerId);
  return {
    listener_id: listenerId,
    clusters: clusterIds.length,
    channels,
    matched: search.results.map(r => ({ clusterId: r.clusterId, similarity: r.similarity })),
  };
}

/**
 * (Re)enrol members: every channel with a video assigned to one of the
 * listener's clusters in the CURRENT tree run. Safe to re-run after a
 * re-cluster; existing rows keep their polling history.
 */
export async function refreshListenerMembers(listenerId: number): Promise<number> {
  const pool = await getPool();
  const l = await pool.query<{ cluster_ids: number[] }>(`SELECT cluster_ids FROM listeners WHERE id = $1`, [listenerId]);
  const clusterIds = l.rows[0]?.cluster_ids ?? [];
  if (clusterIds.length === 0) return 0;

  const res = await pool.query(
    `WITH latest_run AS (
       SELECT id FROM niche_tree_runs WHERE kind='global' AND status='done'
        ORDER BY started_at DESC NULLS LAST LIMIT 1
     )
     INSERT INTO listener_channels (listener_id, channel_id)
     SELECT DISTINCT $1::int, v.channel_id
       FROM niche_tree_assignments a
       JOIN niche_spy_videos v ON v.id = a.video_id
       JOIN niche_spy_channels c ON c.channel_id = v.channel_id
      WHERE a.run_id = (SELECT id FROM latest_run)
        AND a.cluster_id = ANY($2::int[])
        AND v.channel_id IS NOT NULL
        AND c.uploads_playlist_id IS NOT NULL   -- must be fetchable
     ON CONFLICT (listener_id, channel_id) DO NOTHING`,
    [listenerId, clusterIds],
  );
  const total = await pool.query<{ n: string }>(
    `SELECT COUNT(*) n FROM listener_channels WHERE listener_id = $1`, [listenerId],
  );
  const n = parseInt(total.rows[0]?.n ?? '0');
  await pool.query(`UPDATE listeners SET channels_enrolled = $2 WHERE id = $1`, [listenerId, n]).catch(() => {});
  void res;
  return n;
}


/**
 * Assign listener-discovered videos to clusters BY COMPUTING the assignment from
 * each video's own embedding — never by inheriting its channel's cluster. A channel
 * spanning three niches must be able to produce three differently-clustered videos;
 * blind channel-level inheritance would destroy exactly the per-video resolution the
 * clustering handoff (§4) asks us to preserve.
 *
 * Why this lives here: the clustering engine's incremental-assign loop is written but
 * NOT deployed (handoff §1.5), so without this, uploads the listener pulls would sit
 * in niche_spy_videos unclustered forever. Embedding itself is already handled — the
 * embed backfill picks up any unembedded video freshest-first.
 *
 * Method: nearest L1 cluster of the CURRENT tree run by cosine distance against
 * niche_tree_cluster_vectors. Cheap enough to run continuously (a few thousand
 * candidate clusters, small batches) and it writes distance_to_centroid so a weak
 * assignment is visible rather than silently trusted.
 */
async function assignListenerVideosToClusters(batch = 40): Promise<{ assigned: number; pending: number }> {
  const pool = await getPool();
  const { vectorPool } = await import('./vector-db');

  const runRes = await pool.query<{ id: number }>(
    `SELECT id FROM niche_tree_runs WHERE kind='global' AND status='done'
      ORDER BY started_at DESC NULLS LAST LIMIT 1`,
  );
  const runId = runRes.rows[0]?.id;
  if (!runId) return { assigned: 0, pending: 0 };

  // Candidate clusters + their index, once per tick (not per video).
  const cl = await pool.query<{ id: number; cluster_index: number }>(
    `SELECT id, cluster_index FROM niche_tree_clusters WHERE run_id = $1 AND level = 1`,
    [runId],
  );
  if (cl.rows.length === 0) return { assigned: 0, pending: 0 };
  const clusterIds = cl.rows.map(r => r.id);
  const idxById = new Map(cl.rows.map(r => [r.id, r.cluster_index]));

  // Listener videos that are embedded but not yet placed in the current run.
  const todo = await pool.query<{ id: number }>(
    `SELECT DISTINCT v.id
       FROM listener_videos lv
       JOIN niche_spy_videos v ON v.id = lv.video_id
      WHERE v.combined_embedded_v2_at IS NOT NULL
        AND NOT EXISTS (
              SELECT 1 FROM niche_tree_assignments a
               WHERE a.video_id = v.id AND a.run_id = $1)
      ORDER BY v.id DESC
      LIMIT $2`,
    [runId, batch],
  );
  if (todo.rows.length === 0) return { assigned: 0, pending: 0 };

  let assigned = 0;
  for (const row of todo.rows) {
    const near = await vectorPool.query<{ cluster_id: number; dist: number }>(
      `SELECT c.cluster_id, (c.embedding <=> v.embedding) AS dist
         FROM niche_tree_cluster_vectors c
         CROSS JOIN (SELECT embedding FROM niche_video_vectors_combined_v2 WHERE video_id = $1) v
        WHERE c.level = 1 AND c.cluster_id = ANY($2::int[])
        ORDER BY dist ASC LIMIT 1`,
      [row.id, clusterIds],
    ).catch(() => null);
    const hit = near?.rows[0];
    if (!hit) continue;
    await pool.query(
      `INSERT INTO niche_tree_assignments (run_id, video_id, cluster_id, cluster_index, distance_to_centroid)
       VALUES ($1,$2,$3,$4,$5)`,
      [runId, row.id, hit.cluster_id, idxById.get(hit.cluster_id) ?? 0, hit.dist],
    ).catch(() => {});
    assigned++;
  }

  const pend = await pool.query<{ n: string }>(
    `SELECT COUNT(*) n FROM listener_videos lv
       JOIN niche_spy_videos v ON v.id = lv.video_id
      WHERE v.combined_embedded_v2_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM niche_tree_assignments a WHERE a.video_id = v.id AND a.run_id = $1)`,
    [runId],
  );
  return { assigned, pending: parseInt(pend.rows[0]?.n ?? '0') };
}

export interface ListenerTickResult {
  polled: number;
  new_videos: number;
  listeners_active: number;
  errors: number;
  assigned: number;   // videos given a cluster this tick
  unassigned: number; // embedded-but-unclustered backlog
}

/**
 * One polling pass. Bounded per tick and oldest-checked-first, so a large
 * listener drains evenly instead of starving its tail.
 *
 * Yields to the enricher: uploads are pulled with the SAME shared YT key pool,
 * and the enricher is the KPI-critical consumer (it fills subscriber_count).
 * A listener is never worth degrading enrichment for, so the batch stays small
 * and rate-limit responses ban the key and stop the pass immediately.
 */
export async function runListenerTick(batch = 60): Promise<ListenerTickResult> {
  const pool = await getPool();
  const out: ListenerTickResult = { polled: 0, new_videos: 0, listeners_active: 0, errors: 0, assigned: 0, unassigned: 0 };

  const cfg = await pool.query<{ value: string }>(`SELECT value FROM admin_config WHERE key='listener_enabled'`);
  if (cfg.rows[0]?.value === 'false') return out;   // default ON once a listener exists

  const due = await pool.query<{ listener_id: number; channel_id: string; uploads_playlist_id: string }>(
    `SELECT lc.listener_id, lc.channel_id, c.uploads_playlist_id
       FROM listener_channels lc
       JOIN listeners l ON l.id = lc.listener_id AND l.enabled
       JOIN niche_spy_channels c ON c.channel_id = lc.channel_id
      WHERE c.uploads_playlist_id IS NOT NULL
        AND (lc.last_checked_at IS NULL
             OR lc.last_checked_at < NOW() - (l.poll_interval_hours || ' hours')::interval)
      ORDER BY lc.last_checked_at NULLS FIRST
      LIMIT $1`,
    [batch],
  );
  // Cluster whatever is embedded-and-unplaced, every tick — including ticks with
  // nothing due, so the backlog drains continuously rather than only on poll waves.
  const asg = await assignListenerVideosToClusters().catch(() => ({ assigned: 0, pending: 0 }));
  out.assigned = asg.assigned; out.unassigned = asg.pending;

  if (due.rows.length === 0) return out;

  const listeners = new Set<number>();
  for (let i = 0; i < due.rows.length; i++) {
    const row = due.rows[i];
    const pair = await getYtPairForThread(i);
    if (!pair) break;
    const pull = await pullRecentUploadsForChannel(pool, row.channel_id, row.uploads_playlist_id, pair, 10)
      .catch(() => ({ newVideoIds: [] as number[], videoCount: 0, error: 'pull_failed', rateLimited: false }));

    if (pull.error) {
      out.errors++;
      if (pull.rateLimited) { banYtKey(pair.key); break; }   // back off rather than burn the shared pool
      // STAMP ON FAILURE TOO. The error path used to `continue` without touching
      // last_checked_at, so a permanently-broken channel (stale/deleted uploads
      // playlist) stayed at the head of the due-queue and was retried EVERY tick —
      // observed as a constant errors=6-7 with polled=0, burning YT quota once a
      // minute forever. Same shape as the enricher's deterministic crash-loop.
      // Stamping backs it off to the normal cadence; consecutive failures are
      // tracked so a channel that never works can be pruned later.
      await pool.query(
        `UPDATE listener_channels
            SET last_checked_at = NOW(), fail_count = COALESCE(fail_count,0) + 1
          WHERE listener_id = $1 AND channel_id = $2`,
        [row.listener_id, row.channel_id],
      ).catch(() => {});
      continue;
    }
    out.polled++;
    listeners.add(row.listener_id);

    if (pull.newVideoIds.length > 0) {
      // Record each catch. yt_video_id is derived from the url so the unique
      // index dedupes across passes.
      for (const vid of pull.newVideoIds) {
        await pool.query(
          `INSERT INTO listener_videos (listener_id, channel_id, video_id, yt_video_id)
           SELECT $1::int, $2::text, v.id, regexp_replace(v.url, '^.*/', '')
             FROM niche_spy_videos v WHERE v.id = $3
           ON CONFLICT (listener_id, yt_video_id) DO NOTHING`,
          [row.listener_id, row.channel_id, vid],
        ).catch(() => {});
      }
      out.new_videos += pull.newVideoIds.length;
    }
    await pool.query(
      `UPDATE listener_channels
          SET last_checked_at = NOW(),
              last_video_count = $3,
              new_videos_seen = new_videos_seen + $4,
              fail_count = 0
        WHERE listener_id = $1 AND channel_id = $2`,
      [row.listener_id, row.channel_id, pull.videoCount, pull.newVideoIds.length],
    ).catch(() => {});
  }

  for (const id of listeners) {
    await pool.query(
      `UPDATE listeners SET last_polled_at = NOW(),
              videos_found = videos_found + $2 WHERE id = $1`,
      [id, out.new_videos],
    ).catch(() => {});
  }
  out.listeners_active = listeners.size;
  return out;
}

/** KPI: avg newly-discovered videos per channel, per listener. */
export async function getListenerStats(listenerId?: number) {
  const pool = await getPool();
  const r = await pool.query(
    `SELECT l.id, l.name, l.query, l.enabled,
            l.channels_enrolled,
            COUNT(DISTINCT lc.channel_id) FILTER (WHERE lc.last_checked_at IS NOT NULL) AS channels_polled,
            COALESCE(SUM(lc.new_videos_seen),0) AS total_new_videos,
            ROUND(COALESCE(SUM(lc.new_videos_seen),0)::numeric
                  / NULLIF(COUNT(DISTINCT lc.channel_id),0), 2) AS avg_new_videos_per_channel,
            (SELECT COUNT(*) FROM listener_videos lv
              WHERE lv.listener_id = l.id AND lv.detected_at > NOW()-INTERVAL '24 hours') AS videos_24h,
            l.last_polled_at
       FROM listeners l
       LEFT JOIN listener_channels lc ON lc.listener_id = l.id
      WHERE ($1::int IS NULL OR l.id = $1)
      GROUP BY l.id ORDER BY l.id DESC`,
    [listenerId ?? null],
  );
  return r.rows;
}
