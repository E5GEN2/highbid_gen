/**
 * Niche Tree — hierarchical global clustering.
 *
 * Phase 1 (this file): Level-1 global clustering. Run HDBSCAN on the
 * entire embedded video set (across all keywords) with a relatively
 * large `min_cluster_size` so we end up with broad parent niches like
 * "Personal Development", "ASMR", "Conspiracy".
 *
 * Phase 2 (later): subdivide a chosen L1 cluster into L2 sub-niches by
 * running HDBSCAN again on just that cluster's videos with smaller
 * params. Same code path, different inputs — no extra Python script.
 *
 * The Python clustering script (scripts/cluster-niches.py) is reused
 * verbatim. It already accepts `video_ids` as input and outputs
 * assignments + closest-to-centroid representatives; this file just
 * stages the inputs, calls the script, and writes the results to
 * niche_tree_* tables. Sandboxed away from the per-keyword pipeline
 * (lib/clustering.ts + niche_clusters/niche_cluster_assignments) so we
 * can iterate without touching production.
 */

import { getPool } from './db';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

/** Upload-heartbeat bucket count. 52 weekly buckets = 1 year of
 *  history. Index 0 = 51 weeks ago, index 51 = current week. */
export const HISTOGRAM_WEEKS = 52;
function zeroHistogram(): number[] { return new Array(HISTOGRAM_WEEKS).fill(0); }

/**
 * Compute weekly upload counts per cluster over the last
 * HISTOGRAM_WEEKS weeks. Scope can be one global L1 run (all clusters
 * in that run) OR an explicit cluster id list. Returns a Map keyed
 * by cluster_id; missing clusters → undefined; missing weeks within
 * a cluster's array → 0.
 */
async function fetchUploadHistograms(
  pool: import('pg').Pool,
  scope: { runId: number } | { clusterIds: number[] },
): Promise<Map<number, number[]>> {
  const histByCluster = new Map<number, number[]>();
  let sql: string;
  let params: (number | number[])[];
  if ('runId' in scope) {
    sql = `
      SELECT a.cluster_id,
             FLOOR(EXTRACT(EPOCH FROM (NOW() - v.posted_at)) / 604800)::int AS weeks_ago,
             COUNT(*)::int AS cnt
        FROM niche_tree_assignments a
        JOIN niche_spy_videos v ON v.id = a.video_id
        JOIN niche_tree_clusters c ON c.id = a.cluster_id
       WHERE c.run_id = $1
         AND v.posted_at IS NOT NULL
         AND v.posted_at > NOW() - INTERVAL '${HISTOGRAM_WEEKS} weeks'
    GROUP BY a.cluster_id, weeks_ago`;
    params = [scope.runId];
  } else {
    if (scope.clusterIds.length === 0) return histByCluster;
    sql = `
      SELECT a.cluster_id,
             FLOOR(EXTRACT(EPOCH FROM (NOW() - v.posted_at)) / 604800)::int AS weeks_ago,
             COUNT(*)::int AS cnt
        FROM niche_tree_assignments a
        JOIN niche_spy_videos v ON v.id = a.video_id
       WHERE a.cluster_id = ANY($1::int[])
         AND v.posted_at IS NOT NULL
         AND v.posted_at > NOW() - INTERVAL '${HISTOGRAM_WEEKS} weeks'
    GROUP BY a.cluster_id, weeks_ago`;
    params = [scope.clusterIds];
  }

  const r = await pool.query<{ cluster_id: number; weeks_ago: number; cnt: number }>(sql, params);
  for (const row of r.rows) {
    const wAgo = row.weeks_ago;
    if (wAgo < 0 || wAgo >= HISTOGRAM_WEEKS) continue;
    let arr = histByCluster.get(row.cluster_id);
    if (!arr) { arr = zeroHistogram(); histByCluster.set(row.cluster_id, arr); }
    // weeks_ago=0 (current week) lands at the rightmost slot.
    arr[HISTOGRAM_WEEKS - 1 - wAgo] = row.cnt;
  }
  return histByCluster;
}

export interface ClusterOpportunity {
  sample: number;
  nos: number;
  nosDisplay: number;
  topLeftPct: number;
  newcomerRate: number;
  lowSubCeiling: number;
}

/** Min sample size for the indicators to be meaningful — under this
 *  the medians/percentiles are too noisy to trust, so we return
 *  null and the card shows dimmed placeholder pills instead. */
const OPPORTUNITY_MIN_SAMPLE = 10;
const OPPORTUNITY_MIN_SCORE = 80;

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/**
 * Compute the 4 opportunity indicators (NOS, top-left density,
 * newcomer success, low-sub ceiling) for every cluster in scope in a
 * single bulk SQL pass + JS aggregation. Same math as
 * components/OpportunityIndicators.tsx → computeIndicators(), just
 * grouped by cluster_id and pre-filtered to score ≥ 80 (matches the
 * Insights tab default).
 *
 * Scope mirrors fetchUploadHistograms: a global L1 run id (every
 * cluster in that run) or an explicit list of cluster ids.
 */
export async function fetchClusterOpportunities(
  pool: import('pg').Pool,
  scope: { runId: number } | { clusterIds: number[] },
): Promise<Map<number, ClusterOpportunity>> {
  const out = new Map<number, ClusterOpportunity>();
  let sql: string;
  let params: (number | number[])[];

  // Pull every (cluster, video) row with subs + views populated for
  // high-score videos. Channel age is computed on the JS side from
  // first_upload_at / channel_created_at to match what the keyword
  // version does — JOIN the channels table to get first_upload_at.
  if ('runId' in scope) {
    sql = `
      SELECT a.cluster_id,
             v.subscriber_count AS subs,
             v.view_count       AS views,
             v.channel_created_at,
             c.first_upload_at
        FROM niche_tree_assignments a
        JOIN niche_spy_videos    v ON v.id = a.video_id
        JOIN niche_tree_clusters tc ON tc.id = a.cluster_id
        LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
       WHERE tc.run_id = $1
         AND v.score >= ${OPPORTUNITY_MIN_SCORE}
         AND v.subscriber_count IS NOT NULL AND v.subscriber_count > 0
         AND v.view_count       IS NOT NULL AND v.view_count > 0`;
    params = [scope.runId];
  } else {
    if (scope.clusterIds.length === 0) return out;
    sql = `
      SELECT a.cluster_id,
             v.subscriber_count AS subs,
             v.view_count       AS views,
             v.channel_created_at,
             c.first_upload_at
        FROM niche_tree_assignments a
        JOIN niche_spy_videos v ON v.id = a.video_id
        LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
       WHERE a.cluster_id = ANY($1::int[])
         AND v.score >= ${OPPORTUNITY_MIN_SCORE}
         AND v.subscriber_count IS NOT NULL AND v.subscriber_count > 0
         AND v.view_count       IS NOT NULL AND v.view_count > 0`;
    params = [scope.clusterIds];
  }

  type Dot = { s: number; v: number; a: number | null };
  const byCluster = new Map<number, Dot[]>();
  const r = await pool.query<{
    cluster_id: number; subs: string; views: string;
    channel_created_at: Date | null; first_upload_at: Date | null;
  }>(sql, params);
  for (const row of r.rows) {
    const subs = parseInt(row.subs);
    const views = parseInt(row.views);
    if (!Number.isFinite(subs) || !Number.isFinite(views) || subs <= 0 || views <= 0) continue;
    // Active age first (channel's first upload), fall back to creation.
    const active = row.first_upload_at ? Math.floor((Date.now() - new Date(row.first_upload_at).getTime()) / 86400000) : null;
    const created = row.channel_created_at ? Math.floor((Date.now() - new Date(row.channel_created_at).getTime()) / 86400000) : null;
    const a = active ?? created;
    const arr = byCluster.get(row.cluster_id) || [];
    arr.push({ s: subs, v: views, a });
    byCluster.set(row.cluster_id, arr);
  }

  for (const [clusterId, dots] of byCluster) {
    if (dots.length < OPPORTUNITY_MIN_SAMPLE) continue;

    // 1. NOS — median(log(views) / log(max(subs, 10)))
    const ratios = dots.map(d => Math.log10(d.v) / Math.log10(Math.max(d.s, 10)));
    const nos = median(ratios);
    const nosDisplay = Math.round(Math.max(0, Math.min(100, ((nos - 0.5) / 2.0) * 100)));

    // 2. Top-Left density — % of videos with views > median AND subs < median
    const medViews = median(dots.map(d => d.v));
    const medSubs  = median(dots.map(d => d.s));
    const topLeft  = dots.filter(d => d.v > medViews && d.s < medSubs).length;
    const topLeftPct = Math.round((topLeft / dots.length) * 100);

    // 3. Newcomer success — median(views|<180d) / median(views|all)
    const newDots = dots.filter(d => d.a !== null && d.a < 180);
    const newMed = median(newDots.map(d => d.v));
    const newcomerRate = medViews > 0 ? Math.round((newMed / medViews) * 100) : 0;

    // 4. Low-sub ceiling — p90(views|subs<10K)
    const small = dots.filter(d => d.s < 10000);
    const lowSubCeiling = percentile(small.map(d => d.v), 90);

    out.set(clusterId, {
      sample: dots.length, nos, nosDisplay, topLeftPct, newcomerRate, lowSubCeiling,
    });
  }
  return out;
}


// ─────────────────────────────────────────────────────────────────
// Cancel support
//
// Active Python child processes are held here, keyed by the run id
// that owns them. Concurrency policy means there's at most one entry
// at any time, but we treat it as a map for clarity.
//
// `cancelledL1Runs` holds the L1 run ids the user has actively
// cancelled. The L2 baking loop checks this set between iterations
// and breaks out without firing the next subdivide. All DB writes
// inside the pipeline are guarded with `WHERE status='running'` so
// the cancel-time error state isn't overwritten by a late status
// update racing in from the streaming code.
// ─────────────────────────────────────────────────────────────────
const activePyProcesses = new Map<number, ChildProcess>();
const cancelledL1Runs = new Set<number>();

/** Stages a global clustering run progresses through, in order. */
export const TREE_STAGES = [
  'starting',
  'fetching',      // Python: pulling embeddings + building feature matrix
  'umap_cluster',  // Python: UMAP NND -> umap_dims (the long one)
  'hdbscan',       // Python: HDBSCAN
  'labeling',      // Python: TF-IDF auto-labels
  'writing',       // Node: inserting clusters + assignments to DB
  'baking_l2',     // Node: chained per-cluster subdivides for L2 children
  'done',
] as const;
export type TreeStage = (typeof TREE_STAGES)[number];

/**
 * Progress on the L2 baking phase. Surfaces both the overall counts
 * and the currently-running subdivide so the UI can render per-card
 * status chips on the L1 grid while the tree builds.
 */
export interface TreeBakeL2Progress {
  total: number;          // L1 clusters eligible for subdivide (≥50 videos)
  completed: number;      // subdivides finished successfully
  skipped: number;        // L1 clusters skipped because too small
  failed: number;         // subdivides that errored
  currentParentId: number | null;
  currentParentLabel: string | null;
  currentSubrunId: number | null;     // niche_tree_runs.id of the active subdivide
}

export interface TreeProgress {
  stage: TreeStage;
  startedAt: string;          // run start
  stageStartedAt: string;     // current stage start
  stagesElapsedMs: Partial<Record<TreeStage, number>>; // per-stage durations once finished
  recentLogs: string[];       // last 12 lines of stderr for transparency
  numClusters?: number;       // populated as soon as HDBSCAN reports
  numNoise?: number;
  l2?: TreeBakeL2Progress;    // populated once stage transitions to 'baking_l2'
}

/** Persist a partial progress update without overwriting unrelated fields. */
async function writeProgress(runId: number, patch: Partial<TreeProgress> & { stage?: TreeStage }) {
  const pool = await getPool();
  // jsonb_set per field would be cleaner but we already hold the full
  // object in memory in the caller, so just overwrite. Concurrent writers
  // aren't a concern — only one streaming reader writes per run.
  await pool.query(
    `UPDATE niche_tree_runs
       SET progress = COALESCE(progress, '{}'::jsonb) || $1::jsonb
       WHERE id = $2`,
    [JSON.stringify(patch), runId],
  ).catch(() => {});
}

// 'combined' (legacy) was the title_v2 + thumbnail_v2 vectors concatenated
// (6144D) at the python side. 'combined_v2' is the new joint multimodal
// embedding from gemini-embedding-2-preview — title and thumbnail packed
// into one content with two parts, encoded jointly into a single 3072D
// vector. combined_v2 is now the preferred source.
export type TreeSource = 'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined' | 'combined_v2';

const SOURCE_FILTER: Record<TreeSource, string> = {
  title_v1:      'title_embedding IS NOT NULL',
  title_v2:      'title_embedding_v2 IS NOT NULL',
  thumbnail_v2:  'thumbnail_embedding_v2 IS NOT NULL',
  combined:      'title_embedding_v2 IS NOT NULL AND thumbnail_embedding_v2 IS NOT NULL',
  combined_v2:   'combined_embedding_v2 IS NOT NULL',
};

export interface TreeClusterParams {
  /** L1 default ~80; smaller min_cluster_size = more, smaller niches */
  minClusterSize?: number;
  minSamples?: number;
  /** UMAP target dim for the reduced space HDBSCAN runs on. 50 mirrors lib/clustering.ts default. */
  umapDims?: number;
  minScore?: number;
  source?: TreeSource;
}

export interface TreeRun {
  id: number;
  kind: 'global' | 'subdivide';
  parentClusterId: number | null;
  level: number;
  source: TreeSource;
  status: 'running' | 'done' | 'error';
  params: Record<string, unknown>;
  numClusters: number;
  numNoise: number;
  totalVideos: number;
  /**
   * Live count of assignment rows with cluster_id != NULL for this run.
   * Drifts from numClusters * avg(video_count) after cleanup or cascade
   * passes; computed on read so it always matches the assignments table.
   * Optional because subdivide runs / older payloads don't carry it.
   */
  numAssigned?: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface TreeCluster {
  id: number;
  runId: number;
  parentClusterId: number | null;
  level: number;
  clusterIndex: number;
  autoLabel: string | null;
  aiLabel: string | null;
  label: string | null;
  videoCount: number;
  avgScore: number | null;
  avgViews: number | null;
  totalViews: number | null;
  topChannels: string[];
  representativeVideoId: number | null;
  centroid2d: number[] | null;
}

/**
 * Internal helper: runs ONE clustering pipeline (Python + DB writes)
 * against a given video subset, writing results into the supplied run id
 * with the supplied parent_cluster_id + level.
 *
 * Used by both:
 *   - runGlobalClusteringJob — videoIds = every embedded video,
 *     parentClusterId = null, level = 1
 *   - runSubdivideClusteringJob (and the in-process L2 baking loop) —
 *     videoIds = a parent cluster's videos, parentClusterId = parent.id,
 *     level = parent.level + 1
 *
 * Stage progress is written to the supplied runId. Caller is expected
 * to mark status='done' (or perform additional orchestration like L2
 * baking) AFTER this returns successfully.
 */
async function runOneClusteringPipeline(opts: {
  runId: number;
  source: TreeSource;
  videoIds: number[];
  parentClusterId: number | null;
  level: number;
  minClusterSize: number;
  minSamples: number;
  umapDims: number;
  /**
   * Tukey-fence multiplier for per-cluster outlier cleanup (Q3 + k*IQR).
   * 0 disables cleanup, 3.0 is the default — lenient enough to keep
   * legitimate cluster-edge members, strict enough to demote clear
   * misclassifications back to noise. See cluster-niches.py.
   */
  outlierIqrMult?: number;
  scriptKeyword: string;     // sentinel for Python's logging/labeling path
  pyTimeoutMs?: number;      // default 90 min
}): Promise<
  | { ok: true; numClusters: number; numNoise: number; insertedClusterIds: number[] }
  | { ok: false; error: string }
> {
  const pool = await getPool();
  const vectorDbUrl = process.env.VECTOR_DB_URL;
  if (!vectorDbUrl) {
    return { ok: false, error: 'VECTOR_DB_URL env var is required (use the Railway internal hostname to avoid egress charges)' };
  }

  const tmpFile = path.join(os.tmpdir(), `cluster-tree-${opts.runId}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({
    db_url: vectorDbUrl,
    keyword: opts.scriptKeyword,
    video_ids: opts.videoIds,
    source: opts.source,
    min_cluster_size: opts.minClusterSize,
    min_samples:      opts.minSamples,
    umap_dims:        opts.umapDims,
    compute_2d:       false,
    outlier_iqr_mult: opts.outlierIqrMult ?? 3.0,
  }));

  const startedAt = new Date().toISOString();
  let currentStage: TreeStage = 'starting';
  let stageStartedAt = startedAt;
  const stagesElapsedMs: Partial<Record<TreeStage, number>> = {};
  const recentLogs: string[] = [];

  await writeProgress(opts.runId, {
    stage: currentStage,
    startedAt,
    stageStartedAt,
    stagesElapsedMs: {},
    recentLogs: [],
  });

  const transitionTo = async (next: TreeStage, extra?: Partial<TreeProgress>) => {
    if (next === currentStage) return;
    const now = new Date();
    stagesElapsedMs[currentStage] = now.getTime() - new Date(stageStartedAt).getTime();
    currentStage = next;
    stageStartedAt = now.toISOString();
    await writeProgress(opts.runId, {
      stage: currentStage,
      stageStartedAt,
      stagesElapsedMs: { ...stagesElapsedMs },
      recentLogs: [...recentLogs],
      ...extra,
    });
  };

  const detectStage = (line: string): TreeStage | null => {
    if (/\[cluster\] X shape=/.test(line))                 return 'umap_cluster';
    if (/\[cluster\] UMAP \d+D -> \d+D done/.test(line))   return 'hdbscan';
    if (/\[cluster\] HDBSCAN:/.test(line))                 return 'labeling';
    return null;
  };

  try {
    const py = spawn('python3', [
      path.join(SCRIPTS_DIR, 'cluster-niches.py'), tmpFile,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    activePyProcesses.set(opts.runId, py);
    const timer = setTimeout(() => py.kill('SIGTERM'), opts.pyTimeoutMs ?? 5_400_000);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBuf = '';

    py.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    py.stderr.on('data', async (c: Buffer) => {
      stderrChunks.push(c);
      stderrBuf += c.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        recentLogs.push(line);
        if (recentLogs.length > 12) recentLogs.shift();

        const next = detectStage(line);
        if (next) {
          if (currentStage === 'starting' && next !== 'fetching') {
            stagesElapsedMs['fetching'] = Date.now() - new Date(stageStartedAt).getTime();
            currentStage = 'fetching';
            stageStartedAt = new Date().toISOString();
          }
          let extra: Partial<TreeProgress> | undefined;
          const m = /\[cluster\] HDBSCAN:\s*(\d+)\s*clusters,\s*(\d+)\s*noise/.exec(line);
          if (m) extra = { numClusters: parseInt(m[1]), numNoise: parseInt(m[2]) };
          await transitionTo(next, extra);
        } else {
          await writeProgress(opts.runId, { recentLogs: [...recentLogs] });
        }
      }
    });

    await transitionTo('fetching');

    const exitCode: number = await new Promise((resolve, reject) => {
      py.on('close', (code) => resolve(code ?? -1));
      py.on('error', reject);
    });
    clearTimeout(timer);
    activePyProcesses.delete(opts.runId);
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }

    const stdout = Buffer.concat(stdoutChunks).toString();
    const stderr = Buffer.concat(stderrChunks).toString();
    if (exitCode !== 0) {
      throw Object.assign(new Error(`python exit ${exitCode}`), {
        stderr, signal: py.signalCode, killed: py.killed,
      });
    }
    if (stderr) console.log(`[niche-tree] run ${opts.runId} stderr tail:`, stderr.slice(-400));

    const result = JSON.parse(stdout);
    if (result.error) {
      return { ok: false, error: result.error };
    }

    await pool.query(
      `UPDATE niche_tree_runs SET num_clusters=$1, num_noise=$2 WHERE id=$3`,
      [result.num_clusters, result.num_noise, opts.runId],
    );
    await transitionTo('writing', {
      numClusters: result.num_clusters,
      numNoise: result.num_noise,
    });

    const insertedClusterIds: number[] = [];

    // Pre-bucket assignments by cluster_index so each cluster's bulk
    // insert is O(n) instead of an O(n²) .filter() per cluster across
    // 100K+ rows. cluster_index === -1 holds noise.
    type Assign = { video_id: number; cluster_index: number; x_2d: number; y_2d: number; distance: number };
    const byClusterIdx = new Map<number, Assign[]>();
    for (const a of result.assignments as Assign[]) {
      const arr = byClusterIdx.get(a.cluster_index);
      if (arr) arr.push(a); else byClusterIdx.set(a.cluster_index, [a]);
    }

    // 7-column multi-row INSERT for assignments. Postgres parameter
    // cap is 65535 ($1..$65535). At 7 params/row we'd hit that at
    // 9362 rows. Cap chunk size at 1000 to stay safely under and to
    // keep memory + result-buffer pressure mild on Railway.
    const ASSIGN_CHUNK = 1000;
    const flushAssignChunk = async (rows: Assign[], clusterId: number | null) => {
      if (rows.length === 0) return;
      const placeholders: string[] = [];
      const params: unknown[] = [];
      for (let i = 0; i < rows.length; i++) {
        const a = rows[i];
        const b = i * 7;
        placeholders.push(`($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7})`);
        params.push(opts.runId, a.video_id, clusterId, a.cluster_index, a.x_2d, a.y_2d, a.distance);
      }
      await pool.query(
        `INSERT INTO niche_tree_assignments
           (run_id, video_id, cluster_id, cluster_index, x_2d, y_2d, distance_to_centroid)
         VALUES ${placeholders.join(', ')}`,
        params,
      );
    };

    // Insert clusters with the caller-provided parent + level. Each
    // cluster row is committed individually (no enclosing transaction)
    // so the live polling UI can render new cards as they land —
    // matches existing UX.
    for (const cluster of result.clusters) {
      const statsRes = await pool.query(
        `SELECT AVG(score) as avg_score, AVG(view_count) as avg_views, SUM(view_count) as total_views
         FROM niche_spy_videos WHERE id = ANY($1)`,
        [cluster.video_ids],
      );
      const stats = statsRes.rows[0];

      const channelRes = await pool.query<{ channel_name: string }>(
        `SELECT channel_name, COUNT(*) as cnt FROM niche_spy_videos
         WHERE id = ANY($1) AND channel_name IS NOT NULL
         GROUP BY channel_name ORDER BY cnt DESC LIMIT 5`,
        [cluster.video_ids],
      );
      const topChannels = channelRes.rows.map(r => r.channel_name);

      const insertRes = await pool.query<{ id: number }>(
        `INSERT INTO niche_tree_clusters
           (run_id, parent_cluster_id, level, cluster_index, auto_label, label, video_count,
            avg_score, avg_views, total_views, top_channels, representative_video_id, centroid_2d)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          opts.runId, opts.parentClusterId, opts.level,
          cluster.cluster_index, cluster.auto_label, cluster.video_count,
          Math.round(parseFloat(stats.avg_score) || 0),
          Math.round(parseFloat(stats.avg_views) || 0),
          Math.round(parseFloat(stats.total_views) || 0),
          topChannels,
          cluster.representative_video_id,
          cluster.centroid_2d,
        ],
      );
      const clusterId = insertRes.rows[0].id;
      insertedClusterIds.push(clusterId);

      // Bulk-insert all this cluster's assignments in chunks. Typical
      // cluster has 100–500 rows, so this is usually a single round
      // trip per cluster instead of N round trips.
      const assigns = byClusterIdx.get(cluster.cluster_index) ?? [];
      for (let off = 0; off < assigns.length; off += ASSIGN_CHUNK) {
        await flushAssignChunk(assigns.slice(off, off + ASSIGN_CHUNK), clusterId);
      }
    }

    // Noise — cluster_id NULL but still attached to the run for counting.
    // Same chunked bulk insert pattern.
    const noise = byClusterIdx.get(-1) ?? [];
    for (let off = 0; off < noise.length; off += ASSIGN_CHUNK) {
      await flushAssignChunk(noise.slice(off, off + ASSIGN_CHUNK), null);
    }

    return {
      ok: true,
      numClusters: result.num_clusters,
      numNoise: result.num_noise,
      insertedClusterIds,
    };
  } catch (err) {
    const e = err as Error & { stderr?: string; signal?: string; killed?: boolean };
    const detail =
      (e.signal ? `[${e.signal}${e.killed ? '/killed' : ''}] ` : '') +
      (e.stderr || '').toString().slice(-3000) +
      (e.message ? `\n${e.message.slice(0, 500)}` : '');
    return { ok: false, error: detail.slice(0, 4000) || 'unknown' };
  } finally {
    // Always release the active-process entry, even on early throws,
    // so cancelRun can never SIGTERM a zombie reference.
    activePyProcesses.delete(opts.runId);
  }
}

/**
 * Cancel a global L1 run in progress. Marks the L1 row as errored
 * with a "Cancelled by user" message, kills any active python child
 * process, and signals the L2 baking loop (if it's running) to stop
 * after the current iteration. All DB writes the running pipeline
 * makes are guarded with `WHERE status='running'`, so the cancel
 * state isn't overwritten by a late update.
 */
export async function cancelGlobalRun(l1RunId: number): Promise<{
  ok: boolean; affectedRow: boolean; error?: string;
}> {
  const pool = await getPool();

  // Flag in-memory so the L2 baking loop can break out before its
  // next iteration spawns another subprocess.
  cancelledL1Runs.add(l1RunId);

  // Mark the L1 row cancelled. Only acts if it's still 'running' —
  // means a no-op race is harmless if the run finished naturally
  // between the user's click and our update.
  const r = await pool.query(
    `UPDATE niche_tree_runs
       SET status = 'error',
           error_message = 'Cancelled by user',
           completed_at = NOW()
       WHERE id = $1 AND status = 'running'
       RETURNING id`,
    [l1RunId],
  );
  const affectedRow = (r.rowCount ?? 0) > 0;

  // Same treatment for any in-flight subdivide whose parent cluster
  // belongs to this L1 run. Cleans up the chained-baking loop's
  // current iteration.
  await pool.query(
    `UPDATE niche_tree_runs
       SET status = 'error',
           error_message = 'Cancelled by user',
           completed_at = NOW()
       WHERE kind = 'subdivide'
         AND status = 'running'
         AND parent_cluster_id IN (SELECT id FROM niche_tree_clusters WHERE run_id = $1)`,
    [l1RunId],
  ).catch(() => {});

  // Kill any active python child processes. There's at most one at a
  // time per the concurrency policy, but iterate defensively.
  for (const [, proc] of activePyProcesses) {
    try { proc.kill('SIGTERM'); } catch { /* ok */ }
  }

  // Drop our cancel flag a few seconds later — by then the loop has
  // checked it and broken out, and we don't want stale entries.
  setTimeout(() => cancelledL1Runs.delete(l1RunId), 30_000);

  return { ok: true, affectedRow };
}

/**
 * Kick off a level-1 global clustering run (fire-and-forget) and chain
 * the L2-baking phase right after. End result: the entire 2-level
 * niche tree is pre-built from one click.
 *
 * Caller is expected to have already inserted the niche_tree_runs row
 * (via POST /api/admin/niche-tree) — we just need its id so we can
 * patch in status/counts as we go and rollback cleanly on error.
 */
export async function runGlobalClusteringJob(runId: number, params: TreeClusterParams): Promise<void> {
  const pool = await getPool();

  try {
    const source: TreeSource = params.source || 'combined_v2';
    const filter = SOURCE_FILTER[source];
    const minScore = params.minScore ?? 0;

    // L1 input: every embedded video meeting the score threshold. No
    // keyword filter — that's the whole point of the global view.
    const eligibleRes = await pool.query<{ id: number }>(
      `SELECT id FROM niche_spy_videos WHERE ${filter} ${minScore > 0 ? 'AND score >= ' + minScore : ''}`,
    );
    const eligibleIds = eligibleRes.rows.map(r => r.id);

    if (eligibleIds.length < 50) {
      await pool.query(
        `UPDATE niche_tree_runs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2`,
        [`Only ${eligibleIds.length} videos with ${source} embeddings. Need at least 50 for global clustering.`, runId],
      );
      return;
    }

    await pool.query(`UPDATE niche_tree_runs SET total_videos=$1, source=$2 WHERE id=$3`,
      [eligibleIds.length, source, runId]).catch(() => {});

    // ── L1 pipeline ─────────────────────────────────────────────
    const l1 = await runOneClusteringPipeline({
      runId,
      source,
      videoIds: eligibleIds,
      parentClusterId: null,
      level: 1,
      minClusterSize: params.minClusterSize || 80,
      minSamples:     params.minSamples     || 10,
      umapDims:       params.umapDims       || 50,
      scriptKeyword:  '__global__',
    });

    if (l1.ok === false) {
      // If the user cancelled the run, the L1 row is already in
      // 'error' state with a "Cancelled by user" message. The
      // status='running' guard makes this a no-op in that case so
      // the cancel reason isn't overwritten.
      await pool.query(
        `UPDATE niche_tree_runs
           SET status='error', error_message=$1, completed_at=NOW()
           WHERE id=$2 AND status='running'`,
        [l1.error, runId],
      );
      return;
    }
    // If cancellation came in mid-L1, the helper exited via SIGTERM
    // and reported ok:false above. If we somehow reached here despite
    // a cancel, bail before starting L2 baking.
    if (cancelledL1Runs.has(runId)) return;

    // ── L2 baking phase ──────────────────────────────────────────
    // After L1 done, run a sub-cluster pass for each L1 cluster with
    // ≥50 videos. Sequential, one at a time. Per-cluster failures
    // don't abort the bake — we count them as `failed` and continue.
    const l1ClustersRes = await pool.query<{
      id: number; video_count: number; cluster_index: number; auto_label: string | null;
    }>(
      `SELECT id, video_count, cluster_index, auto_label
         FROM niche_tree_clusters
         WHERE run_id = $1 AND parent_cluster_id IS NULL
         ORDER BY video_count DESC`,
      [runId],
    );
    const eligibleParents = l1ClustersRes.rows.filter(c => c.video_count >= 50);
    const skippedParents  = l1ClustersRes.rows.length - eligibleParents.length;

    const l2State: TreeBakeL2Progress = {
      total: eligibleParents.length,
      completed: 0,
      skipped: skippedParents,
      failed: 0,
      currentParentId: null,
      currentParentLabel: null,
      currentSubrunId: null,
    };

    // Transition L1 progress to baking_l2 before starting the loop so
    // the UI can render the L2 banner / chips immediately.
    await writeProgress(runId, {
      stage: 'baking_l2',
      stageStartedAt: new Date().toISOString(),
      l2: { ...l2State },
    });

    for (const parent of eligibleParents) {
      // Cancel check — break out before spawning the next subprocess.
      if (cancelledL1Runs.has(runId)) {
        console.log(`[niche-tree] L2 baking cancelled at ${l2State.completed}/${l2State.total}`);
        break;
      }

      // Pull the parent cluster's video IDs from its assignments.
      const subAssignRes = await pool.query<{ video_id: number }>(
        `SELECT video_id FROM niche_tree_assignments WHERE cluster_id = $1`,
        [parent.id],
      );
      const subVideoIds = subAssignRes.rows.map(r => r.video_id);
      if (subVideoIds.length < 50) {
        l2State.skipped++;
        await writeProgress(runId, { l2: { ...l2State } });
        continue;
      }

      // Auto-tune sub min_cluster_size: ~2% of parent size, floor 10.
      const subMinClusterSize = Math.max(10, Math.round(subVideoIds.length * 0.02));
      const subMinSamples     = Math.max(3, Math.min(subMinClusterSize, 10));

      // Insert subrun row
      const subRunRes = await pool.query<{ id: number }>(
        `INSERT INTO niche_tree_runs (kind, parent_cluster_id, level, source, params, status, total_videos)
         VALUES ('subdivide', $1, 2, $2, $3, 'running', $4) RETURNING id`,
        [
          parent.id, source,
          JSON.stringify({ ...params, minClusterSize: subMinClusterSize, minSamples: subMinSamples }),
          subVideoIds.length,
        ],
      );
      const subRunId = subRunRes.rows[0].id;

      l2State.currentParentId    = parent.id;
      l2State.currentParentLabel = parent.auto_label || `Cluster ${parent.cluster_index}`;
      l2State.currentSubrunId    = subRunId;
      await writeProgress(runId, { l2: { ...l2State } });

      const subResult = await runOneClusteringPipeline({
        runId: subRunId,
        source,
        videoIds: subVideoIds,
        parentClusterId: parent.id,
        level: 2,
        minClusterSize: subMinClusterSize,
        minSamples:     subMinSamples,
        umapDims:       params.umapDims || 50,
        scriptKeyword:  `subdivide:${parent.id}`,
        // Subdivides on smaller subsets are much faster — give 30 min
        // each rather than the full 90 used for L1 on the whole dataset.
        pyTimeoutMs: 1_800_000,
      });

      if (subResult.ok === true) {
        l2State.completed++;
        await pool.query(
          `UPDATE niche_tree_runs SET status='done', completed_at=NOW()
             WHERE id=$1 AND status='running'`,
          [subRunId],
        );
      } else {
        l2State.failed++;
        // status='running' guard: if cancelGlobalRun already flipped
        // this subrun to 'error: Cancelled by user', don't overwrite.
        await pool.query(
          `UPDATE niche_tree_runs SET status='error', error_message=$1, completed_at=NOW()
             WHERE id=$2 AND status='running'`,
          [subResult.error, subRunId],
        );
        console.error(`[niche-tree] subdivide of cluster ${parent.id} failed:`, subResult.error);
      }
      await writeProgress(runId, {
        l2: {
          ...l2State,
          currentParentId: null,
          currentParentLabel: null,
          currentSubrunId: null,
        },
      });
    }

    // ── Mark L1 run done ────────────────────────────────────────
    // status='running' guard so that if the loop broke out due to
    // cancellation, the cancelled state stays intact.
    await pool.query(
      `UPDATE niche_tree_runs SET status='done', completed_at=NOW(),
         progress = COALESCE(progress, '{}'::jsonb) || $1::jsonb
         WHERE id=$2 AND status='running'`,
      [JSON.stringify({
        stage: 'done',
        stageStartedAt: new Date().toISOString(),
        l2: { ...l2State, currentParentId: null, currentParentLabel: null, currentSubrunId: null },
      }), runId],
    );
    console.log(
      `[niche-tree] global run ${runId} complete: ${l1.numClusters} L1 clusters, ` +
      `L2 baked ${l2State.completed}/${l2State.total} (skipped ${l2State.skipped}, failed ${l2State.failed})`,
    );
  } catch (err) {
    console.error('[niche-tree] global run error:', err);
    const e = err as Error & { stderr?: string; signal?: string; killed?: boolean };
    const detail =
      (e.signal ? `[${e.signal}${e.killed ? '/killed' : ''}] ` : '') +
      (e.stderr || '').toString().slice(-3000) +
      (e.message ? `\n${e.message.slice(0, 500)}` : '');
    // status='running' guard so a cancellation isn't overwritten by
    // a SIGTERM-induced error message — when the user cancels, the
    // python process exits with SIGTERM and we land here, but the
    // L1 row is already in 'error: Cancelled by user' state.
    await pool.query(
      `UPDATE niche_tree_runs SET status='error', error_message=$1, completed_at=NOW()
         WHERE id=$2 AND status='running'`,
      [detail.slice(0, 4000) || 'unknown', runId],
    ).catch(() => {});
  }
}

/**
 * Resume L2 baking for an L1 run that didn't complete its bake — e.g.
 * cancelled or interrupted by the now-fixed subdivide-endpoint bug.
 * Fire-and-forget. Iterates the L1 run's clusters that don't already
 * have children + meet the size threshold, runs subdivides
 * sequentially, updates `progress.l2` on the L1 run row so the UI
 * shows the same "12/30 clusters subdivided" banner used in a fresh
 * run.
 *
 * The L1 run row is flipped back to status='running' (with progress
 * stage='baking_l2') for the duration so cancel + concurrency guards
 * work the same way.
 */
export async function resumeL2Baking(l1RunId: number): Promise<void> {
  const pool = await getPool();
  try {
    // Pull L1 run + verify it exists
    const runRes = await pool.query<{ id: number; source: TreeSource; params: Record<string, unknown> }>(
      `SELECT id, source, params FROM niche_tree_runs WHERE id = $1 AND kind = 'global'`,
      [l1RunId],
    );
    if (runRes.rows.length === 0) {
      console.error(`[niche-tree] resume L2: run ${l1RunId} not found`);
      return;
    }
    const source = runRes.rows[0].source;

    // Find L1 clusters in this run that don't already have children.
    // Eligibility: ≥50 videos. Order by video_count DESC so the biggest
    // niches get baked first (faster perceived progress for the user).
    const todoRes = await pool.query<{
      id: number; video_count: number; cluster_index: number; auto_label: string | null;
    }>(
      `SELECT c.id, c.video_count, c.cluster_index, c.auto_label
         FROM niche_tree_clusters c
         WHERE c.run_id = $1
           AND c.parent_cluster_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM niche_tree_clusters child
             WHERE child.parent_cluster_id = c.id
           )
         ORDER BY c.video_count DESC`,
      [l1RunId],
    );
    const eligible = todoRes.rows.filter(c => c.video_count >= 50);
    const skipped  = todoRes.rows.length - eligible.length;

    if (eligible.length === 0) {
      console.log(`[niche-tree] resume L2: nothing to do for run ${l1RunId} (skipped ${skipped} too small)`);
      return;
    }

    // Already-baked count from clusters that DID have children — we
    // surface this so the progress chip shows accurate totals.
    const alreadyDoneRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM niche_tree_clusters c
         WHERE c.run_id = $1
           AND c.parent_cluster_id IS NULL
           AND EXISTS (SELECT 1 FROM niche_tree_clusters child WHERE child.parent_cluster_id = c.id)`,
      [l1RunId],
    );
    const alreadyDone = parseInt(alreadyDoneRes.rows[0]?.cnt ?? '0') || 0;

    // Flip the L1 row back to running + baking_l2 so the UI banner
    // reactivates and the cancel guard works.
    const l2State: TreeBakeL2Progress = {
      total: alreadyDone + eligible.length,
      completed: alreadyDone,
      skipped,
      failed: 0,
      currentParentId: null,
      currentParentLabel: null,
      currentSubrunId: null,
    };
    await pool.query(
      `UPDATE niche_tree_runs
         SET status = 'running',
             error_message = NULL,
             completed_at = NULL,
             progress = COALESCE(progress, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
      [JSON.stringify({
        stage: 'baking_l2',
        stageStartedAt: new Date().toISOString(),
        l2: { ...l2State },
      }), l1RunId],
    );

    for (const parent of eligible) {
      if (cancelledL1Runs.has(l1RunId)) {
        console.log(`[niche-tree] resume L2 cancelled at ${l2State.completed}/${l2State.total}`);
        break;
      }

      const subAssignRes = await pool.query<{ video_id: number }>(
        `SELECT video_id FROM niche_tree_assignments WHERE cluster_id = $1`,
        [parent.id],
      );
      const subVideoIds = subAssignRes.rows.map(r => r.video_id);
      if (subVideoIds.length < 50) {
        l2State.skipped++;
        await writeProgress(l1RunId, { l2: { ...l2State } });
        continue;
      }

      const subMinClusterSize = Math.max(10, Math.round(subVideoIds.length * 0.02));
      const subMinSamples     = Math.max(3, Math.min(subMinClusterSize, 10));

      const subRunRes = await pool.query<{ id: number }>(
        `INSERT INTO niche_tree_runs (kind, parent_cluster_id, level, source, params, status, total_videos)
         VALUES ('subdivide', $1, 2, $2, $3, 'running', $4) RETURNING id`,
        [
          parent.id, source,
          JSON.stringify({ minClusterSize: subMinClusterSize, minSamples: subMinSamples }),
          subVideoIds.length,
        ],
      );
      const subRunId = subRunRes.rows[0].id;

      l2State.currentParentId = parent.id;
      l2State.currentParentLabel = parent.auto_label || `Cluster ${parent.cluster_index}`;
      l2State.currentSubrunId = subRunId;
      await writeProgress(l1RunId, { l2: { ...l2State } });

      const subResult = await runOneClusteringPipeline({
        runId: subRunId,
        source,
        videoIds: subVideoIds,
        parentClusterId: parent.id,
        level: 2,
        minClusterSize: subMinClusterSize,
        minSamples:     subMinSamples,
        umapDims:       50,
        scriptKeyword:  `subdivide:${parent.id}`,
        pyTimeoutMs: 1_800_000,
      });

      if (subResult.ok === true) {
        l2State.completed++;
        await pool.query(
          `UPDATE niche_tree_runs SET status='done', completed_at=NOW()
             WHERE id=$1 AND status='running'`,
          [subRunId],
        );
      } else {
        l2State.failed++;
        await pool.query(
          `UPDATE niche_tree_runs SET status='error', error_message=$1, completed_at=NOW()
             WHERE id=$2 AND status='running'`,
          [subResult.error, subRunId],
        );
        console.error(`[niche-tree] resume L2: subdivide of ${parent.id} failed:`, subResult.error);
      }
      await writeProgress(l1RunId, {
        l2: { ...l2State, currentParentId: null, currentParentLabel: null, currentSubrunId: null },
      });
    }

    // Done — flip L1 row back to 'done'.
    await pool.query(
      `UPDATE niche_tree_runs
         SET status='done', completed_at=NOW(),
             progress = COALESCE(progress, '{}'::jsonb) || $1::jsonb
         WHERE id=$2 AND status='running'`,
      [JSON.stringify({
        stage: 'done',
        stageStartedAt: new Date().toISOString(),
        l2: { ...l2State, currentParentId: null, currentParentLabel: null, currentSubrunId: null },
      }), l1RunId],
    );
    console.log(
      `[niche-tree] resume L2 done for run ${l1RunId}: ` +
      `baked ${l2State.completed}/${l2State.total} (skipped ${l2State.skipped}, failed ${l2State.failed})`,
    );
  } catch (err) {
    console.error('[niche-tree] resume L2 error:', err);
    await pool.query(
      `UPDATE niche_tree_runs SET status='error', error_message=$1, completed_at=NOW()
         WHERE id=$2 AND status='running'`,
      [(err as Error).message?.slice(0, 4000) || 'unknown', l1RunId],
    ).catch(() => {});
  }
}

/**
 * Manual subdivide of a single cluster (e.g. from a "Re-bake this niche"
 * button in admin). Fire-and-forget. Caller inserts the niche_tree_runs
 * row first, like the global path.
 *
 * If the parent already has children, they're cleaned up first so this
 * run replaces rather than duplicates.
 */
export async function runSubdivideClusteringJob(opts: {
  runId: number;
  parentClusterId: number;
  params?: TreeClusterParams;
}): Promise<void> {
  const pool = await getPool();
  try {
    // Pull parent metadata + its videos
    const parentRes = await pool.query<{
      id: number; level: number; video_count: number;
    }>(
      `SELECT id, level, video_count FROM niche_tree_clusters WHERE id = $1`,
      [opts.parentClusterId],
    );
    if (parentRes.rows.length === 0) {
      await pool.query(
        `UPDATE niche_tree_runs SET status='error', error_message='Parent cluster not found', completed_at=NOW() WHERE id=$1`,
        [opts.runId],
      );
      return;
    }
    const parent = parentRes.rows[0];

    const sourceRes = await pool.query<{ source: TreeSource }>(
      `SELECT source FROM niche_tree_runs WHERE id = (
         SELECT run_id FROM niche_tree_clusters WHERE id = $1
       )`,
      [opts.parentClusterId],
    );
    const source = sourceRes.rows[0]?.source || opts.params?.source || 'combined_v2';

    // Pull videos
    const subAssignRes = await pool.query<{ video_id: number }>(
      `SELECT video_id FROM niche_tree_assignments WHERE cluster_id = $1`,
      [opts.parentClusterId],
    );
    const subVideoIds = subAssignRes.rows.map(r => r.video_id);
    if (subVideoIds.length < 50) {
      await pool.query(
        `UPDATE niche_tree_runs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2`,
        [`Parent cluster has ${subVideoIds.length} videos — at least 50 needed to subdivide.`, opts.runId],
      );
      return;
    }

    // Replace existing children: cascade FK cleans up assignments
    await pool.query(
      `DELETE FROM niche_tree_clusters WHERE parent_cluster_id = $1`,
      [opts.parentClusterId],
    );

    await pool.query(
      `UPDATE niche_tree_runs SET total_videos=$1, source=$2 WHERE id=$3`,
      [subVideoIds.length, source, opts.runId],
    );

    const subMinClusterSize = opts.params?.minClusterSize ?? Math.max(10, Math.round(subVideoIds.length * 0.02));
    const subMinSamples     = opts.params?.minSamples     ?? Math.max(3, Math.min(subMinClusterSize, 10));

    const result = await runOneClusteringPipeline({
      runId: opts.runId,
      source,
      videoIds: subVideoIds,
      parentClusterId: opts.parentClusterId,
      level: parent.level + 1,
      minClusterSize: subMinClusterSize,
      minSamples:     subMinSamples,
      umapDims:       opts.params?.umapDims || 50,
      scriptKeyword:  `subdivide:${opts.parentClusterId}`,
      pyTimeoutMs: 1_800_000,
    });

    if (result.ok === false) {
      await pool.query(
        `UPDATE niche_tree_runs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2`,
        [result.error, opts.runId],
      );
      return;
    }

    await pool.query(
      `UPDATE niche_tree_runs SET status='done', completed_at=NOW(),
         progress = COALESCE(progress, '{}'::jsonb) || $1::jsonb
         WHERE id=$2`,
      [JSON.stringify({ stage: 'done', stageStartedAt: new Date().toISOString() }), opts.runId],
    );
    console.log(`[niche-tree] subdivide of cluster ${opts.parentClusterId} done: ${result.numClusters} sub-niches`);
  } catch (err) {
    console.error('[niche-tree] subdivide error:', err);
    const e = err as Error & { message?: string };
    await pool.query(
      `UPDATE niche_tree_runs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2`,
      [(e.message || 'unknown').slice(0, 4000), opts.runId],
    ).catch(() => {});
  }
}

/** What the API returns per cluster card — includes rep video joined data and L2 child stats. */
export interface TreeClusterWithRep extends TreeCluster {
  repTitle: string | null;
  repThumbnail: string | null;
  repUrl: string | null;
  repViewCount: number | null;
  repChannelName: string | null;
  popularVideos: Array<{
    videoId: number;
    title: string | null;
    thumbnail: string | null;
    url: string | null;
    viewCount: number | null;
    channelName: string | null;
    postedAt: string | null;
    postedDate: string | null;
    score: number | null;
  }>;
  /** Number of distinct channels contributing videos to this cluster.
   *  Distinct from topChannels.length (which is the array's display
   *  cap, typically 5). */
  channelCount: number;
  /** Upload heartbeat: 26 buckets, each = video count in that week,
   *  oldest-to-newest. Index HISTOGRAM_WEEKS-1 = current week,
   *  index 0 = (HISTOGRAM_WEEKS-1) weeks ago. Lets the card show
   *  whether a niche is actively producing content or has gone
   *  quiet. Always HISTOGRAM_WEEKS entries, missing weeks filled
   *  with 0. */
  uploadHistogram: number[];
  /** Compact opportunity stats per cluster — same numbers as the
   *  Insights tab pills (NOS / top-left density / newcomer rate /
   *  low-sub ceiling). Sample is the count of high-score videos
   *  with both subs + views populated; null when too sparse to
   *  compute (<10). */
  opportunity: {
    sample: number;
    nos: number;
    nosDisplay: number;
    topLeftPct: number;
    newcomerRate: number;
    lowSubCeiling: number;
  } | null;
  /** Count of direct children (L2 clusters whose parent_cluster_id is this cluster). */
  childrenCount: number;
  /** Status of the latest subdivide run for this cluster as parent. NULL = never subdivided. */
  subdivideStatus: 'running' | 'done' | 'error' | null;
  /** Error message if the latest subdivide failed. */
  subdivideError: string | null;
}

/**
 * Fetch the latest global L1 run + its clusters, joined with the
 * representative video's title + thumbnail + URL plus L2 child counts.
 * Powers the Niche Tree admin tab grid.
 *
 * Important: clusters are returned regardless of run status. While the
 * Node-side DB-write phase is in progress (status='running', stage='writing')
 * the UI polls this endpoint every 5s and renders clusters as they're
 * inserted — so the grid populates live, ~5–10 cards per poll.
 */
export async function getLatestGlobalRun(): Promise<{
  run: (TreeRun & { progress?: TreeProgress | null }) | null;
  clusters: TreeClusterWithRep[];
}> {
  const pool = await getPool();

  const runRes = await pool.query(
    `SELECT * FROM niche_tree_runs
       WHERE kind = 'global'
       ORDER BY started_at DESC
       LIMIT 1`,
  );
  if (runRes.rows.length === 0) return { run: null, clusters: [] };

  const r = runRes.rows[0];
  // Live counts off the actual table — always consistent even after
  // partial writes (e.g. Node killed mid-bake), cleanup demotions, or
  // empty-cluster deletes. The denorm columns on niche_tree_runs are
  // set at python-output time and can drift from reality, so prefer
  // these for anything user-facing.
  const liveStats = await pool.query<{
    assigned: string; noise: string; clusters: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM niche_tree_assignments WHERE run_id = $1 AND cluster_id IS NOT NULL) AS assigned,
       (SELECT COUNT(*)::text FROM niche_tree_assignments WHERE run_id = $1 AND cluster_id IS NULL)     AS noise,
       (SELECT COUNT(*)::text FROM niche_tree_clusters    WHERE run_id = $1 AND parent_cluster_id IS NULL) AS clusters`,
    [r.id],
  );
  const numAssigned = parseInt(liveStats.rows[0]?.assigned ?? '0') || 0;
  const numNoiseLive = parseInt(liveStats.rows[0]?.noise ?? '0') || 0;
  const numClustersLive = parseInt(liveStats.rows[0]?.clusters ?? '0') || 0;
  const run = {
    id: r.id, kind: r.kind, parentClusterId: r.parent_cluster_id, level: r.level,
    source: r.source, status: r.status, params: r.params || {},
    // Use live counts so partial-write or post-cleanup drift doesn't
    // leak into the UI. Falls back to denorm only if the queries return
    // zero (e.g. run still mid-write — assignments not yet inserted).
    numClusters: numClustersLive || r.num_clusters,
    numNoise:    numNoiseLive    || r.num_noise,
    totalVideos: r.total_videos,
    numAssigned,
    errorMessage: r.error_message, startedAt: r.started_at, completedAt: r.completed_at,
    progress: (r.progress && typeof r.progress === 'object') ? r.progress as TreeProgress : null,
  };

  // No early return for status — we want partial cluster reads during
  // the Node-side DB-write phase so the grid populates live.

  // Pull the L1 clusters from this run + their L2 children. L2
  // clusters live under separate subdivide runs (different run_id),
  // so we can't filter by run_id alone — we expand to "either belongs
  // to this run, OR is a child of one that does". The home grid
  // renders both in two sections.
  // LEFT JOIN representative video so a cluster without a rep (shouldn't
  // happen but defensive) still shows up with nulls.
  const clRes = await pool.query(
    `WITH l1 AS (
       SELECT id FROM niche_tree_clusters
        WHERE run_id = $1 AND parent_cluster_id IS NULL
     )
     SELECT
       c.id, c.run_id, c.parent_cluster_id, c.level, c.cluster_index,
       c.auto_label, c.ai_label, c.label, c.video_count, c.avg_score,
       c.avg_views, c.total_views, c.top_channels, c.representative_video_id,
       c.centroid_2d,
       v.title         AS rep_title,
       v.thumbnail     AS rep_thumbnail,
       v.url           AS rep_url,
       v.view_count    AS rep_view_count,
       v.channel_name  AS rep_channel_name
     FROM niche_tree_clusters c
     LEFT JOIN niche_spy_videos v ON v.id = c.representative_video_id
     WHERE c.id IN (SELECT id FROM l1)
        OR c.parent_cluster_id IN (SELECT id FROM l1)
     ORDER BY c.parent_cluster_id NULLS FIRST, c.video_count DESC`,
    [run.id],
  );

  // 4 videos closest to the cluster centroid, deduped to one per
  // channel so the strip shows 4 different creators converging on
  // the niche. Per (cluster, channel) keep only the channel's
  // most-central video, then per cluster take the 4 closest.
  // Tiles are intentionally compact in the grid for overview
  // density; the UI scales them up on hover so titles + thumbs
  // become legible without sacrificing the at-a-glance row layout.
  const popRes = await pool.query<{
    cluster_id: number;
    video_id: number;
    title: string | null;
    thumbnail: string | null;
    url: string | null;
    view_count: string | null;
    channel_name: string | null;
    posted_at: Date | null;
    posted_date: string | null;
    score: number | null;
  }>(
    // Scope by explicit cluster id list (L1 from this run + their
    // L2 children, which live under separate subdivide runs). Run-id
    // alone would miss the L2s.
    `WITH per_channel AS (
       SELECT a.cluster_id,
              v.id AS video_id, v.title, v.thumbnail, v.url, v.view_count,
              v.channel_name, v.posted_at, v.posted_date, v.score,
              a.distance_to_centroid,
              ROW_NUMBER() OVER (
                PARTITION BY a.cluster_id, v.channel_name
                ORDER BY a.distance_to_centroid ASC NULLS LAST
              ) AS channel_rn
         FROM niche_tree_assignments a
         JOIN niche_spy_videos v ON v.id = a.video_id
         WHERE a.cluster_id = ANY($1::int[])
           AND v.channel_name IS NOT NULL
     ),
     ranked AS (
       SELECT *, ROW_NUMBER() OVER (
                  PARTITION BY cluster_id
                  ORDER BY distance_to_centroid ASC NULLS LAST
                ) AS rn
         FROM per_channel
         WHERE channel_rn = 1
     )
     SELECT cluster_id,
            video_id, title, thumbnail, url, view_count,
            channel_name, posted_at, posted_date, score
       FROM ranked
       WHERE rn <= 4
       ORDER BY cluster_id, rn`,
    [clRes.rows.map(r => r.id)],
  );

  const popularByCluster = new Map<number, Array<{
    videoId: number;
    title: string | null;
    thumbnail: string | null;
    url: string | null;
    viewCount: number | null;
    channelName: string | null;
    postedAt: string | null;
    postedDate: string | null;
    score: number | null;
  }>>();
  for (const row of popRes.rows) {
    const arr = popularByCluster.get(row.cluster_id) || [];
    arr.push({
      videoId:     row.video_id,
      title:       row.title,
      thumbnail:   row.thumbnail,
      url:         row.url,
      viewCount:   row.view_count !== null ? parseInt(row.view_count) : null,
      channelName: row.channel_name,
      postedAt:    row.posted_at?.toISOString() ?? null,
      postedDate:  row.posted_date,
      score:       row.score,
    });
    popularByCluster.set(row.cluster_id, arr);
  }

  const allClusterIds = clRes.rows.map(r => r.id);

  // Distinct-channel count per cluster. Cards used to show video_count
  // twice (once as the badge, once as the "Videos" stat tile) — this
  // replaces the redundant tile with something meaningful. Scoped by
  // explicit cluster id list so L2s (different run_id) are included.
  const channelCountByCluster = new Map<number, number>();
  if (allClusterIds.length > 0) {
    const channelCountRes = await pool.query<{ cluster_id: number; cnt: string }>(
      `SELECT a.cluster_id, COUNT(DISTINCT v.channel_name)::text AS cnt
         FROM niche_tree_assignments a
         JOIN niche_spy_videos v ON v.id = a.video_id
        WHERE a.cluster_id = ANY($1::int[]) AND v.channel_name IS NOT NULL AND v.channel_name <> ''
        GROUP BY a.cluster_id`,
      [allClusterIds],
    );
    for (const row of channelCountRes.rows) {
      channelCountByCluster.set(row.cluster_id, parseInt(row.cnt) || 0);
    }
  }

  // Upload heartbeat + opportunity indicators — both scoped by
  // explicit cluster id list (L1 + L2) so the L2 cards on the home
  // grid get their data populated alongside the L1s.
  const histogramByCluster = allClusterIds.length > 0
    ? await fetchUploadHistograms(pool, { clusterIds: allClusterIds })
    : new Map<number, number[]>();
  const opportunityByCluster = allClusterIds.length > 0
    ? await fetchClusterOpportunities(pool, { clusterIds: allClusterIds })
    : new Map<number, ClusterOpportunity>();

  // Child-count + subdivide-status per L1 cluster — drives the L2 status
  // chip on each card. One row per L1 cluster id, joining the COUNT of
  // its children in niche_tree_clusters with the LATEST subdivide run's
  // status.
  const childStatsRes = await pool.query<{
    parent_id: number;
    children_count: string;
    subdivide_status: 'running' | 'done' | 'error' | null;
    subdivide_error: string | null;
  }>(
    `WITH child_counts AS (
       SELECT parent_cluster_id AS parent_id, COUNT(*)::int AS children_count
         FROM niche_tree_clusters
         WHERE parent_cluster_id IS NOT NULL
         GROUP BY parent_cluster_id
     ),
     latest_sub AS (
       SELECT DISTINCT ON (parent_cluster_id)
              parent_cluster_id AS parent_id,
              status            AS subdivide_status,
              error_message     AS subdivide_error
         FROM niche_tree_runs
         WHERE kind = 'subdivide' AND parent_cluster_id IS NOT NULL
         ORDER BY parent_cluster_id, started_at DESC
     )
     SELECT
       COALESCE(cc.parent_id, ls.parent_id) AS parent_id,
       COALESCE(cc.children_count::text, '0') AS children_count,
       ls.subdivide_status,
       ls.subdivide_error
     FROM child_counts cc
     FULL OUTER JOIN latest_sub ls ON ls.parent_id = cc.parent_id`,
  );
  const childStatsByParent = new Map<number, {
    childrenCount: number;
    subdivideStatus: 'running' | 'done' | 'error' | null;
    subdivideError: string | null;
  }>();
  for (const row of childStatsRes.rows) {
    childStatsByParent.set(row.parent_id, {
      childrenCount:   parseInt(row.children_count) || 0,
      subdivideStatus: row.subdivide_status,
      subdivideError:  row.subdivide_error,
    });
  }

  const clusters: TreeClusterWithRep[] = clRes.rows.map(row => {
    const cs = childStatsByParent.get(row.id);
    return {
      id:                   row.id,
      runId:                row.run_id,
      parentClusterId:      row.parent_cluster_id,
      level:                row.level,
      clusterIndex:         row.cluster_index,
      autoLabel:            row.auto_label,
      aiLabel:              row.ai_label,
      label:                row.label,
      videoCount:           row.video_count,
      avgScore:             row.avg_score !== null ? Number(row.avg_score) : null,
      avgViews:             row.avg_views !== null ? Number(row.avg_views) : null,
      totalViews:           row.total_views !== null ? Number(row.total_views) : null,
      topChannels:          row.top_channels || [],
      representativeVideoId: row.representative_video_id,
      centroid2d:           row.centroid_2d || null,
      repTitle:             row.rep_title,
      repThumbnail:         row.rep_thumbnail,
      repUrl:               row.rep_url,
      repViewCount:         row.rep_view_count !== null ? Number(row.rep_view_count) : null,
      repChannelName:       row.rep_channel_name,
      popularVideos:        popularByCluster.get(row.id) || [],
      channelCount:         channelCountByCluster.get(row.id) ?? 0,
      uploadHistogram:      histogramByCluster.get(row.id) || zeroHistogram(),
      opportunity:          opportunityByCluster.get(row.id) ?? null,
      childrenCount:        cs?.childrenCount   ?? 0,
      subdivideStatus:      cs?.subdivideStatus ?? null,
      subdivideError:       cs?.subdivideError  ?? null,
    };
  });

  return { run, clusters };
}

/**
 * Fetch a specific cluster's children (sub-niches) plus the parent's
 * own metadata for the breadcrumb. Used by drill-down navigation in
 * the admin Niche Tree tab. Mirrors the shape returned by
 * getLatestGlobalRun so the same card-rendering UI can be reused at
 * any depth.
 */
export async function getClusterChildren(parentClusterId: number): Promise<{
  parent: TreeClusterWithRep | null;
  /** The chain of ancestors L1→…→parent for breadcrumb rendering. */
  ancestors: Array<{ id: number; level: number; label: string | null; autoLabel: string | null; clusterIndex: number }>;
  children: TreeClusterWithRep[];
  /** Latest subdivide run for this parent — null if never subdivided. */
  subdivideRun: (TreeRun & { progress?: TreeProgress | null }) | null;
}> {
  const pool = await getPool();

  // Parent + its rep video + popular videos — same enrichment as L1
  // clusters get from getLatestGlobalRun, so the drill-down screen can
  // show "you are inside cluster X" with its rep cards as a header.
  const parentRow = await pool.query(
    `SELECT
       c.id, c.run_id, c.parent_cluster_id, c.level, c.cluster_index,
       c.auto_label, c.ai_label, c.label, c.video_count, c.avg_score,
       c.avg_views, c.total_views, c.top_channels, c.representative_video_id,
       c.centroid_2d,
       v.title         AS rep_title,
       v.thumbnail     AS rep_thumbnail,
       v.url           AS rep_url,
       v.view_count    AS rep_view_count,
       v.channel_name  AS rep_channel_name
     FROM niche_tree_clusters c
     LEFT JOIN niche_spy_videos v ON v.id = c.representative_video_id
     WHERE c.id = $1`,
    [parentClusterId],
  );
  if (parentRow.rows.length === 0) {
    return { parent: null, ancestors: [], children: [], subdivideRun: null };
  }
  const pr = parentRow.rows[0];

  // Walk ancestors via recursive CTE for breadcrumb rendering.
  const ancestorsRes = await pool.query(
    `WITH RECURSIVE walk AS (
       SELECT id, parent_cluster_id, level, label, auto_label, cluster_index
         FROM niche_tree_clusters WHERE id = $1
       UNION ALL
       SELECT c.id, c.parent_cluster_id, c.level, c.label, c.auto_label, c.cluster_index
         FROM niche_tree_clusters c
         JOIN walk w ON w.parent_cluster_id = c.id
     )
     SELECT id, level, label, auto_label, cluster_index FROM walk
       WHERE id != $1
       ORDER BY level ASC`,
    [parentClusterId],
  );

  // Children + their rep videos
  const childrenRes = await pool.query(
    `SELECT
       c.id, c.run_id, c.parent_cluster_id, c.level, c.cluster_index,
       c.auto_label, c.ai_label, c.label, c.video_count, c.avg_score,
       c.avg_views, c.total_views, c.top_channels, c.representative_video_id,
       c.centroid_2d,
       v.title         AS rep_title,
       v.thumbnail     AS rep_thumbnail,
       v.url           AS rep_url,
       v.view_count    AS rep_view_count,
       v.channel_name  AS rep_channel_name
     FROM niche_tree_clusters c
     LEFT JOIN niche_spy_videos v ON v.id = c.representative_video_id
     WHERE c.parent_cluster_id = $1
     ORDER BY c.video_count DESC`,
    [parentClusterId],
  );

  // Popular videos (4 per child) — same dedupe-by-channel + closest-to-centroid
  const childIds = childrenRes.rows.map(c => c.id);
  const popByCluster = new Map<number, TreeClusterWithRep['popularVideos']>();
  if (childIds.length > 0) {
    const popRes = await pool.query<{
      cluster_id: number; video_id: number;
      title: string | null; thumbnail: string | null; url: string | null;
      view_count: string | null; channel_name: string | null;
      posted_at: Date | null; posted_date: string | null; score: number | null;
    }>(
      `WITH per_channel AS (
         SELECT a.cluster_id, v.id AS video_id, v.title, v.thumbnail, v.url, v.view_count,
                v.channel_name, v.posted_at, v.posted_date, v.score,
                a.distance_to_centroid,
                ROW_NUMBER() OVER (
                  PARTITION BY a.cluster_id, v.channel_name
                  ORDER BY a.distance_to_centroid ASC NULLS LAST
                ) AS channel_rn
           FROM niche_tree_assignments a
           JOIN niche_spy_videos v ON v.id = a.video_id
           WHERE a.cluster_id = ANY($1::int[])
             AND v.channel_name IS NOT NULL
       ),
       ranked AS (
         SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY cluster_id
                    ORDER BY distance_to_centroid ASC NULLS LAST
                  ) AS rn
           FROM per_channel WHERE channel_rn = 1
       )
       SELECT cluster_id, video_id, title, thumbnail, url, view_count,
              channel_name, posted_at, posted_date, score
         FROM ranked WHERE rn <= 4 ORDER BY cluster_id, rn`,
      [childIds],
    );
    for (const row of popRes.rows) {
      const arr = popByCluster.get(row.cluster_id) || [];
      arr.push({
        videoId: row.video_id, title: row.title, thumbnail: row.thumbnail, url: row.url,
        viewCount: row.view_count != null ? parseInt(row.view_count) : null,
        channelName: row.channel_name,
        postedAt: row.posted_at?.toISOString() ?? null,
        postedDate: row.posted_date,
        score: row.score,
      });
      popByCluster.set(row.cluster_id, arr);
    }
  }

  // Grandchild counts so an L2 card with its own L3 children can show the same chip
  const childGrandRes = await pool.query<{ parent_id: number; children_count: string; subdivide_status: 'running' | 'done' | 'error' | null; subdivide_error: string | null }>(
    `WITH child_counts AS (
       SELECT parent_cluster_id AS parent_id, COUNT(*)::int AS children_count
         FROM niche_tree_clusters WHERE parent_cluster_id = ANY($1::int[])
         GROUP BY parent_cluster_id
     ),
     latest_sub AS (
       SELECT DISTINCT ON (parent_cluster_id)
              parent_cluster_id AS parent_id, status AS subdivide_status, error_message AS subdivide_error
         FROM niche_tree_runs
         WHERE parent_cluster_id = ANY($1::int[])
         ORDER BY parent_cluster_id, started_at DESC
     )
     SELECT COALESCE(cc.parent_id, ls.parent_id) AS parent_id,
            COALESCE(cc.children_count::text, '0') AS children_count,
            ls.subdivide_status, ls.subdivide_error
     FROM child_counts cc
     FULL OUTER JOIN latest_sub ls ON ls.parent_id = cc.parent_id`,
    [childIds.length > 0 ? childIds : [0]],
  );
  const grandStatsByParent = new Map<number, { childrenCount: number; subdivideStatus: 'running' | 'done' | 'error' | null; subdivideError: string | null }>();
  for (const row of childGrandRes.rows) {
    grandStatsByParent.set(row.parent_id, {
      childrenCount:   parseInt(row.children_count) || 0,
      subdivideStatus: row.subdivide_status,
      subdivideError:  row.subdivide_error,
    });
  }

  // Distinct-channel counts + upload heartbeats for the parent +
  // every child cluster.
  const allIds = [parentClusterId, ...childIds];
  const channelCountByCluster = new Map<number, number>();
  if (allIds.length > 0) {
    const ccRes = await pool.query<{ cluster_id: number; cnt: string }>(
      `SELECT a.cluster_id, COUNT(DISTINCT v.channel_name)::text AS cnt
         FROM niche_tree_assignments a
         JOIN niche_spy_videos v ON v.id = a.video_id
        WHERE a.cluster_id = ANY($1::int[]) AND v.channel_name IS NOT NULL AND v.channel_name <> ''
        GROUP BY a.cluster_id`,
      [allIds],
    );
    for (const row of ccRes.rows) channelCountByCluster.set(row.cluster_id, parseInt(row.cnt) || 0);
  }
  const histogramByCluster = allIds.length > 0
    ? await fetchUploadHistograms(pool, { clusterIds: allIds })
    : new Map<number, number[]>();
  const opportunityByCluster = allIds.length > 0
    ? await fetchClusterOpportunities(pool, { clusterIds: allIds })
    : new Map<number, ClusterOpportunity>();

  const mapCluster = (row: typeof parentRow.rows[0], childStats?: ReturnType<typeof grandStatsByParent.get>): TreeClusterWithRep => ({
    id: row.id, runId: row.run_id, parentClusterId: row.parent_cluster_id, level: row.level,
    clusterIndex: row.cluster_index, autoLabel: row.auto_label, aiLabel: row.ai_label, label: row.label,
    videoCount: row.video_count,
    avgScore: row.avg_score !== null ? Number(row.avg_score) : null,
    avgViews: row.avg_views !== null ? Number(row.avg_views) : null,
    totalViews: row.total_views !== null ? Number(row.total_views) : null,
    topChannels: row.top_channels || [],
    representativeVideoId: row.representative_video_id, centroid2d: row.centroid_2d || null,
    repTitle: row.rep_title, repThumbnail: row.rep_thumbnail, repUrl: row.rep_url,
    repViewCount: row.rep_view_count !== null ? Number(row.rep_view_count) : null,
    repChannelName: row.rep_channel_name,
    popularVideos: popByCluster.get(row.id) || [],
    channelCount: channelCountByCluster.get(row.id) ?? 0,
    uploadHistogram: histogramByCluster.get(row.id) || zeroHistogram(),
    opportunity: opportunityByCluster.get(row.id) ?? null,
    childrenCount: childStats?.childrenCount ?? 0,
    subdivideStatus: childStats?.subdivideStatus ?? null,
    subdivideError: childStats?.subdivideError ?? null,
  });

  // Latest subdivide run for the parent (for live progress while baking)
  const subRunRes = await pool.query(
    `SELECT * FROM niche_tree_runs
       WHERE kind='subdivide' AND parent_cluster_id=$1
       ORDER BY started_at DESC LIMIT 1`,
    [parentClusterId],
  );
  const subdivideRun = subRunRes.rows.length > 0 ? (() => {
    const sr = subRunRes.rows[0];
    return {
      id: sr.id, kind: sr.kind, parentClusterId: sr.parent_cluster_id, level: sr.level,
      source: sr.source, status: sr.status, params: sr.params || {},
      numClusters: sr.num_clusters, numNoise: sr.num_noise, totalVideos: sr.total_videos,
      errorMessage: sr.error_message, startedAt: sr.started_at, completedAt: sr.completed_at,
      progress: (sr.progress && typeof sr.progress === 'object') ? sr.progress as TreeProgress : null,
    };
  })() : null;

  return {
    parent: mapCluster(pr),  // root parent doesn't need its own grandchild stats
    ancestors: ancestorsRes.rows.map(a => ({
      id: a.id, level: a.level, label: a.label, autoLabel: a.auto_label, clusterIndex: a.cluster_index,
    })),
    children: childrenRes.rows.map(row => mapCluster(row, grandStatsByParent.get(row.id))),
    subdivideRun,
  };
}


// ──────────────────────────────────────────────────────────────────────
// Cluster videos — paginated grid of every video assigned to one
// cluster. Mirrors the user-side /api/niche-spy/clusters/:id/videos
// shape so the admin tree drill-down can reuse the same card layout.
// Distance-to-centroid sort is the default because it surfaces the
// most representative samples first (same logic the 4-thumb strip uses).
// ──────────────────────────────────────────────────────────────────────

export type ClusterVideoSort = 'centroid' | 'outlier' | 'score' | 'views' | 'date' | 'oldest' | 'likes';

export interface ClusterVideoRow {
  videoId: number;
  url: string | null;
  title: string | null;
  thumbnail: string | null;
  channelName: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  subscriberCount: number | null;
  channelCreatedAt: string | null;
  postedAt: string | null;
  postedDate: string | null;
  score: number | null;
  topComment: string | null;
  keyword: string | null;
  distanceToCentroid: number | null;
}

export interface ClusterVideosResult {
  parent: TreeClusterWithRep | null;
  ancestors: Array<{ id: number; level: number; label: string | null; autoLabel: string | null; clusterIndex: number }>;
  videos: ClusterVideoRow[];
  total: number;
}

export async function getClusterVideos(opts: {
  clusterId: number;
  sort?: ClusterVideoSort;
  limit?: number;
  offset?: number;
  /** Optional case-insensitive title filter (matched with ILIKE %q%). */
  q?: string;
}): Promise<ClusterVideosResult> {
  const pool = await getPool();
  const sort = opts.sort ?? 'centroid';
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = opts.q?.trim() || '';

  // Parent + ancestor chain — same shape getClusterChildren returns so
  // the UI can render a consistent breadcrumb header for both views.
  const parentRow = await pool.query(
    `SELECT
       c.id, c.run_id, c.parent_cluster_id, c.level, c.cluster_index,
       c.auto_label, c.ai_label, c.label, c.video_count, c.avg_score,
       c.avg_views, c.total_views, c.top_channels, c.representative_video_id,
       c.centroid_2d,
       v.title AS rep_title, v.thumbnail AS rep_thumbnail, v.url AS rep_url,
       v.view_count AS rep_view_count, v.channel_name AS rep_channel_name
     FROM niche_tree_clusters c
     LEFT JOIN niche_spy_videos v ON v.id = c.representative_video_id
     WHERE c.id = $1`,
    [opts.clusterId],
  );
  if (parentRow.rows.length === 0) {
    return { parent: null, ancestors: [], videos: [], total: 0 };
  }
  const pr = parentRow.rows[0];

  const ancestorsRes = await pool.query(
    `WITH RECURSIVE walk AS (
       SELECT id, parent_cluster_id, level, label, auto_label, cluster_index
         FROM niche_tree_clusters WHERE id = $1
       UNION ALL
       SELECT c.id, c.parent_cluster_id, c.level, c.label, c.auto_label, c.cluster_index
         FROM niche_tree_clusters c
         JOIN walk w ON w.parent_cluster_id = c.id
     )
     SELECT id, level, label, auto_label, cluster_index FROM walk
       WHERE id != $1 ORDER BY level ASC`,
    [opts.clusterId],
  );

  // Total count from assignments — single source of truth (the cluster
  // row's video_count is denormalized at insert time and could drift if
  // a backfill runs). When `q` is set we have to join niche_spy_videos
  // so the count reflects the filter; otherwise we use the lighter
  // assignments-only path.
  let total: number;
  if (q) {
    const countRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM niche_tree_assignments a
         JOIN niche_spy_videos v ON v.id = a.video_id
        WHERE a.cluster_id = $1 AND v.title ILIKE $2`,
      [opts.clusterId, `%${q}%`],
    );
    total = parseInt(countRes.rows[0]?.cnt ?? '0') || 0;
  } else {
    const countRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM niche_tree_assignments WHERE cluster_id = $1`,
      [opts.clusterId],
    );
    total = parseInt(countRes.rows[0]?.cnt ?? '0') || 0;
  }

  // Sort whitelist — keys must map to safe ORDER BY fragments since
  // they're concatenated. NEVER let untrusted strings into ORDER BY.
  const orderMap: Record<ClusterVideoSort, string> = {
    centroid: 'a.distance_to_centroid ASC NULLS LAST',
    outlier:  'a.distance_to_centroid DESC NULLS LAST',
    score:    'v.score DESC NULLS LAST',
    views:    'v.view_count DESC NULLS LAST',
    date:     'v.posted_at DESC NULLS LAST',
    oldest:   'v.posted_at ASC NULLS LAST',
    likes:    'v.like_count DESC NULLS LAST',
  };
  const orderBy = orderMap[sort] ?? orderMap.centroid;

  // Build the videos query — same shape regardless of filter, but
  // params shift by one when `q` is set. Use $-numbers to keep limit
  // and offset positions correct in both branches.
  const vidsSql = q
    ? `SELECT
         v.id AS video_id, v.url, v.title, v.thumbnail, v.channel_name,
         v.view_count, v.like_count, v.comment_count, v.subscriber_count,
         v.channel_created_at, v.posted_at, v.posted_date, v.score,
         v.top_comment, v.keyword,
         a.distance_to_centroid
       FROM niche_tree_assignments a
       JOIN niche_spy_videos v ON v.id = a.video_id
       WHERE a.cluster_id = $1 AND v.title ILIKE $2
       ORDER BY ${orderBy}
       LIMIT $3 OFFSET $4`
    : `SELECT
         v.id AS video_id, v.url, v.title, v.thumbnail, v.channel_name,
         v.view_count, v.like_count, v.comment_count, v.subscriber_count,
         v.channel_created_at, v.posted_at, v.posted_date, v.score,
         v.top_comment, v.keyword,
         a.distance_to_centroid
       FROM niche_tree_assignments a
       JOIN niche_spy_videos v ON v.id = a.video_id
       WHERE a.cluster_id = $1
       ORDER BY ${orderBy}
       LIMIT $2 OFFSET $3`;
  const vidsParams: (number | string)[] = q
    ? [opts.clusterId, `%${q}%`, limit, offset]
    : [opts.clusterId, limit, offset];
  const vidsRes = await pool.query<{
    video_id: number; url: string | null; title: string | null; thumbnail: string | null;
    channel_name: string | null; view_count: string | null; like_count: string | null;
    comment_count: string | null; subscriber_count: string | null;
    channel_created_at: Date | null; posted_at: Date | null; posted_date: string | null;
    score: number | null; top_comment: string | null; keyword: string | null;
    distance_to_centroid: number | null;
  }>(vidsSql, vidsParams);

  const videos: ClusterVideoRow[] = vidsRes.rows.map(r => ({
    videoId: r.video_id,
    url: r.url,
    title: r.title,
    thumbnail: r.thumbnail,
    channelName: r.channel_name,
    viewCount:        r.view_count        != null ? parseInt(r.view_count)        : null,
    likeCount:        r.like_count        != null ? parseInt(r.like_count)        : null,
    commentCount:     r.comment_count     != null ? parseInt(r.comment_count)     : null,
    subscriberCount:  r.subscriber_count  != null ? parseInt(r.subscriber_count)  : null,
    channelCreatedAt: r.channel_created_at?.toISOString() ?? null,
    postedAt:         r.posted_at?.toISOString() ?? null,
    postedDate:       r.posted_date,
    score:            r.score,
    topComment:       r.top_comment,
    keyword:          r.keyword,
    distanceToCentroid: r.distance_to_centroid,
  }));

  // Build a TreeClusterWithRep parent (no popularVideos / grandchild
  // stats — those are needed for the cluster grid, not the video grid).
  const ccRes = await pool.query<{ cnt: string }>(
    `SELECT COUNT(DISTINCT v.channel_name)::text AS cnt
       FROM niche_tree_assignments a
       JOIN niche_spy_videos v ON v.id = a.video_id
      WHERE a.cluster_id = $1 AND v.channel_name IS NOT NULL AND v.channel_name <> ''`,
    [opts.clusterId],
  );
  const channelCount = parseInt(ccRes.rows[0]?.cnt || '0') || 0;
  const histogramByCluster = await fetchUploadHistograms(pool, { clusterIds: [opts.clusterId] });
  const uploadHistogram = histogramByCluster.get(opts.clusterId) || zeroHistogram();

  const parent: TreeClusterWithRep = {
    id: pr.id, runId: pr.run_id, parentClusterId: pr.parent_cluster_id, level: pr.level,
    clusterIndex: pr.cluster_index, autoLabel: pr.auto_label, aiLabel: pr.ai_label, label: pr.label,
    videoCount: pr.video_count,
    avgScore:   pr.avg_score   !== null ? Number(pr.avg_score)   : null,
    avgViews:   pr.avg_views   !== null ? Number(pr.avg_views)   : null,
    totalViews: pr.total_views !== null ? Number(pr.total_views) : null,
    topChannels: pr.top_channels || [],
    representativeVideoId: pr.representative_video_id, centroid2d: pr.centroid_2d || null,
    repTitle: pr.rep_title, repThumbnail: pr.rep_thumbnail, repUrl: pr.rep_url,
    repViewCount: pr.rep_view_count !== null ? Number(pr.rep_view_count) : null,
    repChannelName: pr.rep_channel_name,
    popularVideos: [],
    channelCount,
    uploadHistogram,
    opportunity: null,
    childrenCount: 0,
    subdivideStatus: null,
    subdivideError: null,
  };

  return {
    parent,
    ancestors: ancestorsRes.rows.map(a => ({
      id: a.id, level: a.level, label: a.label, autoLabel: a.auto_label, clusterIndex: a.cluster_index,
    })),
    videos,
    total,
  };
}
