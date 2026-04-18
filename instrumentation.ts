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

    async function runAll() {
      await runAutoSync();
      await runAutoSchedule();
      await runAutoPost();
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
    } catch (err) {
      console.error('[boot] Failed to cleanup orphaned embedding jobs:', (err as Error).message);
    }

    // Cleanup on process exit
    process.on('beforeExit', () => {
      if (timer) clearInterval(timer);
    });
  }
}
