/**
 * Colab fleet — spawn + track the Colab GPU workers that power the
 * distributed kNN build (and future fleet workloads).
 *
 * Spawning: a dedicated xgodo job ("colab agent") opens a notebook File Url
 * in Colab and runs it. Submitting N planned tasks to that job = spawning N
 * Colab instances. Reuses the same xgodo token as the niche-spy job.
 *
 * Tracking: Colab VMs are NAT'd — they can only call OUT. So "pinging" a
 * worker means observing its pulls: every authed call to /api/cluster-worker
 * carries a worker_id and upserts a colab_workers row (last_seen = the
 * heartbeat). A worker whose last_seen is fresh is connected; stale means
 * dropped (Colab preemption / session end) — its claims self-expire and the
 * fleet re-hands the work, so drop-offs cost nothing.
 *
 * Config (admin_config, all editable without deploys):
 *   colab_job_id        — the xgodo colab job (default: the one provisioned 2026-07-27)
 *   colab_notebook_url  — the File Url handed to spawned instances
 */
import { getPool } from './db';

const FLEET_DIR = process.env.FLEET_DIR || '/data/fleet';
const FLEET_BASE_URL = process.env.FLEET_BASE_URL || 'http://195.201.198.166:8091';

/** Copy the master notebook to a unique per-spawn filename under fleet/w/,
 *  so each Colab session owns a distinct Drive document (see spawn comment).
 *  Also prunes copies older than a day. Returns false if the copy failed —
 *  callers then fall back to the shared URL rather than not spawning. */
async function materializeWorkerCopy(name: string): Promise<boolean> {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.join(FLEET_DIR, 'w');
    fs.mkdirSync(dir, { recursive: true });
    const master = path.join(FLEET_DIR, 'cluster_knn_worker.ipynb');
    if (!fs.existsSync(master)) return false;
    fs.copyFileSync(master, path.join(dir, name));
    // prune stale copies (>24h) so the dir can't grow without bound
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
    }
    return true;
  } catch (err) {
    console.error('[colab] notebook copy failed:', (err as Error).message);
    return false;
  }
}

export const COLAB_JOB_ID_DEFAULT = '6a4f3e09d3b833d350903c37';
export const COLAB_NOTEBOOK_URL_DEFAULT = 'http://195.201.198.166:8091/cluster_knn_worker.ipynb';
const XGODO_API = 'https://xgodo.com/api/v2';
// xgodo calls MUST be time-capped: the jobs/applicants POST can blackhole for
// devices_automation jobs (observed 2026-07-27 — hung the admin route for 40s+
// AND wedged the keeper tick's re-entrancy guard permanently). Node fetch has
// no default timeout.
const XG_TIMEOUT = () => AbortSignal.timeout(12_000);
// The SUBMIT endpoint is legitimately slow (measured 10.4s on 2026-07-28 while
// the status GET returned in 0.1s), so a 12s cap aborts real spawns. Give
// writes their own, longer budget; keep the tight cap on the read probes,
// which is where the blackhole risk lives.
const XG_SUBMIT_TIMEOUT = () => AbortSignal.timeout(45_000);

// last_seen fresher than this = "connected". The worker polls at least
// every ~30s (idle) and heartbeats mid-tile, so 2 min is generous.
export const WORKER_LIVE_WINDOW = '2 minutes';

let colabTablesReady = false;

export async function ensureColabTables(): Promise<void> {
  if (colabTablesReady) return;
  const pool = await getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS colab_workers (
      worker_id TEXT PRIMARY KEY,
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      last_action TEXT,
      gpu TEXT,
      tiles_done INTEGER NOT NULL DEFAULT 0,
      edges_total BIGINT NOT NULL DEFAULT 0,
      beats BIGINT NOT NULL DEFAULT 0
    )
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cw_last_seen ON colab_workers(last_seen DESC)`).catch(() => {});
  colabTablesReady = true;
}

/** Upsert a heartbeat. Called on every authed worker request; cheap. */
export async function recordWorkerBeat(
  workerId: string,
  action: string,
  extras?: { gpu?: string; tilesDelta?: number; edgesDelta?: number },
): Promise<void> {
  if (!workerId || workerId.length > 80) return;
  const pool = await getPool();
  await pool.query(
    `INSERT INTO colab_workers (worker_id, last_action, gpu, tiles_done, edges_total, beats)
     VALUES ($1, $2, $3, $4, $5, 1)
     ON CONFLICT (worker_id) DO UPDATE SET
       last_seen   = NOW(),
       last_action = EXCLUDED.last_action,
       gpu         = COALESCE(EXCLUDED.gpu, colab_workers.gpu),
       tiles_done  = colab_workers.tiles_done + $4,
       edges_total = colab_workers.edges_total + $5,
       beats       = colab_workers.beats + 1`,
    [workerId, action, extras?.gpu ?? null, extras?.tilesDelta ?? 0, extras?.edgesDelta ?? 0],
  ).catch(() => {});
}

export interface ColabWorkerRow {
  worker_id: string;
  first_seen: string;
  last_seen: string;
  last_action: string | null;
  gpu: string | null;
  tiles_done: number;
  edges_total: string;
  beats: string;
  connected: boolean;
  seconds_since_seen: number;
}

/** The fleet as rofe.ai sees it: connected = pulled/heartbeat within the window. */
export async function getFleetWorkers(limit = 50): Promise<ColabWorkerRow[]> {
  await ensureColabTables();
  const pool = await getPool();
  const r = await pool.query<ColabWorkerRow>(
    `SELECT worker_id, first_seen, last_seen, last_action, gpu, tiles_done,
            edges_total::text, beats::text,
            (last_seen > NOW() - INTERVAL '${WORKER_LIVE_WINDOW}') AS connected,
            ROUND(EXTRACT(EPOCH FROM (NOW() - last_seen)))::int AS seconds_since_seen
       FROM colab_workers
      ORDER BY last_seen DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export async function getColabConfig(): Promise<{ jobId: string; notebookUrl: string; token: string }> {
  const pool = await getPool();
  const r = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config
      WHERE key IN ('colab_job_id', 'colab_notebook_url', 'xgodo_niche_spy_token', 'xgodo_api_token')`,
  );
  const c: Record<string, string> = {};
  for (const row of r.rows) c[row.key] = row.value;
  return {
    jobId: c.colab_job_id || COLAB_JOB_ID_DEFAULT,
    notebookUrl: c.colab_notebook_url || COLAB_NOTEBOOK_URL_DEFAULT,
    token: c.xgodo_niche_spy_token || c.xgodo_api_token || '',
  };
}

/** Spawn N Colab instances = submit N planned tasks (File Url inputs). */
export async function spawnColabInstances(count: number): Promise<{ ok: boolean; submitted: number; error?: string }> {
  const { jobId, notebookUrl, token } = await getColabConfig();
  if (!token) return { ok: false, submitted: 0, error: 'xgodo token not configured' };
  const n = Math.max(1, Math.min(30, count));
  // Unique query-suffix per input: keeps entries distinct on xgodo's side and
  // is invisible to the static file server that hosts the notebook.
  const stamp = Date.now().toString(36);
  // EVERY spawn gets its OWN notebook FILE, not just a unique query string.
  // Colab auto-saves the opened notebook to Drive; two sessions holding the
  // same file collide with "Automatic saving failed - this file was updated
  // remotely or in another tab", and cell execution dies (observed 2026-07-28,
  // diagnosed by Christine). Distinct filenames => distinct Drive documents
  // => parallel instances never fight. A query string is NOT enough: Colab
  // keys on the filename.
  const inputs: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = `cw_${stamp}_${i}.ipynb`;
    const copied = await materializeWorkerCopy(name);
    inputs.push(JSON.stringify({
      fileUrl: copied ? `${FLEET_BASE_URL}/w/${name}` : `${notebookUrl}?s=${stamp}-${i}`,
    }));
  }
  try {
    const res = await fetch(`${XGODO_API}/planned_tasks/submit`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, inputs, run_immediately: true }),
      signal: XG_SUBMIT_TIMEOUT(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, submitted: 0, error: `xgodo submit ${res.status}: ${text.slice(0, 180)}` };
    }
    const data = await res.json() as { inserted_ids?: unknown[] };
    return { ok: true, submitted: (data.inserted_ids || []).length || n };
  } catch (err) {
    return { ok: false, submitted: 0, error: (err as Error).message };
  }
}

// ── Keeper: always keep N Colab instances alive ──────────────────────────
// Colab sessions die constantly (idle limits, preemption, daily caps). The
// keeper closes the loop: if connected workers < target and nothing is
// already booting/queued on the xgodo side, spawn the shortfall.
//
// Config (admin_config, live-read every tick — no deploys):
//   colab_keeper_enabled      — 'true' to run (kill switch like every tick)
//   colab_target_alive        — desired connected workers (default 1)
//   colab_spawn_cooldown_min  — min minutes between spawn volleys (default 7;
//                               a Colab takes ~3-6 min to boot + connect, so
//                               the keeper must not double-spawn while one is
//                               still booting)
export interface KeeperResult {
  enabled: boolean;
  connected?: number;
  target?: number;
  pipeline?: number;
  spawned?: number;
  reason?: string;
}

export async function runColabKeeperTick(): Promise<KeeperResult> {
  const pool = await getPool();
  const cfgRes = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config
      WHERE key IN ('colab_keeper_enabled','colab_target_alive','colab_spawn_cooldown_min','last_colab_spawn_at')`,
  );
  const cfg: Record<string, string> = {};
  for (const r of cfgRes.rows) cfg[r.key] = r.value;
  if (cfg.colab_keeper_enabled !== 'true') return { enabled: false };

  const target = Math.max(0, Math.min(30, parseInt(cfg.colab_target_alive) || 1));
  if (target === 0) return { enabled: true, target: 0, reason: 'target 0' };

  await ensureColabTables();
  const conn = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM colab_workers WHERE last_seen > NOW() - INTERVAL '${WORKER_LIVE_WINDOW}'`,
  );
  const connected = parseInt(conn.rows[0]?.n) || 0;

  // Heartbeat stamp — the Colab tab + overwatch read this for keeper liveness.
  await pool.query(
    `INSERT INTO admin_config (key, value) VALUES ('last_colab_keeper_at', NOW()::text)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  ).catch(() => {});

  if (connected >= target) return { enabled: true, connected, target, spawned: 0, reason: 'satisfied' };

  // Booting/queued instances count against the shortfall — a spawned Colab
  // takes minutes to appear as connected, and spawning again meanwhile would
  // overshoot (and burn planned tasks).
  const xg = await getXgodoColabStatus();
  // Pipeline = QUEUED tasks only. The 'running' state is untrustworthy for
  // devices_automation jobs: tasks observed stuck 'running' 25+ min past the
  // job's own 600s limit (never reaped) — counting them would park the keeper
  // behind zombies forever. The spawn cooldown already absorbs the
  // boot-latency double-spawn risk that 'running' was meant to cover.
  const pipeline = xg.planned;
  const shortfall = target - connected - pipeline;
  if (shortfall <= 0) {
    return { enabled: true, connected, target, pipeline, spawned: 0, reason: 'spawns in flight' };
  }

  // Spawn-volley cooldown: even if xgodo shows an empty pipeline (e.g. the
  // task was consumed but the notebook is still booting), don't re-spawn
  // more often than the cooldown.
  const cooldownMin = Math.max(2, parseInt(cfg.colab_spawn_cooldown_min) || 7);
  const lastSpawn = cfg.last_colab_spawn_at ? Date.parse(cfg.last_colab_spawn_at) : 0;
  if (Number.isFinite(lastSpawn) && lastSpawn > 0 && Date.now() - lastSpawn < cooldownMin * 60_000) {
    return { enabled: true, connected, target, pipeline, spawned: 0, reason: 'cooldown' };
  }

  const toSpawn = Math.min(shortfall, 3);   // volley cap — never storm
  const res = await spawnColabInstances(toSpawn);
  await pool.query(
    `INSERT INTO admin_config (key, value) VALUES ('last_colab_spawn_at', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [new Date().toISOString()],
  ).catch(() => {});
  return {
    enabled: true, connected, target, pipeline,
    spawned: res.ok ? res.submitted : 0,
    reason: res.ok ? 'spawned' : `spawn failed: ${res.error}`,
  };
}

export interface XgodoColabStatus {
  running: number;
  planned: number;
  error?: string;
}

/** xgodo-side view: how many colab-agent tasks are running / queued.
 *  Running = jobs/applicants status='running'; planned = the SEPARATE
 *  /planned_tasks queue endpoint (same as the niche-spy scheduler uses —
 *  applicants status='planned' is a different concept and reads 0). */
export async function getXgodoColabStatus(): Promise<XgodoColabStatus> {
  const { jobId, token } = await getColabConfig();
  if (!token) return { running: 0, planned: 0, error: 'xgodo token not configured' };
  // Each probe is independently fail-soft: the applicants POST is known to
  // hang/fail for devices_automation jobs, and it must never take the
  // planned_tasks probe (which works) down with it.
  const [runOut, planOut] = await Promise.allSettled([
    fetch(`${XGODO_API}/jobs/applicants`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, status: 'running', limit: 100 }),
      signal: XG_TIMEOUT(),
    }).then(async r => r.ok ? await r.json() as { tasks?: unknown[]; applicants?: unknown[]; job_tasks?: unknown[] } : {}),
    fetch(`${XGODO_API}/planned_tasks?job_id=${encodeURIComponent(jobId)}&page=1&limit=100`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
      signal: XG_TIMEOUT(),
    }).then(async r => r.ok ? await r.json() as { data?: { plannedTasks?: unknown[]; total?: number } } : null),
  ]);
  let running = 0;
  let error: string | undefined;
  if (runOut.status === 'fulfilled') {
    const run = runOut.value;
    running = (Array.isArray(run.tasks) ? run.tasks.length : 0)
      + (Array.isArray(run.applicants) ? run.applicants.length : 0)
      + (Array.isArray(run.job_tasks) ? run.job_tasks.length : 0);
  } else {
    error = `applicants: ${(runOut.reason as Error)?.message ?? 'failed'}`;
  }
  let planned = 0;
  if (planOut.status === 'fulfilled' && planOut.value) {
    const plan = planOut.value;
    planned = typeof plan.data?.total === 'number'
      ? plan.data.total
      : (plan.data?.plannedTasks?.length ?? 0);
  } else if (planOut.status === 'rejected') {
    error = (error ? error + '; ' : '') + `planned: ${(planOut.reason as Error)?.message ?? 'failed'}`;
  }
  return { running, planned, ...(error ? { error } : {}) };
}
