import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { getRunPodCreds, getExternalVectorDbUrl, dispatchClusterToRunPod } from '@/lib/runpod-cluster';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * POST /api/admin/tools/gpu-cluster-test  { limit?, minClusterSize? }
 *
 * End-to-end sanity check for the GPU cluster pipeline. Bypasses the
 * niche-tree DB orchestration entirely — just dispatches a single
 * mode='cluster' call to the RunPod worker with a small video_ids
 * scope, polls status, and returns the runtime metadata plus
 * num_clusters / num_noise so the operator can confirm the path works.
 *
 *   1. Pull `limit` random combined_v2-embedded video IDs
 *   2. Dispatch to RunPod with cuML params suitable for the small scope
 *   3. Poll /status until COMPLETED (poll loop lives in the dispatcher)
 *   4. Return summary
 *
 * Side effects: NONE — no PG writes, no niche_tree_runs row, no
 * stitching, no labels. Pure path validation.
 *
 * Use this before committing to a full ~60–90 min GPU bake to verify:
 *   - RunPod worker boots (warm cache after the first cold pull)
 *   - cuML imports work
 *   - container can reach Railway PG (VECTOR_DB_URL must be
 *     publicly-reachable from external networks)
 *   - UMAP + HDBSCAN actually run + return the expected JSON shape
 *
 * GET = state of the most recent test (also returns the env we'd send
 *       so the operator can sanity-check VECTOR_DB_URL is set).
 */

interface TestState {
  startedAt: string | null;
  finishedAt: string | null;
  running: boolean;
  jobId: string | null;
  videoIds: number;
  source: string;
  result: {
    num_clusters?: number;
    num_noise?: number;
    runtime?: Record<string, unknown>;
  } | null;
  error: string | null;
  delayMs: number | null;
  executionMs: number | null;
  /** Every line the dispatcher's onProgress callback fires — RunPod
   *  status transitions ("[runpod] status → ...") and (now) every
   *  [cluster] / [bake] line the container streams via the PG log
   *  sink. Used to verify the log-streaming path end-to-end without
   *  having to grep Railway service logs. */
  logs: string[];
}

// Module-scoped state lets a single GET poll the in-flight test from
// the admin UI side without re-triggering a new dispatch.
let state: TestState = {
  startedAt: null, finishedAt: null, running: false, jobId: null,
  videoIds: 0, source: 'combined_v2', result: null, error: null,
  delayMs: null, executionMs: null, logs: [],
};
let inFlight = false;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const resolved = await getExternalVectorDbUrl();
  return NextResponse.json({
    ...state,
    env: {
      // Surface only the hostname so the operator can verify
      // reachability without leaking credentials. *.railway.internal
      // = not reachable from RunPod; need a *.proxy.rlwy.net or
      // similar public hostname.
      vector_db_url_resolved: !!resolved,
      vector_db_url_host:     resolved ? new URL(resolved).hostname : null,
      // Show which source contributed.
      from_admin_config:      !!(await (async () => {
        const r = await (await getPool()).query("SELECT value FROM admin_config WHERE key = 'vector_db_url_external'");
        return r.rows[0]?.value;
      })()),
    },
  });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (inFlight) {
    return NextResponse.json({ ok: false, reason: 'already_running', state });
  }

  const body = await req.json().catch(() => ({})) as {
    limit?: number;
    minClusterSize?: number;
    minSamples?: number;
    umapDims?: number;
  };
  const limit = Math.min(parseInt(String(body.limit ?? 5000)) || 5000, 20000);
  const minClusterSize = parseInt(String(body.minClusterSize ?? 50)) || 50;
  const minSamples = parseInt(String(body.minSamples ?? 10)) || 10;
  const umapDims = parseInt(String(body.umapDims ?? 50)) || 50;

  const vectorDbUrl = await getExternalVectorDbUrl();
  if (!vectorDbUrl) {
    return NextResponse.json({
      ok: false,
      error: 'No DB URL resolved (set admin_config.vector_db_url_external to a publicly-reachable Railway pgvector hostname)',
    }, { status: 500 });
  }
  // Guard against the common footgun: pasting the internal URL,
  // which the container will fail to resolve.
  if (vectorDbUrl.includes('.railway.internal')) {
    return NextResponse.json({
      ok: false,
      error: 'Resolved DB URL is a Railway internal hostname (*.railway.internal). RunPod containers cannot reach it. Set admin_config.vector_db_url_external to the public/proxy URL.',
      host: new URL(vectorDbUrl).hostname,
    }, { status: 400 });
  }

  const creds = await getRunPodCreds();
  if (!creds) {
    return NextResponse.json({
      ok: false,
      error: 'admin_config.runpod_api_key or .runpod_cluster_endpoint_id missing',
    }, { status: 500 });
  }

  // Sample a random `limit` embedded video IDs. random() instead of
  // ORDER BY id DESC so we get representative coverage of the corpus,
  // not just the most recent batch.
  const pool = await getPool();
  const idsRes = await pool.query<{ id: number }>(
    `SELECT id FROM niche_spy_videos
      WHERE combined_embedded_v2_at IS NOT NULL
      ORDER BY random()
      LIMIT $1`,
    [limit],
  );
  const videoIds = idsRes.rows.map(r => r.id);
  if (videoIds.length < 100) {
    return NextResponse.json({
      ok: false,
      error: `Not enough embedded rows (${videoIds.length}); need at least 100 to test`,
    }, { status: 400 });
  }

  inFlight = true;
  state = {
    startedAt:  new Date().toISOString(),
    finishedAt: null,
    running:    true,
    jobId:      null,
    videoIds:   videoIds.length,
    source:     'combined_v2',
    result:     null,
    error:      null,
    delayMs:    null,
    executionMs: null,
    logs:       [],
  };

  // Fire and forget — the dispatcher's poll loop runs in this async
  // closure and updates `state` as it goes.
  (async () => {
    try {
      const r = await dispatchClusterToRunPod(creds, {
        payload: {
          db_url:           vectorDbUrl,
          source:           'combined_v2',
          video_ids:        videoIds,
          keyword:          '__gpu_test__',
          min_cluster_size: minClusterSize,
          min_samples:      minSamples,
          umap_dims:        umapDims,
          compute_2d:       false,
          outlier_iqr_mult: 3.0,
        },
        timeoutMs: 15 * 60 * 1000, // 15 min cap — anything longer means something's wrong for a 5k test.
        onJobStart: (jid) => { state.jobId = jid; },
        onProgress: (msg) => {
          console.log(`[gpu-test] ${msg}`);
          // Append to in-memory state so a GET can verify the full
          // log stream after the run. Cap at 1000 lines for safety.
          state.logs.push(msg);
          if (state.logs.length > 1000) state.logs.splice(0, state.logs.length - 1000);
        },
      });
      const out = r.result as { num_clusters?: number; num_noise?: number; runtime?: Record<string, unknown> };
      state.result = {
        num_clusters: out.num_clusters,
        num_noise:    out.num_noise,
        runtime:      out.runtime,
      };
      state.delayMs = r.delayMs;
      state.executionMs = r.executionMs;
    } catch (err) {
      state.error = (err as Error).message?.slice(0, 600) || 'unknown';
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      inFlight = false;
    }
  })();

  return NextResponse.json({ ok: true, started: true, sample: videoIds.length });
}
