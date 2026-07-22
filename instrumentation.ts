export async function register() {
  // Only run on the server (not edge)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getPool } = await import('./lib/db');

    let timer: ReturnType<typeof setInterval> | null = null;

    async function getConfig(pool: import('pg').Pool): Promise<Record<string, string>> {
      const result = await pool.query('SELECT key, value FROM admin_config');
      const config: Record<string, string> = {};
      for (const row of result.rows) config[row.key] = row.value;
      return config;
    }

    async function runAutoSchedule() {
      try {
        const pool = await getPool();
        const config = await getConfig(pool);

        if (config.auto_schedule_enabled !== 'true') return;
        if (!config.cron_secret) return;

        const intervalMin = parseInt(config.auto_schedule_interval_minutes) || 60;

        if (config.last_auto_schedule_at) {
          const elapsed = Date.now() - new Date(config.last_auto_schedule_at).getTime();
          if (elapsed < intervalMin * 60 * 1000) return;
        }

        const port = process.env.PORT || '3000';
        const baseUrl = `http://localhost:${port}`;
        const res = await fetch(`${baseUrl}/api/cron/schedule`, {
          headers: { 'Authorization': `Bearer ${config.cron_secret}` },
        });

        const data = await res.json();
        console.log('[auto-schedule]', data.success ? `scheduled ${data.scheduled} tasks (${data.numVideos} vids each)` : data.error || data.reason || 'unknown');
      } catch (err) {
        console.error('[auto-schedule] error:', err instanceof Error ? err.message : err);
      }
    }

    async function runAutoSync() {
      try {
        const pool = await getPool();
        const config = await getConfig(pool);

        if (config.auto_sync_enabled !== 'true') return;
        if (!config.cron_secret) return;

        const intervalMin = parseInt(config.auto_sync_interval_minutes) || 30;

        // Check if enough time has passed since last sync
        if (config.last_auto_sync_at) {
          const elapsed = Date.now() - new Date(config.last_auto_sync_at).getTime();
          if (elapsed < intervalMin * 60 * 1000) return;
        }

        // Call the cron endpoint on ourselves
        const port = process.env.PORT || '3000';
        const baseUrl = `http://localhost:${port}`;
        const res = await fetch(`${baseUrl}/api/cron/sync`, {
          headers: { 'Authorization': `Bearer ${config.cron_secret}` },
        });

        const data = await res.json();
        console.log('[auto-sync]', data.success ? `synced ${data.synced} tasks, ${data.videos} videos` : data.error || data.reason || 'unknown');
      } catch (err) {
        console.error('[auto-sync] error:', err instanceof Error ? err.message : err);
      }
    }

    /**
     * Vizard project poller. Calls /api/cron/vizard which queries Vizard for
     * every project still in pending/processing state and pulls back clips
     * once they're ready. Replaces the old client-side 30s setInterval that
     * stopped working when the admin tab was closed.
     *
     * Tick has its own internal "last_polled_at >25s ago" gate so calling
     * once a minute is safe even when there are dozens of in-flight projects.
     */
    async function runVizardClipsTick() {
      try {
        const pool = await getPool();
        const config = await getConfig(pool);
        if (!config.cron_secret) return;
        const port = process.env.PORT || '3000';
        const res = await fetch(`http://localhost:${port}/api/cron/vizard`, {
          headers: { 'Authorization': `Bearer ${config.cron_secret}` },
        });
        const data = await res.json();
        // Only log when we actually did work (avoid log spam every minute)
        if (data && (data.polled > 0 || data.errors > 0)) {
          console.log('[vizard-tick]', `polled=${data.polled} done=${data.done} errors=${data.errors}`);
        }
      } catch (err) {
        console.error('[vizard-tick] error:', err instanceof Error ? err.message : err);
      }
    }

    /**
     * YT-upload poller. Calls /api/cron/vizard-upload which polls each
     * in-flight clip BY ID via /jobs/applicants and updates status,
     * device, worker, YT URL on the vizard_clips row. Per-clip last_polled
     * gate (>30s) makes this safe to call every minute.
     */
    async function runVizardUploadTick() {
      try {
        const pool = await getPool();
        const config = await getConfig(pool);
        if (!config.cron_secret) return;
        const port = process.env.PORT || '3000';
        const res = await fetch(`http://localhost:${port}/api/cron/vizard-upload`, {
          headers: { 'Authorization': `Bearer ${config.cron_secret}` },
        });
        const data = await res.json();
        if (data && (data.polled > 0 || data.errors > 0)) {
          console.log('[vizard-upload]', `polled=${data.polled} updated=${data.updated} errors=${data.errors}`);
        }
      } catch (err) {
        console.error('[vizard-upload] error:', err instanceof Error ? err.message : err);
      }
    }

    /**
     * XG vid download poller. Calls /api/cron/xg-vid-download which
     * fetches up to 10 pending review tasks from xgodo, inserts any
     * new ones into xg_video_downloads, then drains up to 25 in-flight
     * rows with 3 workers concurrent. Per-row attempts/last_polled_at
     * guards make this safe to run every minute even with a slow
     * worker pool.
     */
    async function runXgVidDownloadTick() {
      try {
        const pool = await getPool();
        const config = await getConfig(pool);
        if (!config.cron_secret) return;
        const port = process.env.PORT || '3000';
        const res = await fetch(`http://localhost:${port}/api/cron/xg-vid-download`, {
          headers: { 'Authorization': `Bearer ${config.cron_secret}` },
        });
        const data = await res.json();
        if (data && (data.fetched > 0 || data.drained > 0 || data.failed > 0)) {
          console.log('[xg-vid-download]', `fetched=${data.fetched} inserted=${data.inserted} drained=${data.drained} confirmed=${data.confirmed} failed=${data.failed}`);
        }
      } catch (err) {
        console.error('[xg-vid-download] error:', err instanceof Error ? err.message : err);
      }
    }

    async function runAutoPost() {
      try {
        const pool = await getPool();
        const config = await getConfig(pool);

        if (config.auto_post_enabled !== 'true') return;
        if (!config.cron_secret) return;

        // The endpoint handles interval + duplicate guards itself,
        // but do a quick check here to avoid unnecessary HTTP calls
        const intervalHours = parseInt(config.auto_post_interval_hours) || 24;
        if (config.last_auto_post_at) {
          const elapsed = Date.now() - new Date(config.last_auto_post_at).getTime();
          if (elapsed < intervalHours * 60 * 60 * 1000) return;
        }

        const port = process.env.PORT || '3000';
        const baseUrl = `http://localhost:${port}`;
        const res = await fetch(`${baseUrl}/api/cron/x-post`, {
          headers: { 'Authorization': `Bearer ${config.cron_secret}` },
        });

        const data = await res.json();
        if (data.success) {
          console.log('[auto-post]', `posted ${data.posted}/${data.total} tweets, thread: ${data.threadUrl}`);
        } else {
          console.log('[auto-post]', data.error || data.reason || 'skipped');
        }
      } catch (err) {
        console.error('[auto-post] error:', err instanceof Error ? err.message : err);
      }
    }

    // ── Niche-discovery flywheel: two perpetual loops ──────────────────
    // Loop 1: novelty recompute. mode=missing scores newly-collected
    // (bot-embedded) videos so fresh seed candidates keep surfacing;
    // a nightly mode=all sweep is the decay safety net. Both gated by
    // config + interval. Fire-and-forget (heavy) with an in-process guard
    // so ticks can't overlap.
    let noveltyRecomputeRunning = false;
    async function runNoveltyRecomputeTick() {
      try {
        const pool = await getPool();
        const config = await getConfig(pool);
        if (config.novelty_auto_recompute_enabled !== 'true') return;
        if (noveltyRecomputeRunning) return;

        const intervalMin = parseInt(config.novelty_recompute_interval_minutes) || 15;
        const now = Date.now();
        const lastMissing = config.last_novelty_recompute_at ? new Date(config.last_novelty_recompute_at).getTime() : 0;
        const lastFull = config.last_novelty_full_recompute_at ? new Date(config.last_novelty_full_recompute_at).getTime() : 0;

        // Nightly full sweep: if >20h since the last mode=all, run one.
        const dueFull = now - lastFull > 20 * 60 * 60 * 1000;
        const dueMissing = now - lastMissing > intervalMin * 60 * 1000;
        if (!dueFull && !dueMissing) return;

        const { recomputeAllNovelty } = await import('./lib/vector-db');
        noveltyRecomputeRunning = true;
        const mode: 'all' | 'missing' = dueFull ? 'all' : 'missing';
        const stampKey = dueFull ? 'last_novelty_full_recompute_at' : 'last_novelty_recompute_at';
        // Stamp BEFORE running so a long full-sweep doesn't re-trigger.
        await pool.query(
          `INSERT INTO admin_config (key, value) VALUES ($1, NOW()::text)
             ON CONFLICT (key) DO UPDATE SET value = NOW()::text`,
          [stampKey],
        ).catch(() => {});
        // Detached — heavy. Clear the guard when done.
        recomputeAllNovelty({ mode, threads: 10 })
          .then(r => { if (r.scored > 0) console.log(`[novelty-recompute] mode=${mode} scored=${r.scored}/${r.total} in ${(r.durationMs/1000).toFixed(0)}s`); })
          .catch(err => console.error('[novelty-recompute] error:', err instanceof Error ? err.message : err))
          .finally(() => { noveltyRecomputeRunning = false; });
      } catch (err) {
        console.error('[novelty-recompute] tick error:', err instanceof Error ? err.message : err);
        noveltyRecomputeRunning = false;
      }
    }

    // Loop 2: auto-seed scheduler + reaper. The scheduler dispatches seeds
    // from un-seeded novelty candidates (advisory-locked, fleet-budgeted,
    // ships OFF). The reaper detects finished crawls, scoped-rescores the
    // crawled region (so decay happens), and releases the region lock.
    async function runSeedSchedulerLoop() {
      try {
        const pool = await getPool();
        const config = await getConfig(pool);
        // Reaper runs whenever EITHER loop is on (it's the post-crawl
        // re-score that serves both).
        const seedOn = config.auto_seed_enabled === 'true';
        const recomputeOn = config.novelty_auto_recompute_enabled === 'true';
        if (!seedOn && !recomputeOn) return;

        const { runSeedReaperTick, runSeedSchedulerTick } = await import('./lib/content-gen/seed-scheduler');

        // Reaper every ~5 min (idle-safe: only works when a crawl finished).
        const lastReaper = config.last_seed_reaper_at ? new Date(config.last_seed_reaper_at).getTime() : 0;
        if (Date.now() - lastReaper > 5 * 60 * 1000) {
          await pool.query(
            `INSERT INTO admin_config (key, value) VALUES ('last_seed_reaper_at', NOW()::text)
               ON CONFLICT (key) DO UPDATE SET value = NOW()::text`,
          ).catch(() => {});
          const rr = await runSeedReaperTick();
          if (rr.finished_niches > 0) console.log(`[seed-reaper] finished=${rr.finished_niches} rescored=${rr.videos_rescored} released=${rr.clusters_released}`);
        }

        // Maintain the thread count CONTINUOUSLY — like the keyword thermostat.
        // The scheduler runs every runAll cycle (~60s) and tops the fleet back
        // up to the budget the moment a crawl finishes, instead of dispatching
        // in bursts on a long interval. The tick is cheap (content-gen
        // discovery is cached, the candidate pull is ~2s) and advisory-locked,
        // so overlapping cycles serialize and it only dispatches when the fleet
        // is below target.
        if (!seedOn) return;
        await pool.query(
          `INSERT INTO admin_config (key, value) VALUES ('last_seed_schedule_at', NOW()::text)
             ON CONFLICT (key) DO UPDATE SET value = NOW()::text`,
        ).catch(() => {});
        const sr = await runSeedSchedulerTick();
        if (sr.ran && (sr.seeds_dispatched > 0 || sr.starvation_adjustment)) {
          console.log(`[seed-scheduler] dispatched ${sr.seeds_dispatched} seeds / ${sr.niches_dispatched} niches / ${sr.threads_dispatched} threads (pct=${sr.min_novelty_pct_used}${sr.starvation_adjustment ? '; ' + sr.starvation_adjustment : ''})`);
        }
      } catch (err) {
        console.error('[seed-scheduler] loop error:', err instanceof Error ? err.message : err);
      }
    }

    /**
     * Channel-stats enricher watchdog. The indefinite enricher (Phase 2 subs
     * fill — the content-gen KPI dependency) keeps dying: a deploy orphans it,
     * a transient shared-mem error exhausts its retries, or it exits cleanly on
     * an idle window and then fresh backlog arrives. The boot hook only RESUMES
     * jobs still in 'running' state, so one that already flipped to 'error'
     * before a deploy stays dark (cost 35 min on 2026-07-09). This tick is the
     * catch-all: if nothing is running but the enricher is meant to be
     * indefinite AND real backlog exists, restart it — throttled to once / 5min
     * so a job that dies on start can't spin the API. Idle-safe: one cheap
     * SELECT per minute when the enricher is healthy.
     */
    async function runEnrichWatchdogTick() {
      try {
        const pool = await getPool();
        const cfg = await pool.query<{ key: string; value: string }>(
          `SELECT key, value FROM admin_config WHERE key IN ('enrich_watchdog_enabled','last_enrich_watchdog_restart_at')`,
        );
        const c: Record<string, string> = {};
        for (const r of cfg.rows) c[r.key] = r.value;
        if (c.enrich_watchdog_enabled === 'false') return;    // kill switch (default ON)

        // Healthy? A running job means the enricher is alive — nothing to do.
        const running = await pool.query(`SELECT 1 FROM niche_yt_enrich_jobs WHERE status = 'running' LIMIT 1`);
        if (running.rows.length > 0) return;

        // Only auto-restart something that was configured to run indefinitely.
        const latest = await pool.query<{ indefinite: boolean; threads: number | null; keyword: string | null }>(
          `SELECT indefinite, threads, keyword FROM niche_yt_enrich_jobs ORDER BY id DESC LIMIT 1`,
        );
        const job = latest.rows[0];
        if (!job || !job.indefinite) return;

        // Only when there's meaningful backlog — a clean idle exit with nothing
        // to do should stay exited.
        const backlog = await pool.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM niche_spy_channels WHERE subscriber_count IS NULL`,
        );
        if ((parseInt(backlog.rows[0]?.n) || 0) < 50) return;

        // Throttle restarts (a crash-looping job can't spin faster than 1/5min).
        const last = c.last_enrich_watchdog_restart_at ? new Date(c.last_enrich_watchdog_restart_at).getTime() : 0;
        if (Date.now() - last < 5 * 60 * 1000) return;
        await pool.query(
          `INSERT INTO admin_config (key, value) VALUES ('last_enrich_watchdog_restart_at', NOW()::text)
             ON CONFLICT (key) DO UPDATE SET value = NOW()::text`,
        ).catch(() => {});

        const { POST: enrichPost } = await import('./app/api/niche-spy/enrich/route');
        const { NextRequest } = await import('next/server');
        const port = process.env.PORT || '3000';
        const req = new NextRequest(`http://localhost:${port}/api/niche-spy/enrich`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            keyword: job.keyword || undefined,
            limit: 10000, batchSize: 50, threads: job.threads || 30,
            delayMs: 200, indefinite: true,
          }),
        });
        // Fire-and-forget: the POST's count queries can take a few seconds, and
        // we must not stall the runAll loop behind them. The POST's own
        // single-flight check makes a redundant call a no-op.
        void enrichPost(req)
          .then(async res => console.log('[enrich-watchdog] restarted down indefinite enricher:', (await res.text()).slice(0, 160)))
          .catch(err => console.error('[enrich-watchdog] restart failed:', err instanceof Error ? err.message : err));
      } catch (err) {
        console.error('[enrich-watchdog] error:', err instanceof Error ? err.message : err);
      }
    }

    // CG-eligibility KPI sweep — stamps channel_cg_status (discovered_at +
    // first-touch seed lineage + eligibility verdict) incrementally so the
    // KPI is a cheap pre-stamped read. Bounded/indexed batches; kill switch
    // admin_config cg_sweep_enabled='false'. Only logs when it did work.
    async function runCgKpiSweepTick() {
      try {
        const { runCgSweepTick, runCgKpiAlertTick } = await import('./lib/content-gen/cg-sweep');
        const r = await runCgSweepTick();
        if (r.enabled && (r.discovered > 0 || r.evaluated > 0 || r.reevaluated > 0)) {
          console.log('[cg-sweep]', `discovered=${r.discovered} evaluated=${r.evaluated} reeval=${r.reevaluated} eligible=${r.eligibleInBatch} ${r.ms}ms`);
        }
        // Self-throttled (~hourly) KPI dip alert — cheap no-op the rest of the time.
        await runCgKpiAlertTick();
      } catch (err) {
        console.error('[cg-sweep] error:', err instanceof Error ? err.message : err);
      }
    }

    // Key-pool reaper — deletes rows consumers marked 'invalid' (terminally-dead
    // keys) so the pool self-cleans instead of piling up a graveyard that skews
    // the "% active" gauge. Bounded (2000/tick) so a big backlog drains over a
    // few ticks. Kill switch admin_config key_prune_enabled='false'.
    async function runKeyPruneTick() {
      try {
        const pool = await getPool();
        const cfg = await pool.query<{ value: string }>(
          `SELECT value FROM admin_config WHERE key = 'key_prune_enabled'`,
        );
        if (cfg.rows[0]?.value === 'false') return;   // default ON
        const { pruneInvalidKeys } = await import('./lib/api-key-validation');
        const n = await pruneInvalidKeys(2000);
        if (n > 0) console.log(`[key-prune] deleted ${n} invalid keys`);
      } catch (err) {
        console.error('[key-prune] error:', err instanceof Error ? err.message : err);
      }
    }

    async function runAll() {
      await runAutoSync();
      await runAutoSchedule();
      await runAutoPost();
      // Vizard tickers fire every runAll cycle (=1min). Both are no-ops
      // when there's nothing in-flight, so the only cost is one DB query
      // each per minute when idle.
      await runVizardClipsTick();
      await runVizardUploadTick();
      // XG vid download — same per-minute cadence as vizard. Idle-safe:
      // returns drained=0 when the queue is empty so cost stays at one
      // SELECT FOR UPDATE SKIP LOCKED + one xgodo fetch per tick.
      await runXgVidDownloadTick();
      // Enricher watchdog — restarts the indefinite channel-stats enricher if
      // it dies (deploy orphan, transient error, or clean idle exit + new
      // backlog). Cheap no-op (one SELECT) while it's healthy.
      await runEnrichWatchdogTick();
      // Key-pool reaper — sweep terminally-dead keys so the pool self-cleans.
      await runKeyPruneTick();
      // CG-eligibility KPI sweep — incremental stamp of the flywheel's OUTPUT
      // metric (cg-eligible channels). Bounded batches, no-op-cheap.
      await runCgKpiSweepTick();
      // Niche-discovery flywheel. Both gated by config flags (ship OFF)
      // + interval, so they're cheap no-ops until enabled.
      await runNoveltyRecomputeTick();
      await runSeedSchedulerLoop();
      // NOTE: the Niche Bending baker runs on its OWN dedicated interval (below),
      // NOT here — its candidate refresh can take ~13s and it must not be
      // serialized behind (or delayed by) the other ticks in this runAll.
    }

    async function runBendBakerTick2() {
      try {
        const pool = await getPool();
        const cfg = await pool.query<{ key: string; value: string }>(
          `SELECT key, value FROM admin_config WHERE key IN
             ('niche_bend_baker_enabled','niche_bend_target','niche_bend_per_tick','niche_bend_max_inflight')`,
        );
        const c: Record<string, string> = {};
        for (const r of cfg.rows) c[r.key] = r.value;
        if (c.niche_bend_baker_enabled !== 'true') return;   // ships OFF

        // Runs every runAll cycle (~60s) for continuous generation. The real
        // rate limiter is maxInFlight (shared-pool guard), not a time throttle.
        // The heartbeat timestamp lets the UI show the loop is alive.
        await pool.query(
          `INSERT INTO admin_config (key, value) VALUES ('last_niche_bend_bake_at', NOW()::text)
             ON CONFLICT (key) DO UPDATE SET value = NOW()::text`,
        ).catch(() => {});

        const { runBendBakerTick } = await import('./lib/niche-bend');
        const target = parseInt(c.niche_bend_target) || 5000;
        const perTick = parseInt(c.niche_bend_per_tick) || 3;
        const maxInFlight = parseInt(c.niche_bend_max_inflight) || 10;
        const r = await runBendBakerTick({ target, perTick, maxInFlight });
        if (r.baked || r.retried) {
          console.log(`[niche-bend] baked=${r.baked} retried=${r.retried} ready=${r.ready} rendering=${r.rendering} (ceiling ${target})`);
        }
      } catch (err) {
        console.error('[niche-bend] baker error:', err instanceof Error ? err.message : err);
      }
    }

    // Check every 60 seconds whether a sync/schedule is due
    timer = setInterval(runAll, 60 * 1000);

    // Initial check after 30s startup delay
    setTimeout(runAll, 30 * 1000);

    // Niche Bending baker on its OWN interval (every 30s) with a re-entrancy
    // guard, so a slow candidate refresh (~13s) can't overlap itself and slow
    // sibling ticks in runAll can't delay continuous generation.
    let bendBaking = false;
    const bendTick = async () => {
      if (bendBaking) return;
      bendBaking = true;
      try { await runBendBakerTick2(); } finally { bendBaking = false; }
    };
    setInterval(bendTick, 30 * 1000);
    setTimeout(bendTick, 20 * 1000);

    // Niche Watcher (cheap YT-key pulse) on its OWN interval — re-measures the
    // most-stale channels in watched niches via the shared reMeasureChannels
    // engine. Sequential over a bounded batch (~10-20s), so it runs off runAll
    // with a re-entrancy guard. No-op-cheap when nothing is watched/due.
    let watcherRunning = false;
    const watcherTick = async () => {
      if (watcherRunning) return;
      watcherRunning = true;
      try {
        const { runNicheWatcherTick } = await import('./lib/niche-watcher');
        const r = await runNicheWatcherTick();
        if (r.enabled && !r.skipped && r.channels > 0) {
          console.log('[niche-watcher]', `channels=${r.channels} stats=${r.statsUpdated} recent=${r.recentPulled} newVids=${r.newVideos}`);
        }
      } catch (err) {
        console.error('[niche-watcher] error:', err instanceof Error ? err.message : err);
      } finally { watcherRunning = false; }
    };
    setInterval(watcherTick, 60 * 1000);
    setTimeout(watcherTick, 45 * 1000);

    // Channel Growth Watcher (docs/growth-watcher/spec.md) on its OWN interval —
    // enrolls small channels + captures a daily subs/video snapshot via the
    // shared reMeasureChannels engine (stats-only, ~free). Sequential over a
    // bounded batch, so it runs off runAll with a re-entrancy guard. Kill switch:
    // admin_config growth_watcher_enabled.
    let growthRunning = false;
    const growthTick = async () => {
      if (growthRunning) return;
      growthRunning = true;
      try {
        const { runGrowthWatcherTick } = await import('./lib/growth-watcher');
        const r = await runGrowthWatcherTick();
        if (r.enabled && !r.skipped && (r.enrolled > 0 || r.snapshotted > 0)) {
          console.log('[growth-watcher]', `enrolled=${r.enrolled} scanned=${r.scanned} snapshots=${r.snapshotted} lives=${r.lives} ${r.ms}ms`);
        }
      } catch (err) {
        console.error('[growth-watcher] error:', err instanceof Error ? err.message : err);
      } finally { growthRunning = false; }
    };
    setInterval(growthTick, 60 * 1000);
    setTimeout(growthTick, 50 * 1000);

    // Start the agent thermostat (maintains thread targets per keyword)
    const { ensureThermostatRunning } = await import('./lib/agent-thermostat');
    ensureThermostatRunning();

    // Qwen embedding backfill loop — always started; it parks while
    // qwen_backfill_enabled != 'true', so a deploy never silently kills the
    // backfill (flag-driven, same lesson as the yt-enrich auto-resume).
    const { ensureQwenBackfillRunning } = await import('./lib/qwen-embed');
    ensureQwenBackfillRunning();

    // Mark "running" embedding jobs that haven't had progress in >3 minutes as
    // orphaned. They're leftovers from a previous server process whose worker
    // loops no longer exist. Fresh jobs are untouched — if we swept ALL running
    // jobs unconditionally we'd kill the one that just started from the user's
    // click post-boot.
    try {
      const { getPool } = await import('./lib/db');
      const pool = await getPool();
      const r = await pool.query(
        `UPDATE niche_spy_embedding_jobs
            SET status = 'error',
                error_message = 'Orphaned: server restarted before job finished',
                completed_at = NOW()
          WHERE status = 'running' AND started_at < NOW() - INTERVAL '3 minutes'
          RETURNING id`
      );
      if (r.rowCount && r.rowCount > 0) {
        console.log(`[boot] Marked ${r.rowCount} orphaned embedding job(s) as error`);
      }
      // Same treatment for YT enrich jobs — but an INDEFINITE job (the
      // channel-stats enricher the content-gen KPI depends on) is meant to
      // run forever, so after orphaning it, auto-restart it. Without this a
      // deploy silently kills enrichment until someone notices subs stop
      // filling (cost 6 days of eligible-channel flow 6-28..7-04).
      const r2 = await pool.query<{ id: number; indefinite: boolean; keyword: string | null; threads: number | null }>(
        `UPDATE niche_yt_enrich_jobs
            SET status = 'error',
                error_message = 'Orphaned: server restarted before job finished',
                completed_at = NOW()
          WHERE status = 'running' AND started_at < NOW() - INTERVAL '3 minutes'
          RETURNING id, indefinite, keyword, threads`
      );
      if (r2.rowCount && r2.rowCount > 0) {
        console.log(`[boot] Marked ${r2.rowCount} orphaned enrich job(s) as error`);
        const indef = r2.rows.find(j => j.indefinite);
        if (indef) {
          // Delay so the boot (initSchema, tick loops) settles before a
          // 30-thread job spins up. The enrich POST's single-flight check
          // makes this a no-op if a human already restarted it.
          setTimeout(async () => {
            try {
              const { POST: enrichPost } = await import('./app/api/niche-spy/enrich/route');
              const { NextRequest } = await import('next/server');
              const req = new NextRequest('http://localhost/api/niche-spy/enrich', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  keyword: indef.keyword || undefined,
                  limit: 10000,
                  batchSize: 50,
                  threads: indef.threads || 30,
                  delayMs: 200,
                  indefinite: true,
                }),
              });
              const res = await enrichPost(req);
              console.log(`[boot] auto-resumed indefinite enrich job (was ${indef.id}):`, await res.text());
            } catch (err) {
              console.error('[boot] enrich auto-resume failed:', (err as Error).message);
            }
          }, 60_000);
        }
      }
      // niche_tree_runs: a redeploy kills the in-process Node driver, but a GPU
      // run's RunPod job keeps COMPUTING on RunPod's infra and stages its result
      // to runpod_job_results regardless. So instead of blanket-orphaning, RE-ATTACH
      // any global run that still has a live RunPod job: resume polling + ingest from
      // the new container. Only runs with NO RunPod job (never dispatched, or the CPU
      // subprocess path which can't survive a restart) get orphan-errored.
      // 3-minute grace so a fresh click post-boot isn't caught.
      const stale = await pool.query<{ id: number; kind: string; params: Record<string, unknown> | null; runpod_job: string | null }>(
        `SELECT id, kind, params, progress->>'runpodJobId' AS runpod_job
           FROM niche_tree_runs
          WHERE status = 'running' AND started_at < NOW() - INTERVAL '3 minutes'`
      );
      for (const row of stale.rows) {
        if (row.kind === 'global' && row.runpod_job) {
          console.log(`[boot] re-attaching in-flight niche_tree run ${row.id} (RunPod job ${row.runpod_job})`);
          const { runGlobalClusteringJob } = await import('./lib/niche-tree');
          // Fire-and-forget resume: skips /run, re-polls the live job, then the SAME ingest path runs.
          runGlobalClusteringJob(row.id, { ...(row.params || {}), resumeJobId: row.runpod_job })
            .catch(err => console.error(`[boot] resume run ${row.id} failed:`, err instanceof Error ? err.message : err));
        } else {
          await pool.query(
            `UPDATE niche_tree_runs
                SET status = 'error',
                    error_message = 'Orphaned: server restarted before run finished (no RunPod job to resume)',
                    completed_at = NOW()
              WHERE id = $1`,
            [row.id],
          );
          console.log(`[boot] Marked orphaned niche_tree run ${row.id} (${row.kind}) as error`);
        }
      }
    } catch (err) {
      console.error('[boot] Failed to cleanup orphaned jobs:', (err as Error).message);
    }

    // Cleanup on process exit
    process.on('beforeExit', () => {
      if (timer) clearInterval(timer);
    });
  }
}
