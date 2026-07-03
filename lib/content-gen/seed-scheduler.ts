/**
 * Auto-seed scheduler — Loop 2 of the niche-discovery flywheel.
 *
 * Each tick: pull novelty seed candidates, drop the ones we've already
 * seeded (permanent video-level ledger exclusion) and the ones whose
 * embedding region is currently being crawled (cluster-level lock), group
 * the survivors into niches by their cluster, and dispatch up to the
 * fleet budget. The reaper detects finished crawls, runs a SCOPED novelty
 * re-score over the crawled region (so a now-dense seed's novelty decays
 * honestly), and releases the region lock.
 *
 * Dedup model (per the design):
 *   - VIDEO level: a video in the ledger with status in
 *     (pending|crawling|done) is never re-seeded. Only 'failed' is re-eligible.
 *   - REGION level: while a cluster is being crawled (agent_niches.status
 *     ='crawling' for that origin_cluster_id), no new seeds dispatch into
 *     it. The post-crawl scoped re-score releases the lock; decayed videos
 *     then fall below the novelty cutoff on their own.
 *
 * All knobs come from admin_config (ships OFF: auto_seed_enabled=false).
 * See docs/content-gen/novelty-audit.md + agents-video-seed-audit.md.
 */

import { getPool } from '../db';
import { findSeedCandidates, type SeedCandidate } from './seed-candidates';
import { buildFleetSnapshot, deployBatch } from '../agent-deploy';
import { fetchRunningTasks, fetchPlannedTasks } from '../xgodo-tasks';
import { createNiche, addSeedUrlToNiche, deriveLabel } from '../agent-niche';
import { recomputeAllNovelty } from '../vector-db';
import { getUnspiedContentGenSeeds, type ContentGenSeed } from './content-gen-seeds';

const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';
// Arbitrary fixed advisory-lock key so overlapping ticks serialize.
const SCHEDULER_LOCK_KEY = 0x5eed_5c4d;
const REAPER_LOCK_KEY = 0x5eed_4eaf;

interface SchedulerConfig {
  enabled: boolean;
  minNoveltyPct: number;
  maxThreads: number;
  threadsPerSeed: number;
  maxSeedsPerTick: number;
  loopNumber: number;
  apiKey: string;
  rofeAPIKey: string;
  maxSuggested: number;
  token: string;
  englishOnly: boolean;
}

async function loadConfig(): Promise<SchedulerConfig> {
  const pool = await getPool();
  const res = await pool.query('SELECT key, value FROM admin_config');
  const c: Record<string, string> = {};
  for (const r of res.rows) c[r.key] = r.value;
  return {
    enabled:        c.auto_seed_enabled === 'true',
    minNoveltyPct:  parseFloat(c.auto_seed_min_novelty_pct) || 80,
    maxThreads:     parseInt(c.auto_seed_max_threads) || 10,
    threadsPerSeed: parseInt(c.auto_seed_threads_per_seed) || 1,
    maxSeedsPerTick: parseInt(c.auto_seed_max_seeds_per_tick) || 5,
    loopNumber:     parseInt(c.auto_seed_loop_number) || 14,
    apiKey:         c.agent_api_key || '',
    rofeAPIKey:     c.agent_rofe_api_key || '',
    maxSuggested:   parseInt(c.agent_max_suggested_results) || 50,
    token:          c.xgodo_niche_spy_token || c.xgodo_api_token || process.env.XGODO_NICHE_SPY_TOKEN || process.env.XGODO_API_TOKEN || '',
    // Default ON — filter seeds to English/Latin-script titles. Off only if the
    // operator explicitly sets seed_english_only='false'.
    englishOnly:    c.seed_english_only !== 'false',
  };
}

/** Try to grab an advisory lock; returns false if another tick holds it. */
async function tryLock(key: number): Promise<boolean> {
  const pool = await getPool();
  const r = await pool.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
  return r.rows[0]?.locked === true;
}
async function unlock(key: number): Promise<void> {
  const pool = await getPool();
  await pool.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
}

/**
 * Look up each candidate's effective cluster (L2 latest subdivide
 * preferred, else L1 latest global). Returns Map<video_id, cluster_id|null>.
 * The cluster is the natural proximity grouping — videos in one cluster
 * are the "same neighbourhood", so we seed at most one niche per cluster
 * per crawl wave.
 */
async function effectiveClusters(videoIds: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  for (const id of videoIds) out.set(id, null);
  if (videoIds.length === 0) return out;
  const pool = await getPool();
  const res = await pool.query<{ video_id: number; cluster_id: number; level: number }>(
    `WITH latest_global AS (
       SELECT id FROM niche_tree_runs
       WHERE kind='global' AND status='done'
       ORDER BY started_at DESC NULLS LAST LIMIT 1
     ),
     latest_subdivide AS (
       SELECT DISTINCT ON (parent_cluster_id) id
       FROM niche_tree_runs
       WHERE kind='subdivide' AND status='done'
       ORDER BY parent_cluster_id, started_at DESC NULLS LAST
     )
     SELECT DISTINCT ON (a.video_id, c.level)
       a.video_id, a.cluster_id, c.level
     FROM niche_tree_assignments a
     JOIN niche_tree_clusters c ON c.id = a.cluster_id
     WHERE a.video_id = ANY($1::int[]) AND a.cluster_id IS NOT NULL
       AND (
         (c.level = 1 AND a.run_id = (SELECT id FROM latest_global))
         OR (c.level = 2 AND a.run_id IN (SELECT id FROM latest_subdivide))
       )
     ORDER BY a.video_id, c.level DESC`,  // level DESC → L2 wins over L1
    [videoIds],
  );
  // First row per video_id is its L2 (level 2 sorts first); fall back keeps L1.
  const seen = new Set<number>();
  for (const r of res.rows) {
    const vid = Number(r.video_id);
    if (seen.has(vid)) continue;       // already took the higher level
    out.set(vid, Number(r.cluster_id));
    seen.add(vid);
  }
  return out;
}

export interface SchedulerTickResult {
  ran: boolean;
  reason?: string;
  candidates_considered: number;
  after_video_dedup: number;
  after_region_lock: number;
  niches_dispatched: number;
  seeds_dispatched: number;
  threads_dispatched: number;
  min_novelty_pct_used: number;
  starvation_adjustment?: string;
  source?: 'content_gen' | 'novelty';
}

/**
 * Dispatch Content-Gen priority seeds (one niche per channel, seeded from its
 * top video). Simpler than the novelty path — no cluster grouping or region
 * locks, just fill the free budget with un-spied channels, tagging the ledger
 * rows source='content_gen' so the GUI can show per-group spy completion.
 */
async function dispatchContentGenSeeds(
  cgSeeds: ContentGenSeed[],
  freeThreads: number,
  cfg: SchedulerConfig,
): Promise<SchedulerTickResult> {
  const pool = await getPool();
  const snapshot = await buildFleetSnapshot(cfg.token, NICHE_SPY_JOB_ID);
  const threadsPerSeed = Math.max(1, cfg.threadsPerSeed);
  let threadsLeft = freeThreads;
  let nichesDispatched = 0, seedsDispatched = 0, threadsDispatched = 0;

  for (const s of cgSeeds) {
    if (threadsLeft < threadsPerSeed) break;
    const label = s.channel_name || deriveLabel({ title: s.top_video_title, seedUrl: s.top_video_url });
    const nicheId = await createNiche({ label, seedUrl: s.top_video_url, createdFrom: 'content_gen' });
    await pool.query(`UPDATE agent_niches SET status='crawling', last_seeded_at=NOW() WHERE niche_id=$1`, [nicheId]).catch(() => {});

    const taskInput = JSON.stringify({
      seedUrl: s.top_video_url,
      apiKey: cfg.apiKey,
      loopNumber: cfg.loopNumber,
      maxSuggestedResultsBeforeFallback: cfg.maxSuggested,
      rofeAPIKey: cfg.rofeAPIKey,
      nicheId,
    });
    const dep = await deployBatch(
      cfg.token, NICHE_SPY_JOB_ID,
      { keyword: nicheId, threads: threadsPerSeed, taskInput },
      snapshot,
    );
    const deployed = dep.pinned + dep.unpinned;
    if (deployed > 0) {
      await pool.query(
        `INSERT INTO niche_discovery_seeds
           (seed_video_id, seed_url, niche_id, origin_cluster_id, status, source, channel_id)
         VALUES ($1, $2, $3, NULL, 'crawling', 'content_gen', $4)
         ON CONFLICT (seed_video_id) DO UPDATE
           SET status='crawling', niche_id=EXCLUDED.niche_id, source='content_gen',
               channel_id=EXCLUDED.channel_id, dispatched_at=NOW()`,
        [s.top_video_id, s.top_video_url, nicheId, s.channel_id],
      ).catch((e) => console.error('[scheduler] cg ledger write failed:', (e as Error).message));
      await addSeedUrlToNiche(nicheId, s.top_video_url).catch(() => {});
      nichesDispatched++; seedsDispatched++; threadsDispatched += deployed; threadsLeft -= deployed;
    } else {
      await pool.query(`UPDATE agent_niches SET status='active' WHERE niche_id=$1`, [nicheId]).catch(() => {});
    }
  }

  return {
    ran: true,
    reason: 'content_gen_priority',
    candidates_considered: cgSeeds.length,
    after_video_dedup: cgSeeds.length,
    after_region_lock: cgSeeds.length,
    niches_dispatched: nichesDispatched,
    seeds_dispatched: seedsDispatched,
    threads_dispatched: threadsDispatched,
    min_novelty_pct_used: 0,
    source: 'content_gen',
  };
}

/**
 * One auto-seed scheduler tick. Safe to call frequently — gated by the
 * enabled flag, the advisory lock, and the fleet budget.
 */
export async function runSeedSchedulerTick(): Promise<SchedulerTickResult> {
  const empty: SchedulerTickResult = {
    ran: false, candidates_considered: 0, after_video_dedup: 0,
    after_region_lock: 0, niches_dispatched: 0, seeds_dispatched: 0,
    threads_dispatched: 0, min_novelty_pct_used: 0,
  };

  const cfg = await loadConfig();
  if (!cfg.enabled) return { ...empty, reason: 'disabled' };
  if (!cfg.token)   return { ...empty, reason: 'no_xgodo_token' };

  if (!(await tryLock(SCHEDULER_LOCK_KEY))) return { ...empty, reason: 'locked' };
  try {
    const pool = await getPool();

    // ── 1. Budget: how many seed threads are already in flight? ─────────
    const [running, planned] = await Promise.all([
      fetchRunningTasks(cfg.token, NICHE_SPY_JOB_ID),
      fetchPlannedTasks(cfg.token, NICHE_SPY_JOB_ID),
    ]);
    const seedInFlight = [...running, ...planned].filter(t => t.kind === 'seed').length;
    const freeThreads = Math.max(0, cfg.maxThreads - seedInFlight);

    // ── PRIORITY: Content-Gen seeds (exclusive) ─────────────────────────
    // Channels shown in the Content Gen draft cards get researched first.
    // While any of their top videos are un-spied, the scheduler dispatches
    // ONLY those (no novelty seeding) until they're all crawled.
    const cgSeeds = await getUnspiedContentGenSeeds().catch((e) => {
      console.error('[scheduler] content-gen seed pull failed:', (e as Error).message);
      return [] as Awaited<ReturnType<typeof getUnspiedContentGenSeeds>>;
    });
    if (cgSeeds.length > 0) {
      if (freeThreads <= 0) {
        return { ...empty, ran: true, reason: 'content_gen_pending_fleet_full', min_novelty_pct_used: cfg.minNoveltyPct };
      }
      return await dispatchContentGenSeeds(cgSeeds, freeThreads, cfg);
    }

    if (freeThreads <= 0) return { ...empty, ran: true, reason: 'fleet_full', min_novelty_pct_used: cfg.minNoveltyPct };

    // ── 2. Candidate pull (+ starvation auto-lower) ─────────────────────
    // excludeSeeded:true is CRITICAL — without it the top-K saturates with
    // already-crawled videos and the loop starves even with 100K+ fresh
    // candidates below them.
    let pct = cfg.minNoveltyPct;
    let candidates = await findSeedCandidates({ topK: 60, minNoveltyPct: pct, excludeSeeded: true, englishOnly: cfg.englishOnly });
    let starvationNote: string | undefined;

    // Already-seeded video_ids (permanent unless failed).
    const ledgerRes = await pool.query<{ seed_video_id: number }>(
      `SELECT seed_video_id FROM niche_discovery_seeds WHERE status <> 'failed'`,
    );
    const seededVideos = new Set(ledgerRes.rows.map(r => Number(r.seed_video_id)));

    // Clusters currently crawling (region lock).
    const lockedRes = await pool.query<{ origin_cluster_id: number }>(
      `SELECT DISTINCT origin_cluster_id FROM agent_niches
        WHERE status = 'crawling' AND origin_cluster_id IS NOT NULL`,
    );
    const lockedClusters = new Set(lockedRes.rows.map(r => Number(r.origin_cluster_id)));

    let afterVideoDedup = candidates.filter(c => !seededVideos.has(c.video_id));

    // Starvation: if dedup leaves <5, step the novelty floor down (min 50)
    // and re-pull once. Persist the lowered floor so it sticks.
    if (afterVideoDedup.length < 5 && pct > 50) {
      const newPct = Math.max(50, pct - 5);
      starvationNote = `pool<5 at pct=${pct}; lowered to ${newPct}`;
      pct = newPct;
      await pool.query(
        `UPDATE admin_config SET value = $1 WHERE key = 'auto_seed_min_novelty_pct'`,
        [String(pct)],
      ).catch(() => {});
      candidates = await findSeedCandidates({ topK: 60, minNoveltyPct: pct, excludeSeeded: true, englishOnly: cfg.englishOnly });
      afterVideoDedup = candidates.filter(c => !seededVideos.has(c.video_id));
    }

    // ── 3. Region lock + cluster grouping ───────────────────────────────
    const clusterMap = await effectiveClusters(afterVideoDedup.map(c => c.video_id));
    const afterRegion = afterVideoDedup.filter(c => {
      const cl = clusterMap.get(c.video_id);
      return cl == null || !lockedClusters.has(cl);
    });

    // Group survivors by effective cluster. Orphans (cluster null) each
    // become their own singleton niche.
    type Group = { clusterId: number | null; seeds: SeedCandidate[] };
    const byCluster = new Map<string, Group>();
    let orphanIdx = 0;
    for (const c of afterRegion.sort((a, b) => b.seed_score - a.seed_score)) {
      const cl = clusterMap.get(c.video_id) ?? null;
      const key = cl != null ? `c${cl}` : `o${orphanIdx++}`;
      if (!byCluster.has(key)) byCluster.set(key, { clusterId: cl, seeds: [] });
      byCluster.get(key)!.seeds.push(c);
    }
    // Order groups by their best seed's score; cap to maxSeedsPerTick.
    const groups = [...byCluster.values()]
      .sort((a, b) => b.seeds[0].seed_score - a.seeds[0].seed_score);

    // ── 4. Dispatch within budget ───────────────────────────────────────
    const snapshot = await buildFleetSnapshot(cfg.token, NICHE_SPY_JOB_ID);
    let threadsLeft = freeThreads;
    let seedsLeft = cfg.maxSeedsPerTick;
    let nichesDispatched = 0, seedsDispatched = 0, threadsDispatched = 0;

    for (const g of groups) {
      if (threadsLeft < cfg.threadsPerSeed || seedsLeft <= 0) break;
      // One seed per cluster per wave (the cluster IS the neighbourhood);
      // take the top-scoring candidate as the entry point.
      const seed = g.seeds[0];

      // Mint a niche for this group. (v1: one niche per cluster per wave;
      // reuse-existing-cluster-niche is a later refinement.)
      const label = deriveLabel({ title: seed.video_title, seedUrl: seed.video_url });
      const nicheId = await createNiche({ label, seedUrl: seed.video_url, createdFrom: 'auto_seed' });
      if (g.clusterId != null) {
        await pool.query(
          `UPDATE agent_niches SET origin_cluster_id = $1, status = 'crawling', last_seeded_at = NOW() WHERE niche_id = $2`,
          [g.clusterId, nicheId],
        ).catch(() => {});
      } else {
        await pool.query(
          `UPDATE agent_niches SET status = 'crawling', last_seeded_at = NOW() WHERE niche_id = $1`,
          [nicheId],
        ).catch(() => {});
      }

      const taskInput = JSON.stringify({
        seedUrl: seed.video_url,
        apiKey: cfg.apiKey,
        loopNumber: cfg.loopNumber,
        maxSuggestedResultsBeforeFallback: cfg.maxSuggested,
        rofeAPIKey: cfg.rofeAPIKey,
        nicheId,
      });

      const dep = await deployBatch(
        cfg.token, NICHE_SPY_JOB_ID,
        { keyword: nicheId, threads: cfg.threadsPerSeed, taskInput },
        snapshot,
      );
      const deployed = dep.pinned + dep.unpinned;
      if (deployed > 0) {
        await pool.query(
          `INSERT INTO niche_discovery_seeds
             (seed_video_id, seed_url, niche_id, origin_cluster_id, status, novelty_at_dispatch)
           VALUES ($1, $2, $3, $4, 'crawling', $5)
           ON CONFLICT (seed_video_id) DO UPDATE
             SET status = 'crawling', niche_id = EXCLUDED.niche_id,
                 dispatched_at = NOW(), origin_cluster_id = EXCLUDED.origin_cluster_id`,
          [seed.video_id, seed.video_url, nicheId, g.clusterId, seed.novelty_score],
        ).catch(() => {});
        await addSeedUrlToNiche(nicheId, seed.video_url).catch(() => {});
        nichesDispatched++;
        seedsDispatched++;
        threadsDispatched += deployed;
        threadsLeft -= deployed;
        seedsLeft--;
      } else {
        // Dispatch failed → release the niche lock so the cluster isn't
        // stuck locked with no live crawl.
        await pool.query(`UPDATE agent_niches SET status = 'active' WHERE niche_id = $1`, [nicheId]).catch(() => {});
      }
    }

    return {
      ran: true,
      candidates_considered: candidates.length,
      after_video_dedup: afterVideoDedup.length,
      after_region_lock: afterRegion.length,
      niches_dispatched: nichesDispatched,
      seeds_dispatched: seedsDispatched,
      threads_dispatched: threadsDispatched,
      min_novelty_pct_used: pct,
      starvation_adjustment: starvationNote,
    };
  } finally {
    await unlock(SCHEDULER_LOCK_KEY);
  }
}

export interface ReaperResult {
  ran: boolean;
  reason?: string;
  finished_niches: number;
  videos_rescored: number;
  clusters_released: number;
}

/**
 * Detect seed crawls that have finished (no live xgodo task for the
 * niche), backfill discovered_count, run a SCOPED novelty re-score over
 * the crawled region, then release the region lock. This is what makes
 * decay actually happen and what frees a cluster for future seeding.
 */
export async function runSeedReaperTick(): Promise<ReaperResult> {
  const empty: ReaperResult = { ran: false, finished_niches: 0, videos_rescored: 0, clusters_released: 0 };
  const cfg = await loadConfig();
  // The reaper runs whenever auto-recompute OR auto-seed is on (it serves
  // both: it's the post-crawl re-score). Skip only if both are off.
  if (!cfg.enabled && !(await isRecomputeEnabled())) return { ...empty, reason: 'disabled' };
  if (!cfg.token) return { ...empty, reason: 'no_xgodo_token' };

  if (!(await tryLock(REAPER_LOCK_KEY))) return { ...empty, reason: 'locked' };
  try {
    const pool = await getPool();

    // Niches still marked crawling whose nicheId has NO running/planned task.
    const [running, planned] = await Promise.all([
      fetchRunningTasks(cfg.token, NICHE_SPY_JOB_ID),
      fetchPlannedTasks(cfg.token, NICHE_SPY_JOB_ID),
    ]);
    const liveNicheIds = new Set(
      [...running, ...planned].filter(t => t.kind === 'seed').map(t => t.keyword),
    );

    // Revert an on-demand burst's thread-budget bump once its tasks finish.
    // Done here (not gated on finished crawls) so it runs every reaper tick.
    await maybeRevertBurst(liveNicheIds).catch(() => {});

    const crawlingRes = await pool.query<{ niche_id: string; origin_cluster_id: number | null }>(
      `SELECT niche_id, origin_cluster_id FROM agent_niches WHERE status = 'crawling'`,
    );
    const finished = crawlingRes.rows.filter(r => !liveNicheIds.has(r.niche_id));

    // Self-heal discovered_count for recently-completed niches. Counted from
    // niche_seed_expansions — the COMPLETE record of every candidate the bot
    // POSTed for scoring during the crawl. (agent_task_proof, the old source, is
    // only a 30s thermostat sample of the live crawl, so it under-counted badly
    // when a task finished between samples — e.g. showed +1 for a crawl that
    // actually submitted 82.) Scoped to recently-completed niches, only ever
    // raises, runs every tick so the count converges to truth.
    await pool.query(
      `UPDATE niche_discovery_seeds s SET discovered_count = sub.disc
         FROM (
           SELECT atl.keyword AS niche_id, COUNT(DISTINCT nse.candidate_url) AS disc
             FROM niche_seed_expansions nse
             JOIN agent_task_log atl ON atl.task_id = nse.task_id
            WHERE atl.keyword IN (
              SELECT niche_id FROM niche_discovery_seeds WHERE completed_at > NOW() - INTERVAL '3 hours'
            )
            GROUP BY atl.keyword
         ) sub
        WHERE s.niche_id = sub.niche_id AND s.discovered_count < sub.disc`,
    ).catch((e) => console.error('[seed-reaper] discovered_count self-heal failed:', (e as Error).message));

    if (finished.length === 0) return { ...empty, ran: true };

    let videosRescored = 0;
    let clustersReleased = 0;

    for (const n of finished) {
      // Accurate discovered count: distinct candidates this niche's crawls
      // submitted for scoring — counted from niche_seed_expansions (the complete
      // record), attributed via agent_task_log (task_id → nicheId). Not from
      // agent_task_proof, which is only a sparse 30s sample of the live crawl and
      // under-counts when a task finishes between samples (mislabeling productive
      // niches as 'exhausted' on the <3 check below).
      const discRes = await pool.query<{ disc: string }>(
        `SELECT COUNT(DISTINCT nse.candidate_url) AS disc
           FROM niche_seed_expansions nse
           JOIN agent_task_log atl ON atl.task_id = nse.task_id
          WHERE atl.keyword = $1`,
        [n.niche_id],
      );
      const discoveredCount = parseInt(discRes.rows[0]?.disc) || 0;

      // Scoped decay re-score from the seed + its K-neighbours (which now
      // include the freshly-crawled videos in this region, so the now-dense
      // neighbourhood decays honestly).
      const seedIdsRes = await pool.query<{ seed_video_id: number }>(
        `SELECT seed_video_id FROM niche_discovery_seeds WHERE niche_id = $1`,
        [n.niche_id],
      );
      const seedIds = seedIdsRes.rows.map(r => Number(r.seed_video_id));
      if (seedIds.length > 0) {
        const r = await recomputeAllNovelty({ videoIds: seedIds, includeNeighbors: true, threads: 8 });
        videosRescored += r.scored;
      }

      // Backfill discovered_count + release the niche. A crawl that surfaced
      // ZERO candidates almost always FAILED to run (a healthy 14-hop crawl finds
      // dozens) — re-queue the seed for another attempt instead of retiring it:
      // mark 'failed', which excludeSeeded treats as re-eligible, so the scheduler
      // re-picks it. Capped at ZERO_SCORE_MAX_ATTEMPTS total crawls per seed_video
      // (count of its rows) so a genuinely-dead/inaccessible video can't loop.
      const ZERO_SCORE_MAX_ATTEMPTS = 3;
      let seedStatus = 'done';
      if (discoveredCount === 0 && seedIds.length > 0) {
        const att = await pool.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM niche_discovery_seeds WHERE seed_video_id = $1`,
          [seedIds[0]],
        );
        if ((parseInt(att.rows[0]?.n) || 1) < ZERO_SCORE_MAX_ATTEMPTS) seedStatus = 'failed';
      }
      await pool.query(
        `UPDATE niche_discovery_seeds
            SET status = $2, completed_at = NOW(), rescored_at = NOW(),
                discovered_count = $3
          WHERE niche_id = $1`,
        [n.niche_id, seedStatus, discoveredCount],
      ).catch(() => {});
      // Exhausted only if the crawl genuinely surfaced almost nothing.
      const newStatus = discoveredCount < 3 ? 'exhausted' : 'active';
      await pool.query(
        `UPDATE agent_niches SET status = $2 WHERE niche_id = $1`,
        [n.niche_id, newStatus],
      ).catch(() => {});
      clustersReleased++;
    }

    return { ran: true, finished_niches: finished.length, videos_rescored: videosRescored, clusters_released: clustersReleased };
  } finally {
    await unlock(REAPER_LOCK_KEY);
  }
}

async function isRecomputeEnabled(): Promise<boolean> {
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'novelty_auto_recompute_enabled'`,
  );
  return r.rows[0]?.value === 'true';
}

// ── On-demand burst budget bump + auto-revert ───────────────────────────────
// A burst (POST /api/admin/agents/burst with additive:true) raises
// auto_seed_max_threads by its thread count so the extra seed crawls run ON TOP
// of the auto loop. State lives in admin_config; this reverts the bump once the
// burst's niches have no live task, or the TTL backstop fires.

export interface BurstState {
  active: boolean;
  revertTo: number;        // the pre-burst auto_seed_max_threads
  niches: string[];        // burst nicheIds to watch for completion
  expiresAt: number | null; // epoch ms TTL backstop
}

export async function getBurstState(): Promise<BurstState> {
  const pool = await getPool();
  const r = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config WHERE key = ANY($1::text[])`,
    [['auto_seed_burst_active', 'auto_seed_burst_revert_to', 'auto_seed_burst_niches', 'auto_seed_burst_expires_at']],
  );
  const c: Record<string, string> = {};
  for (const row of r.rows) c[row.key] = row.value;
  let niches: string[] = [];
  try { niches = JSON.parse(c.auto_seed_burst_niches || '[]'); } catch { niches = []; }
  return {
    active: c.auto_seed_burst_active === 'true',
    revertTo: parseInt(c.auto_seed_burst_revert_to) || 10,
    niches,
    expiresAt: c.auto_seed_burst_expires_at ? parseInt(c.auto_seed_burst_expires_at) : null,
  };
}

/**
 * Revert the burst budget bump if every burst niche has finished (no live
 * seed task) or the TTL backstop has passed. Idempotent + safe to call often.
 * Pass the reaper's already-computed live nicheIds to avoid a duplicate fetch.
 */
export async function maybeRevertBurst(
  liveNicheIds?: Set<string>,
): Promise<{ reverted: boolean; reason?: string; maxThreadsNow?: number }> {
  const state = await getBurstState();
  if (!state.active) return { reverted: false };

  let live = liveNicheIds;
  if (!live) {
    const cfg = await loadConfig();
    if (!cfg.token) return { reverted: false, reason: 'no_token' };
    const [running, planned] = await Promise.all([
      fetchRunningTasks(cfg.token, NICHE_SPY_JOB_ID),
      fetchPlannedTasks(cfg.token, NICHE_SPY_JOB_ID),
    ]);
    live = new Set([...running, ...planned].filter(t => t.kind === 'seed').map(t => t.keyword));
  }

  const anyLive = state.niches.some(n => live!.has(n));
  const expired = state.expiresAt != null && Date.now() > state.expiresAt;
  if (anyLive && !expired) return { reverted: false };

  const pool = await getPool();
  const set = async (k: string, v: string) =>
    pool.query(`INSERT INTO admin_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [k, v]);
  // Only lower the budget back; never clobber a higher value an operator set
  // manually in the meantime.
  const curRes = await pool.query<{ value: string }>(`SELECT value FROM admin_config WHERE key='auto_seed_max_threads'`);
  const cur = parseInt(curRes.rows[0]?.value || '10') || 10;
  if (cur > state.revertTo) await set('auto_seed_max_threads', String(state.revertTo));
  await set('auto_seed_burst_active', 'false');
  await set('auto_seed_burst_niches', '[]');
  return { reverted: true, reason: expired ? 'ttl' : 'tasks_done', maxThreadsNow: state.revertTo };
}
