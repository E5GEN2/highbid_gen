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

export const COLAB_JOB_ID_DEFAULT = '6a4f3e09d3b833d350903c37';
export const COLAB_NOTEBOOK_URL_DEFAULT = 'http://195.201.198.166:8091/cluster_knn_worker.ipynb';
const XGODO_API = 'https://xgodo.com/api/v2';

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
  const inputs = Array.from({ length: n }, (_, i) => `${notebookUrl}?s=${stamp}-${i}`);
  try {
    const res = await fetch(`${XGODO_API}/planned_tasks/submit`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, inputs, run_immediately: true }),
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
  try {
    const [runRes, planRes] = await Promise.all([
      fetch(`${XGODO_API}/jobs/applicants`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId, status: 'running', limit: 100 }),
      }),
      fetch(`${XGODO_API}/planned_tasks?job_id=${encodeURIComponent(jobId)}&page=1&limit=100`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      }),
    ]);
    const run = runRes.ok ? await runRes.json() as { tasks?: unknown[]; applicants?: unknown[] } : {};
    const running = (Array.isArray(run.tasks) ? run.tasks.length : 0)
      + (Array.isArray(run.applicants) ? run.applicants.length : 0);
    let planned = 0;
    if (planRes.ok) {
      const plan = await planRes.json() as { data?: { plannedTasks?: unknown[]; total?: number } };
      planned = typeof plan.data?.total === 'number'
        ? plan.data.total
        : (plan.data?.plannedTasks?.length ?? 0);
    }
    return { running, planned };
  } catch (err) {
    return { running: 0, planned: 0, error: (err as Error).message };
  }
}
