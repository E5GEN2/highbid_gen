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

export type TreeSource = 'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined';

const SOURCE_FILTER: Record<TreeSource, string> = {
  title_v1:      'title_embedding IS NOT NULL',
  title_v2:      'title_embedding_v2 IS NOT NULL',
  thumbnail_v2:  'thumbnail_embedding_v2 IS NOT NULL',
  combined:      'title_embedding_v2 IS NOT NULL AND thumbnail_embedding_v2 IS NOT NULL',
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
  scriptKeyword: string;     // sentinel for Python's logging/labeling path
  pyTimeoutMs?: number;      // default 90 min
}): Promise<
  | { ok: true; numClusters: number; numNoise: number; insertedClusterIds: number[] }
  | { ok: false; error: string }
> {
  const pool = await getPool();
  const vectorDbUrl = process.env.VECTOR_DB_URL ||
    'postgresql://postgres:rLcWspOFJIPFDMbJSDdNlynLgcnupOfY@gondola.proxy.rlwy.net:10303/railway';

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

    // Insert clusters with the caller-provided parent + level.
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

      for (const a of result.assignments.filter((x: { cluster_index: number }) => x.cluster_index === cluster.cluster_index)) {
        await pool.query(
          `INSERT INTO niche_tree_assignments
             (run_id, video_id, cluster_id, cluster_index, x_2d, y_2d, distance_to_centroid)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [opts.runId, a.video_id, clusterId, a.cluster_index, a.x_2d, a.y_2d, a.distance],
        );
      }
    }

    // Noise — cluster_id NULL but still attached to the run for counting.
    for (const a of result.assignments.filter((x: { cluster_index: number }) => x.cluster_index === -1)) {
      await pool.query(
        `INSERT INTO niche_tree_assignments
           (run_id, video_id, cluster_id, cluster_index, x_2d, y_2d, distance_to_centroid)
         VALUES ($1, $2, NULL, -1, $3, $4, $5)`,
        [opts.runId, a.video_id, a.x_2d, a.y_2d, a.distance],
      );
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
    const source: TreeSource = params.source || 'thumbnail_v2';
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
    const source = sourceRes.rows[0]?.source || opts.params?.source || 'thumbnail_v2';

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
  const run = {
    id: r.id, kind: r.kind, parentClusterId: r.parent_cluster_id, level: r.level,
    source: r.source, status: r.status, params: r.params || {},
    numClusters: r.num_clusters, numNoise: r.num_noise, totalVideos: r.total_videos,
    errorMessage: r.error_message, startedAt: r.started_at, completedAt: r.completed_at,
    progress: (r.progress && typeof r.progress === 'object') ? r.progress as TreeProgress : null,
  };

  // No early return for status — we want partial cluster reads during
  // the Node-side DB-write phase so the grid populates live.

  // LEFT JOIN representative video so a cluster without a rep (shouldn't
  // happen but defensive) still shows up with nulls.
  const clRes = await pool.query(
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
     WHERE c.run_id = $1
     ORDER BY c.video_count DESC`,
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
         WHERE a.run_id = $1
           AND a.cluster_id IS NOT NULL
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
    [run.id],
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
