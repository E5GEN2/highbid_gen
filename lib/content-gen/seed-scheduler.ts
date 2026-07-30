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
  // Embed kill-switch (the EXPAND flow ranks candidates by embedding them, so a
  // dead google_ai_studio pool makes every dispatched crawl unusable → pause).
  killOnDeadEmbeds: boolean;
  embedKillMinKeys: number;    // pause if fewer pickable embed keys than this
  embedKillWindowMin: number;  // fail-rate look-back window
  embedKillThreshold: number;  // pause if embed-fail fraction >= this over the window
  embedKillMinSample: number;  // ...only once the window has this many expansions
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
    killOnDeadEmbeds:   c.seed_kill_on_dead_embeds !== 'false',    // default ON
    embedKillMinKeys:   parseInt(c.seed_embed_kill_min_keys) || 1,
    embedKillWindowMin: parseInt(c.seed_embed_kill_window_min) || 30,
    embedKillThreshold: parseFloat(c.seed_embed_kill_threshold) || 0.9,
    embedKillMinSample: parseInt(c.seed_embed_kill_min_sample) || 25,
  };
}

/**
 * Kill-switch signal — is the embed pipeline effectively dead? The video-seed
 * EXPAND flow embeds every candidate to rank it against the seed; with no
 * working google_ai_studio keys those calls fail (no_active_ai_keys) and the
 * dispatched agent work is wasted. Two OR'd signals: a LEADING pool check (0
 * pickable keys → trip BEFORE wasting a dispatch wave) and an OUTCOME fail-rate
 * over a window (the operator's "90%+ failing" criterion) once there's sample.
 * Re-checked every tick, so dispatch AUTO-RESUMES the moment embeds recover.
 */
async function embedPipelineDead(cfg: SchedulerConfig): Promise<{ dead: boolean; reason: string }> {
  const pool = await getPool();
  const k = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM xgodo_api_keys
      WHERE service = 'google_ai_studio' AND status = 'active'
        AND (banned_until IS NULL OR banned_until < NOW())`,
  );
  const pickable = parseInt(k.rows[0]?.n ?? '0');
  if (pickable < cfg.embedKillMinKeys) return { dead: true, reason: `embed_pool_empty (${pickable} pickable keys)` };
  const r = await pool.query<{ total: string; embed_err: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE error_message ~* '(no_active_ai|ai_key|embed)') AS embed_err
       FROM niche_seed_expansions
      WHERE detected_at > NOW() - ($1 || ' minutes')::interval`,
    [String(cfg.embedKillWindowMin)],
  );
  const total = parseInt(r.rows[0]?.total ?? '0');
  const err = parseInt(r.rows[0]?.embed_err ?? '0');
  if (total >= cfg.embedKillMinSample && err / total >= cfg.embedKillThreshold) {
    return { dead: true, reason: `embed_fail ${Math.round((100 * err) / total)}% over ${cfg.embedKillWindowMin}m (${err}/${total})` };
  }
  return { dead: false, reason: '' };
}

/** Persist the kill-switch state to admin_config so the UI/operator can see
 *  WHY dispatch is paused (key: seed_embed_killswitch). Fire-and-forget. */
async function recordKillswitch(tripped: boolean, reason: string): Promise<void> {
  const pool = await getPool();
  const payload = JSON.stringify({ tripped, reason, at: new Date().toISOString() });
  await pool.query(
    `INSERT INTO admin_config (key, value) VALUES ('seed_embed_killswitch', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
    [payload],
  ).catch(() => {});
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
           (seed_video_id, seed_url, niche_id, origin_cluster_id, status, source, channel_id, select_policy)
         VALUES ($1, $2, $3, NULL, 'crawling', 'content_gen', $4, 'content_gen')
         ON CONFLICT (seed_video_id) DO UPDATE
           SET status='crawling', niche_id=EXCLUDED.niche_id, source='content_gen',
               channel_id=EXCLUDED.channel_id, dispatched_at=NOW(), select_policy='content_gen'`,
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
// Seed-selection A/B: 1-in-N ticks run the legacy 'v1_ln' ranking (control), the
// rest run 'v2_pow' (treatment, views-forward). Interleaving the arms tick-by-tick
// controls for time/quota confounds so the eligible-yield comparison is causal,
// not a before/after guess. Env-tunable (HB_SEED_HOLDOUT_EVERY=1 → all treatment).
const SEED_HOLDOUT_EVERY = Math.max(1, parseInt(process.env.HB_SEED_HOLDOUT_EVERY || '6', 10));
let seedSchedTick = 0;

export async function runSeedSchedulerTick(): Promise<SchedulerTickResult> {
  const empty: SchedulerTickResult = {
    ran: false, candidates_considered: 0, after_video_dedup: 0,
    after_region_lock: 0, niches_dispatched: 0, seeds_dispatched: 0,
    threads_dispatched: 0, min_novelty_pct_used: 0,
  };

  const cfg = await loadConfig();
  if (!cfg.enabled) return { ...empty, reason: 'disabled' };
  if (!cfg.token)   return { ...empty, reason: 'no_xgodo_token' };

  // EMBED KILL-SWITCH — the spy fleet only produces usable work when the expand
  // flow can embed candidates. If the embed pool is dead, dispatching more seeds
  // just burns xgodo agent time on un-rankable crawls, so pause the whole fleet
  // (content-gen + novelty) until embeds recover. Auto-resumes next tick.
  if (cfg.killOnDeadEmbeds) {
    const ks = await embedPipelineDead(cfg);
    if (ks.dead) {
      await recordKillswitch(true, ks.reason);
      console.warn(`[scheduler] embed kill-switch TRIPPED — pausing dispatch: ${ks.reason}`);
      return { ...empty, ran: true, reason: `embed_killswitch: ${ks.reason}` };
    }
    await recordKillswitch(false, '');
  }

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

    // Mode budget (novelty vs respy). ADVISORY ONLY for now — it records the split it
    // would choose so the decision can be validated against real yield data before it
    // gates any dispatch. Wiring it in is deliberately deferred until source='respy'
    // exists; with only one mode running there is nothing to balance.
    await computeModeBudget(cfg.maxThreads).catch(() => null);

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
    // A/B arm for this tick (every Nth tick = v1_ln control, else v2_pow).
    const policy: 'v1_ln' | 'v2_pow' = (seedSchedTick++ % SEED_HOLDOUT_EVERY === 0) ? 'v1_ln' : 'v2_pow';

    let pct = cfg.minNoveltyPct;
    let candidates = await findSeedCandidates({ topK: 60, minNoveltyPct: pct, excludeSeeded: true, englishOnly: cfg.englishOnly, policy });
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
      candidates = await findSeedCandidates({ topK: 60, minNoveltyPct: pct, excludeSeeded: true, englishOnly: cfg.englishOnly, policy });
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
             (seed_video_id, seed_url, niche_id, origin_cluster_id, status, novelty_at_dispatch,
              view_count_at_dispatch, select_policy, select_score)
           VALUES ($1, $2, $3, $4, 'crawling', $5, $6, $7, $8)
           ON CONFLICT (seed_video_id) DO UPDATE
             SET status = 'crawling', niche_id = EXCLUDED.niche_id,
                 dispatched_at = NOW(), origin_cluster_id = EXCLUDED.origin_cluster_id,
                 view_count_at_dispatch = EXCLUDED.view_count_at_dispatch,
                 select_policy = EXCLUDED.select_policy, select_score = EXCLUDED.select_score`,
          [seed.video_id, seed.video_url, nicheId, g.clusterId, seed.novelty_score,
           seed.view_count, policy, seed.seed_score],
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
  yield_stamped?: number;
  videos_rescored: number;
  clusters_released: number;
}

/**
 * Detect seed crawls that have finished (no live xgodo task for the
 * niche), backfill discovered_count, run a SCOPED novelty re-score over
 * the crawled region, then release the region lock. This is what makes
 * decay actually happen and what frees a cluster for future seeding.
 */
/**
 * MODE BUDGET CONTROLLER — split the xgodo fleet between the two discovery modes.
 *
 * The two modes do different jobs and must not compete in one queue:
 *   novelty — opens NEW niches (clusters never crawled). Exploration.
 *   respy   — revisits KNOWN niches to track their development. Maintenance.
 *
 * Allocation rule: **equalize new-channels per THREAD-HOUR**, not per mode total.
 * Equalising totals would push threads toward the weaker mode to lift its sum —
 * backwards. Equalising the marginal rate maximises total new channels, and it is
 * self-correcting: as novelty exhausts unexplored clusters its rate decays and the
 * budget slides to respy automatically, with no manual retuning.
 *
 * FLOORS matter, and not merely for safety. Novelty has option value beyond its
 * immediate channel count — it is the only mode that opens new territory, and per
 * the clustering engine only a base rebuild can discover genuinely new niches. A
 * pure rate-maximiser would happily starve it during a lean week and leave us blind
 * long-term. So each mode keeps a floor share regardless of measured rate.
 *
 * Reports its recommendation even while disabled, so the decision can be watched on
 * real data before it is allowed to control anything.
 */
export interface ModeBudget {
  novelty_threads: number;
  respy_threads: number;
  novelty_rate: number;   // new channels per thread-hour
  respy_rate: number;
  applied: boolean;       // false = advisory only (flag off / insufficient data)
  reason: string;
}

async function measureModeRate(source: string, windowHours: number): Promise<{ rate: number; crawls: number }> {
  const pool = await getPool();
  // new_channels / crawl_minutes come from stampSeedYield(); only measure crawls it
  // has already stamped, so a fresh crawl doesn't read as zero-yield.
  const r = await pool.query<{ chans: string; hours: string; n: string }>(
    `SELECT COALESCE(SUM(new_channels),0) AS chans,
            COALESCE(SUM(crawl_minutes)/60.0,0) AS hours,
            COUNT(*) AS n
       FROM niche_discovery_seeds
      WHERE source = $1
        AND new_channels IS NOT NULL
        AND crawl_minutes > 0
        AND completed_at > NOW() - ($2 || ' hours')::interval`,
    [source, String(windowHours)],
  );
  const chans = parseFloat(r.rows[0]?.chans ?? '0');
  const hours = parseFloat(r.rows[0]?.hours ?? '0');
  const n = parseInt(r.rows[0]?.n ?? '0');
  return { rate: hours > 0 ? chans / hours : 0, crawls: n };
}

export async function computeModeBudget(totalThreads: number): Promise<ModeBudget> {
  const pool = await getPool();
  const cfgRes = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config WHERE key IN
       ('seed_mode_split_enabled','seed_mode_floor_share','seed_mode_window_hours','seed_mode_default_respy_share')`,
  );
  const c: Record<string, string> = {};
  for (const r of cfgRes.rows) c[r.key] = r.value;
  const enabled     = c.seed_mode_split_enabled === 'true';       // ships OFF
  const floor       = Math.min(0.4, Math.max(0.05, parseFloat(c.seed_mode_floor_share || '0.15')));
  const windowHours = Math.max(6, parseInt(c.seed_mode_window_hours || '72'));
  const defRespy    = Math.min(0.9, Math.max(0.1, parseFloat(c.seed_mode_default_respy_share || '0.4')));

  const [nov, res] = await Promise.all([
    measureModeRate('novelty', windowHours),
    measureModeRate('respy', windowHours),
  ]);

  // Need real measurements on BOTH arms to rate-balance; until then use the
  // configured default split rather than inferring a rate from an empty arm
  // (a mode with no crawls reads 0/hr and would be starved into never recovering).
  const MIN_CRAWLS = 5;
  let respyShare: number;
  let reason: string;
  if (nov.crawls < MIN_CRAWLS || res.crawls < MIN_CRAWLS) {
    respyShare = defRespy;
    reason = `default split (novelty ${nov.crawls} / respy ${res.crawls} crawls < ${MIN_CRAWLS} measured)`;
  } else {
    // Proportional-to-rate allocation converges on equal marginal rate: the
    // higher-yield mode gets more threads until its rate decays to meet the other.
    const total = nov.rate + res.rate;
    respyShare = total > 0 ? res.rate / total : defRespy;
    respyShare = Math.min(1 - floor, Math.max(floor, respyShare));
    reason = `rate-balanced: novelty ${nov.rate.toFixed(1)}/thr-hr vs respy ${res.rate.toFixed(1)}/thr-hr`;
  }

  const respyThreads = Math.max(1, Math.round(totalThreads * respyShare));
  const budget: ModeBudget = {
    novelty_threads: Math.max(1, totalThreads - respyThreads),
    respy_threads: respyThreads,
    novelty_rate: nov.rate,
    respy_rate: res.rate,
    applied: enabled,
    reason,
  };
  // Persist so the split is observable (and auditable) even while advisory-only.
  await pool.query(
    `INSERT INTO admin_config (key, value) VALUES ('seed_mode_budget', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify({ ...budget, at: new Date().toISOString() })],
  ).catch(() => {});
  return budget;
}

/**
 * Stamp NEW-CHANNEL YIELD onto finished crawls — the Loop A prioritizer's input.
 *
 * `discovered_count` is candidates SCORED, not new channels FOUND; ranking on it
 * would optimise candidate volume, which is not what we want. The real signal is
 * first-touch lineage: channel_cg_status.discovered_by_seed_video_id names the seed
 * whose crawl FIRST surfaced each channel.
 *
 * DEFERRED on purpose. That lineage is stamped by the async cg-sweep, so counting at
 * reap time systematically undercounts. We only measure crawls that finished >2h ago,
 * by which point the sweep has caught up. The same pass therefore does double duty:
 * it backfills ~3 weeks of existing history AND keeps new crawls measured, with no
 * separate migration.
 *
 * Attribution is windowed to the crawl (discovered_at within dispatch..complete+grace)
 * so a seed crawled more than once credits each attempt with what IT surfaced, rather
 * than every attempt inheriting the same seed-level total.
 */
async function stampSeedYield(batch = 300): Promise<number> {
  const pool = await getPool();
  const res = await pool.query(
    `WITH todo AS (
       SELECT niche_id, seed_video_id, dispatched_at, completed_at
         FROM niche_discovery_seeds
        WHERE new_channels IS NULL
          AND completed_at IS NOT NULL
          AND completed_at < NOW() - INTERVAL '2 hours'
        ORDER BY completed_at DESC
        LIMIT $1
     ), counted AS (
       SELECT t.niche_id,
              COUNT(c.channel_id) AS nc,
              EXTRACT(EPOCH FROM (t.completed_at - t.dispatched_at))/60.0 AS mins
         FROM todo t
         LEFT JOIN channel_cg_status c
                ON c.discovered_by_seed_video_id = t.seed_video_id
               AND c.discovered_at >= t.dispatched_at
               AND c.discovered_at <= t.completed_at + INTERVAL '10 minutes'
        GROUP BY t.niche_id, t.dispatched_at, t.completed_at
     )
     UPDATE niche_discovery_seeds s
        SET new_channels  = counted.nc,
            crawl_minutes = GREATEST(0, counted.mins)
       FROM counted
      WHERE s.niche_id = counted.niche_id
        AND s.new_channels IS NULL`,
    [batch],
  );
  return res.rowCount ?? 0;
}

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

    // Yield stamping runs every tick regardless of whether any crawl just finished —
    // it measures crawls that completed >2h ago (and backfills history), so gating it
    // on `finished` would stall it whenever the fleet is quiet.
    const yieldStamped = await stampSeedYield().catch((e) => {
      console.error('[seed-reaper] yield stamp failed:', (e as Error).message);
      return 0;
    });
    if (yieldStamped > 0) console.log(`[seed-reaper] yield stamped=${yieldStamped}`);

    if (finished.length === 0) return { ...empty, ran: true, yield_stamped: yieldStamped };

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

    return { ran: true, finished_niches: finished.length, videos_rescored: videosRescored, clusters_released: clustersReleased, yield_stamped: yieldStamped };
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
