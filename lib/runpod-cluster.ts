/**
 * RunPod Serverless dispatcher for the GPU clustering worker.
 *
 * Lifts the "produce a cluster result JSON" step out of the local
 * subprocess path (lib/niche-tree.ts) and routes it through RunPod
 * when admin_config.cluster_execution_mode === 'gpu' (or the caller
 * passes execution_mode='gpu' explicitly).
 *
 * The handler at docker/cluster-gpu/handler.py accepts the same
 * config payload the local script reads, just dressed in a RunPod
 * `{ input: {...} }` envelope. We POST /run, then poll /status/{id}
 * with light backoff until COMPLETED. The returned `output` is the
 * same JSON shape cluster-niches.py prints on stdout — i.e. exactly
 * what runOneClusteringPipeline already knows how to ingest.
 *
 * Why polling (vs RunPod's webhook callback)?
 *   Niche-tree runs already execute in a fire-and-forget Node async
 *   context (the POST that kicks one off returns immediately with a
 *   run_id). Sitting in a poll loop inside that context costs nothing
 *   and avoids needing a publicly-reachable webhook receiver.
 */

import { getPool } from './db';
import { fetchRunpodLogs, fetchRunpodResult } from './vector-db';

const RUNPOD_API = 'https://api.runpod.ai/v2';

export type ClusterExecutionMode = 'cpu' | 'gpu';

interface RunPodCreds {
  apiKey: string;
  endpointId: string;
}

/** Read RunPod credentials from admin_config. Returns null when either
 *  is missing — caller should fall back to CPU dispatch. */
export async function getRunPodCreds(): Promise<RunPodCreds | null> {
  const pool = await getPool();
  const r = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config
      WHERE key IN ('runpod_api_key', 'runpod_cluster_endpoint_id')`,
  );
  const map = new Map(r.rows.map(row => [row.key, row.value]));
  const apiKey = map.get('runpod_api_key');
  const endpointId = map.get('runpod_cluster_endpoint_id');
  if (!apiKey || !endpointId) return null;
  return { apiKey, endpointId };
}

/** Resolve the DB URL to hand to the RunPod container. RunPod is off-
 *  network so a Railway internal hostname (*.railway.internal) won't
 *  resolve — we need the public/proxy URL. Operators paste it into
 *  admin_config.vector_db_url_external; we prefer that if set, else
 *  fall back to the process env (mostly useful in dev). */
export async function getExternalVectorDbUrl(): Promise<string | null> {
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'vector_db_url_external'`,
  );
  const fromConfig = r.rows[0]?.value?.trim();
  if (fromConfig) return fromConfig;
  // Fallback — only useful if the process env happens to be the public
  // URL (e.g. local dev). In Railway prod the env var is internal.
  return process.env.VECTOR_DB_URL ?? null;
}

/** Read the current execution mode. Default = 'cpu' (existing
 *  behaviour). Operator flips this to 'gpu' in admin_config to route
 *  everything through RunPod. */
export async function getClusterExecutionMode(): Promise<ClusterExecutionMode> {
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'cluster_execution_mode'`,
  );
  const v = r.rows[0]?.value?.toLowerCase();
  return v === 'gpu' ? 'gpu' : 'cpu';
}

/** Min |videoIds| to bother with GPU dispatch. Below this, the ~30s
 *  RunPod cold-start dwarfs the local CPU runtime, so we transparently
 *  fall back to CPU for tiny L2 subdivides. Tuned conservatively;
 *  bench can sharpen later. */
export const GPU_DISPATCH_MIN_VIDEOS = 5000;

interface RunPodStartResponse {
  id: string;
  status: string; // 'IN_QUEUE' typically
}

interface RunPodStatusResponse {
  id: string;
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  output?: unknown;
  error?: string;
  delayTime?: number;     // ms spent in queue
  executionTime?: number; // ms actually running
}

export interface RunPodDispatchResult {
  jobId: string;
  delayMs: number;
  executionMs: number;
  result: Record<string, unknown>; // cluster-niches.py output JSON
}

/** Result of a combined L1 + L2 bake — the container does both passes
 *  in one container session, returning a single payload. */
export interface GlobalBakeResult {
  jobId: string;
  delayMs: number;
  executionMs: number;
  l1: Record<string, unknown>;
  /** Keyed by parent L1 cluster_index (stringified). Values are
   *  cluster-niches.py output JSONs for that subdivide. */
  l2ByParent: Record<string, Record<string, unknown>>;
  l2Skipped: number;
  l2Errors: number;
  l2ErrorDetails: Array<{ parent_cluster_index: number; error: string; stderr_tail?: string }>;
}

interface DispatchOpts {
  /** Payload to forward verbatim to the handler — same shape as the
   *  config the local subprocess reads from its tmpfile. */
  payload: Record<string, unknown>;
  /** RESUME: poll an EXISTING RunPod job instead of POSTing /run. Set by the
   *  boot re-attach so an in-flight clustering run survives a redeploy/restart —
   *  the RunPod job keeps computing on RunPod's infra, we just re-poll it. */
  existingJobId?: string;
  /** Hard ceiling on the poll loop, in ms. Default 90 min. Tracks
   *  pyTimeoutMs on the CPU path. */
  timeoutMs?: number;
  /** Called once with the RunPod job id as soon as /run returns, so
   *  callers can persist it for forensics (e.g. into
   *  niche_tree_runs.progress). */
  onJobStart?: (jobId: string) => void;
  /** Optional progress sink for the operator-visible run log. */
  onProgress?: (msg: string) => void;
}

/** POST /run + poll /status until terminal. Throws on any non-COMPLETED
 *  outcome with enough context to surface in the run row. */
export async function dispatchClusterToRunPod(
  creds: RunPodCreds,
  opts: DispatchOpts,
): Promise<RunPodDispatchResult> {
  const timeoutMs = opts.timeoutMs ?? 90 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  // --- POST /run (or RE-ATTACH to an existing job) -----------------
  let startJson: RunPodStartResponse;
  if (opts.existingJobId) {
    // Resume: the RunPod job is already running on RunPod's infra (it survives
    // a Node redeploy). Skip /run and poll its /status directly.
    startJson = { id: opts.existingJobId } as RunPodStartResponse;
    opts.onProgress?.(`[runpod] re-attaching to existing job ${opts.existingJobId} (no /run)`);
  } else {
    const startRes = await fetch(`${RUNPOD_API}/${creds.endpointId}/run`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: opts.payload }),
    });
    if (!startRes.ok) {
      const t = await startRes.text().catch(() => '');
      throw new Error(`RunPod /run ${startRes.status}: ${t.slice(0, 300)}`);
    }
    startJson = await startRes.json() as RunPodStartResponse;
    if (!startJson.id) {
      throw new Error(`RunPod /run returned no job id: ${JSON.stringify(startJson).slice(0, 300)}`);
    }
  }
  opts.onJobStart?.(startJson.id);
  opts.onProgress?.(`[runpod] job ${startJson.id} queued`);

  // --- Log poller --------------------------------------------------
  // Container writes every stderr line into runpod_job_logs (in the
  // pgvector DB) tagged with this job id. We poll that table on a
  // separate loop so the dispatcher's status-poll cadence (1–10s) and
  // the log-fetch cadence (3s) can run independently. Anything new
  // since `lastLogId` gets handed to onProgress — same machinery the
  // CPU subprocess path uses for stderr line ingestion.
  let lastLogId = 0;
  let logPollerStopped = false;
  async function logPoller() {
    while (!logPollerStopped) {
      try {
        const rows = await fetchRunpodLogs(startJson.id, lastLogId, 500);
        for (const r of rows) {
          opts.onProgress?.(r.line);
          if (r.id > lastLogId) lastLogId = r.id;
        }
      } catch (e) {
        // Best-effort — don't let log polling kill the dispatcher.
        // The status-loop is the source of truth for completion.
        console.warn('[runpod] log poller error:', (e as Error).message);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  // Fire and forget — completes when logPollerStopped flips true.
  const logPollerPromise = logPoller();

  // --- Poll loop ---------------------------------------------------
  // Start aggressive (1s) to catch fast jobs cheaply; back off to 10s
  // once we've waited ~30s — keeps RunPod API request count under the
  // free quota for typical 5–30 min runs.
  let intervalMs = 1000;
  let lastStatus: string | null = null;
  try {
  while (true) {
    if (Date.now() > deadline) {
      throw new Error(`RunPod job ${startJson.id} exceeded timeout of ${timeoutMs}ms`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
    if (intervalMs < 10000) intervalMs = Math.min(intervalMs * 2, 10000);

    const statusRes = await fetch(`${RUNPOD_API}/${creds.endpointId}/status/${startJson.id}`, {
      headers: { 'Authorization': `Bearer ${creds.apiKey}` },
    });
    if (!statusRes.ok) {
      // A 404 on a RESUMED job means RunPod has aged the (already
      // terminal) job off its status store — the common case when a
      // redeploy re-attaches AFTER the job had already COMPLETED. The
      // real result was staged to runpod_job_results regardless, so
      // recover it directly instead of looping forever on a /status
      // that will never come back. Fresh dispatches never 404 here, so
      // this only fires on the boot re-attach path.
      if (statusRes.status === 404 && opts.existingJobId) {
        const staged = await fetchRunpodResult(startJson.id);
        if (staged) {
          opts.onProgress?.(`[runpod] /status 404 but staged result present in runpod_job_results — job completed before re-attach, recovering result`);
          logPollerStopped = true;
          await logPollerPromise.catch(() => { /* swallow */ });
          return {
            jobId: startJson.id,
            delayMs: 0,
            executionMs: 0,
            result: staged,
          };
        }
        // No staged row yet → either the 404 was transient (job still
        // mid-flight) or it died without staging. Fall through to retry;
        // the deadline guard bounds how long we wait.
      }
      // Transient — don't kill the whole run on a single 5xx. Surface
      // it though, so operator sees if we're stuck.
      opts.onProgress?.(`[runpod] /status ${statusRes.status} — retrying`);
      continue;
    }
    const status = await statusRes.json() as RunPodStatusResponse;

    if (status.status !== lastStatus) {
      opts.onProgress?.(`[runpod] status → ${status.status}`);
      lastStatus = status.status;
    }

    if (status.status === 'COMPLETED') {
      // Final drain — the container's PgLogSink batches with ~500ms
      // latency, so trailing lines may not be in the table at the
      // moment /status flips. One last poll + 200ms breathing room
      // catches them.
      logPollerStopped = true;
      await new Promise(r => setTimeout(r, 200));
      try {
        const rows = await fetchRunpodLogs(startJson.id, lastLogId, 500);
        for (const r of rows) opts.onProgress?.(r.line);
      } catch { /* best-effort drain */ }
      await logPollerPromise.catch(() => { /* swallow */ });

      if (!status.output || typeof status.output !== 'object') {
        throw new Error(`RunPod job ${startJson.id} completed without output`);
      }
      let out = status.output as Record<string, unknown>;
      if (out.error) {
        throw new Error(`RunPod handler error: ${String(out.error).slice(0, 400)}`);
      }
      // PG-staging indirection: when the container's result exceeded
      // RunPod's ~20 MB /status output cap, it wrote the real result
      // to runpod_job_results and returned a pointer here. Fetch the
      // real result from PG. Small results (under the threshold)
      // flow through `out` unchanged.
      if (out.result_via_pg === true && typeof out.job_id === 'string') {
        opts.onProgress?.(`[runpod] result was PG-staged (${out.size_bytes} bytes), fetching from runpod_job_results`);
        const staged = await fetchRunpodResult(out.job_id);
        if (!staged) {
          throw new Error(`RunPod job ${startJson.id} reported PG-staged result but row not found in runpod_job_results`);
        }
        out = staged;
      }
      return {
        jobId: startJson.id,
        delayMs: status.delayTime ?? 0,
        executionMs: status.executionTime ?? 0,
        result: out,
      };
    }
    if (status.status === 'FAILED' || status.status === 'CANCELLED' || status.status === 'TIMED_OUT') {
      logPollerStopped = true;
      await logPollerPromise.catch(() => { /* swallow */ });
      throw new Error(
        `RunPod job ${startJson.id} ended ${status.status}: ${String(status.error || status.output || '').slice(0, 400)}`,
      );
    }
    // IN_QUEUE / IN_PROGRESS → keep polling
  }
  } finally {
    // Ensure the log poller is stopped on ANY exit path (timeout
    // throw, completion, etc.) — otherwise it'd run forever on the
    // detached promise.
    logPollerStopped = true;
  }
}

/** Dispatch the combined L1+L2 bake to the RunPod worker. The handler
 *  there runs L1 first, then iterates qualifying L1 clusters to bake
 *  L2 inside the same container session — single cold start covers
 *  the whole tree refresh. */
export async function dispatchGlobalBakeToRunPod(opts: {
  creds: RunPodCreds;
  dbUrl: string;
  source: string;
  videoIds: number[];
  l1: {
    minClusterSize: number;
    minSamples: number;
    umapDims: number;
    nNeighbors?: number;
    outlierIqrMult?: number;
  };
  l2: {
    minParentSize?: number;        // default 50 — matches Node L2 eligibility
    minClusterSize?: number;       // null → derived per parent inside the container
    minSamples?: number;
    umapDims?: number;
    nNeighbors?: number;
    outlierIqrMult?: number;
  };
  timeoutMs?: number;
  /** RESUME: re-attach to this already-running RunPod job (skip /run dispatch).
   *  The boot re-attach passes this so a redeploy mid-bake resumes instead of orphaning. */
  resumeJobId?: string;
  onJobStart?: (jobId: string) => void;
  onProgress?: (msg: string) => void;
}): Promise<GlobalBakeResult> {
  const payload: Record<string, unknown> = {
    mode: 'global_bake',
    db_url: opts.dbUrl,
    source: opts.source,
    l1: {
      video_ids:        opts.videoIds,
      min_cluster_size: opts.l1.minClusterSize,
      min_samples:      opts.l1.minSamples,
      umap_dims:        opts.l1.umapDims,
      n_neighbors:      opts.l1.nNeighbors ?? 5,
      outlier_iqr_mult: opts.l1.outlierIqrMult ?? 3.0,
    },
    l2: {
      min_parent_size:  opts.l2.minParentSize ?? 50,
      min_cluster_size: opts.l2.minClusterSize,
      min_samples:      opts.l2.minSamples,
      umap_dims:        opts.l2.umapDims ?? opts.l1.umapDims,
      n_neighbors:      opts.l2.nNeighbors ?? opts.l1.nNeighbors ?? 5,
      outlier_iqr_mult: opts.l2.outlierIqrMult ?? opts.l1.outlierIqrMult ?? 3.0,
    },
  };

  const dispatch = await dispatchClusterToRunPod(opts.creds, {
    payload,
    existingJobId: opts.resumeJobId,   // RESUME: poll the live job instead of /run
    // Combined runs are LONG — a fine minClusterSize=30 bake over the full corpus
    // streams hours of vectors then fans out deep L2 (1178 @531K ran ~7h; bigger
    // corpora run longer). 24h ceiling so a big run is never orphaned by a too-tight
    // Node poll; the RunPod job is the source of truth and the boot re-attach resumes
    // polling across any restart anyway, so a generous ceiling costs nothing.
    timeoutMs: opts.timeoutMs ?? 24 * 60 * 60 * 1000,
    onJobStart: opts.onJobStart,
    onProgress: opts.onProgress,
  });

  const r = dispatch.result as {
    l1?: Record<string, unknown>;
    l2?: {
      by_parent_cluster_index?: Record<string, Record<string, unknown>>;
      baked?: number;
      skipped_small?: number;
      errors?: number;
      error_details?: Array<{ parent_cluster_index: number; error: string; stderr_tail?: string }>;
    };
    error?: string;
  };
  if (r.error) throw new Error(`global_bake handler error: ${String(r.error).slice(0, 400)}`);
  if (!r.l1) throw new Error('global_bake response missing l1 result');

  return {
    jobId: dispatch.jobId,
    delayMs: dispatch.delayMs,
    executionMs: dispatch.executionMs,
    l1: r.l1,
    l2ByParent: r.l2?.by_parent_cluster_index ?? {},
    l2Skipped: r.l2?.skipped_small ?? 0,
    l2Errors:  r.l2?.errors ?? 0,
    l2ErrorDetails: r.l2?.error_details ?? [],
  };
}
