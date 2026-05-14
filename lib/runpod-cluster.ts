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

  // --- POST /run ---------------------------------------------------
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
  const startJson = await startRes.json() as RunPodStartResponse;
  if (!startJson.id) {
    throw new Error(`RunPod /run returned no job id: ${JSON.stringify(startJson).slice(0, 300)}`);
  }
  opts.onJobStart?.(startJson.id);
  opts.onProgress?.(`[runpod] job ${startJson.id} queued`);

  // --- Poll loop ---------------------------------------------------
  // Start aggressive (1s) to catch fast jobs cheaply; back off to 10s
  // once we've waited ~30s — keeps RunPod API request count under the
  // free quota for typical 5–30 min runs.
  let intervalMs = 1000;
  let lastStatus: string | null = null;
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
      if (!status.output || typeof status.output !== 'object') {
        throw new Error(`RunPod job ${startJson.id} completed without output`);
      }
      const out = status.output as Record<string, unknown>;
      if (out.error) {
        throw new Error(`RunPod handler error: ${String(out.error).slice(0, 400)}`);
      }
      return {
        jobId: startJson.id,
        delayMs: status.delayTime ?? 0,
        executionMs: status.executionTime ?? 0,
        result: out,
      };
    }
    if (status.status === 'FAILED' || status.status === 'CANCELLED' || status.status === 'TIMED_OUT') {
      throw new Error(
        `RunPod job ${startJson.id} ended ${status.status}: ${String(status.error || status.output || '').slice(0, 400)}`,
      );
    }
    // IN_QUEUE / IN_PROGRESS → keep polling
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
    // Combined runs are longer — default 3h instead of 90 min.
    timeoutMs: opts.timeoutMs ?? 3 * 60 * 60 * 1000,
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
