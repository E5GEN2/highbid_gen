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

    async function runAll() {
      await runAutoSync();
      await runAutoSchedule();
    }

    // Check every 60 seconds whether a sync/schedule is due
    timer = setInterval(runAll, 60 * 1000);

    // Initial check after 30s startup delay
    setTimeout(runAll, 30 * 1000);

    // Cleanup on process exit
    process.on('beforeExit', () => {
      if (timer) clearInterval(timer);
    });
  }
}
