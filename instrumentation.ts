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

        // Scheduler on its own interval (default 30 min).
        if (!seedOn) return;
        const intervalMin = parseInt(config.auto_seed_interval_minutes) || 30;
        const lastSched = config.last_seed_schedule_at ? new Date(config.last_seed_schedule_at).getTime() : 0;
        if (Date.now() - lastSched < intervalMin * 60 * 1000) return;
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
      // Niche-discovery flywheel. Both gated by config flags (ship OFF)
      // + interval, so they're cheap no-ops until enabled.
      await runNoveltyRecomputeTick();
      await runSeedSchedulerLoop();
    }

    // Check every 60 seconds whether a sync/schedule is due
    timer = setInterval(runAll, 60 * 1000);

    // Initial check after 30s startup delay
    setTimeout(runAll, 30 * 1000);

    // Start the agent thermostat (maintains thread targets per keyword)
    const { ensureThermostatRunning } = await import('./lib/agent-thermostat');
    ensureThermostatRunning();

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
      // Same treatment for YT enrich jobs
      const r2 = await pool.query(
        `UPDATE niche_yt_enrich_jobs
            SET status = 'error',
                error_message = 'Orphaned: server restarted before job finished',
                completed_at = NOW()
          WHERE status = 'running' AND started_at < NOW() - INTERVAL '3 minutes'
          RETURNING id`
      );
      if (r2.rowCount && r2.rowCount > 0) {
        console.log(`[boot] Marked ${r2.rowCount} orphaned enrich job(s) as error`);
      }
      // niche_tree_runs: the global L1 + chained L2 baking pipeline runs
      // entirely in-process (Node-driven loop calling python via spawn).
      // A redeploy kills both the python child and the JS loop, but the
      // DB rows stay flagged 'running' forever. Sweep both kinds (global
      // and subdivide) using the same 3-minute grace so a fresh click
      // post-boot isn't caught.
      const r3 = await pool.query(
        `UPDATE niche_tree_runs
            SET status = 'error',
                error_message = 'Orphaned: server restarted before run finished',
                completed_at = NOW()
          WHERE status = 'running' AND started_at < NOW() - INTERVAL '3 minutes'
          RETURNING id, kind`
      );
      if (r3.rowCount && r3.rowCount > 0) {
        console.log(`[boot] Marked ${r3.rowCount} orphaned niche_tree run(s) as error`);
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
