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
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

/** Stages a global clustering run progresses through, in order. */
export const TREE_STAGES = [
  'starting',
  'fetching',      // Python: pulling embeddings + building feature matrix
  'umap_cluster',  // Python: UMAP NND -> umap_dims (the long one)
  'hdbscan',       // Python: HDBSCAN
  'labeling',      // Python: TF-IDF auto-labels
  'writing',       // Node: inserting clusters + assignments to DB
  'done',
] as const;
export type TreeStage = (typeof TREE_STAGES)[number];

export interface TreeProgress {
  stage: TreeStage;
  startedAt: string;          // run start
  stageStartedAt: string;     // current stage start
  stagesElapsedMs: Partial<Record<TreeStage, number>>; // per-stage durations once finished
  recentLogs: string[];       // last 12 lines of stderr for transparency
  numClusters?: number;       // populated as soon as HDBSCAN reports
  numNoise?: number;
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
 * Kick off a level-1 global clustering run (fire-and-forget).
 *
 * Caller is expected to have already inserted the niche_tree_runs row
 * (via POST /api/admin/niche-tree) — we just need its id so we can
 * patch in status/counts as we go and rollback cleanly on error.
 */
export async function runGlobalClusteringJob(runId: number, params: TreeClusterParams): Promise<void> {
  const pool = await getPool();

  try {
    const vectorDbUrl = process.env.VECTOR_DB_URL ||
      'postgresql://postgres:rLcWspOFJIPFDMbJSDdNlynLgcnupOfY@gondola.proxy.rlwy.net:10303/railway';

    const source: TreeSource = params.source || 'thumbnail_v2';
    const filter = SOURCE_FILTER[source];
    const minScore = params.minScore ?? 0; // L1 ranges across all niches; don't pre-filter by score

    // L1 input: every embedded video that meets the score threshold.
    // No keyword filter — that's the whole point of the global view.
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

    // Build script input. We pass keyword='__global__' as a sentinel so
    // the Python script's logging/labeling path knows it's a global run.
    // compute_2d=false skips the secondary 2D-scatter UMAP pass — the
    // niche tree admin tab doesn't render a scatter, and computing it
    // doubles the UMAP wall time on the full dataset.
    const tmpFile = path.join(os.tmpdir(), `cluster-tree-${runId}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({
      db_url: vectorDbUrl,
      keyword: '__global__',
      video_ids: eligibleIds,
      source,
      min_cluster_size: params.minClusterSize || 80,
      min_samples:      params.minSamples     || 10,
      umap_dims:        params.umapDims       || 50,
      compute_2d:       false,
    }));

    // 90min timeout — without PCA pre-reduction we run UMAP directly on
    // the full embedding (6144D for combined source). On 70K+ rows that
    // realistically takes 10–30 min for the clustering UMAP. We pay this
    // wall time deliberately — PCA was lossy on subtle sub-niche
    // structure, and this pipeline keeps every embedding dimension
    // through the kNN graph. Generous headroom for dataset growth.
    //
    // Spawn (vs execFileAsync) gives us streaming stderr — we parse the
    // Python script's stage markers line-by-line and write a `progress`
    // object to niche_tree_runs so the UI can render a live stepper.
    const startedAt = new Date().toISOString();
    let currentStage: TreeStage = 'starting';
    let stageStartedAt = startedAt;
    const stagesElapsedMs: Partial<Record<TreeStage, number>> = {};
    const recentLogs: string[] = [];

    await writeProgress(runId, {
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
      await writeProgress(runId, {
        stage: currentStage,
        stageStartedAt,
        stagesElapsedMs: { ...stagesElapsedMs },
        recentLogs: [...recentLogs],
        ...extra,
      });
    };

    // Map a single stderr line to the stage it implies we just ENTERED.
    const detectStage = (line: string): TreeStage | null => {
      // "X shape=(N,DIM)" → matrix is built, UMAP is about to start
      if (/\[cluster\] X shape=/.test(line))                 return 'umap_cluster';
      // "UMAP NND -> NND done" → UMAP cluster finished, HDBSCAN about to run
      if (/\[cluster\] UMAP \d+D -> \d+D done/.test(line))   return 'hdbscan';
      // "HDBSCAN: N clusters, M noise" → clustering done, labeling next
      if (/\[cluster\] HDBSCAN:/.test(line))                 return 'labeling';
      return null;
    };

    const py = spawn('python3', [
      path.join(SCRIPTS_DIR, 'cluster-niches.py'), tmpFile,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => py.kill('SIGTERM'), 5_400_000);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBuf = '';

    py.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    py.stderr.on('data', async (c: Buffer) => {
      stderrChunks.push(c);
      stderrBuf += c.toString();
      // Process complete lines; carry partial trailing line forward
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        recentLogs.push(line);
        if (recentLogs.length > 12) recentLogs.shift();

        const next = detectStage(line);
        if (next) {
          // First Python output after the initial fetch lands in
          // 'umap_cluster' — we jumped past 'fetching' implicitly.
          // Backfill its elapsed time.
          if (currentStage === 'starting' && next !== 'fetching') {
            stagesElapsedMs['fetching'] = Date.now() - new Date(stageStartedAt).getTime();
            currentStage = 'fetching';
            stageStartedAt = new Date().toISOString();
          }
          // Capture HDBSCAN's cluster count as soon as it lands so the
          // UI can show "23 clusters detected, writing now…" while we
          // wait for the DB-write phase.
          let extra: Partial<TreeProgress> | undefined;
          const m = /\[cluster\] HDBSCAN:\s*(\d+)\s*clusters,\s*(\d+)\s*noise/.exec(line);
          if (m) extra = { numClusters: parseInt(m[1]), numNoise: parseInt(m[2]) };
          await transitionTo(next, extra);
        } else {
          // No stage transition — just refresh the recent logs ~every
          // 5s so the UI tail stays alive.
          await writeProgress(runId, { recentLogs: [...recentLogs] });
        }
      }
    });

    // First thing the script does is open the DB and fetch — flip to
    // 'fetching' immediately so the UI doesn't sit on 'starting' for
    // the whole pre-X-shape window.
    await transitionTo('fetching');

    const exitCode: number = await new Promise((resolve, reject) => {
      py.on('close', (code) => resolve(code ?? -1));
      py.on('error', reject);
    });
    clearTimeout(timer);

    const stdout = Buffer.concat(stdoutChunks).toString();
    const stderr = Buffer.concat(stderrChunks).toString();
    if (exitCode !== 0) {
      throw Object.assign(new Error(`python exit ${exitCode}`), {
        stderr, signal: py.signalCode, killed: py.killed,
      });
    }
    if (stderr) console.log('[niche-tree] Python stderr (tail):', stderr.slice(-800));

    const result = JSON.parse(stdout);
    if (result.error) {
      await pool.query(
        `UPDATE niche_tree_runs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2`,
        [result.error, runId],
      );
      return;
    }

    // Patch counts so the UI status line can render mid-run.
    await pool.query(
      `UPDATE niche_tree_runs SET num_clusters=$1, num_noise=$2 WHERE id=$3`,
      [result.num_clusters, result.num_noise, runId],
    );

    // Enter the writing stage. The grid populates as each cluster is
    // inserted because the API drops the status='done' guard for
    // partial reads — UI polls every 5s and sees N more cards each tick.
    await transitionTo('writing', {
      numClusters: result.num_clusters,
      numNoise: result.num_noise,
    });

    // Insert clusters (level=1, parent=NULL for global L1).
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
         VALUES ($1, NULL, 1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          runId, cluster.cluster_index, cluster.auto_label, cluster.video_count,
          Math.round(parseFloat(stats.avg_score) || 0),
          Math.round(parseFloat(stats.avg_views) || 0),
          Math.round(parseFloat(stats.total_views) || 0),
          topChannels,
          cluster.representative_video_id,
          cluster.centroid_2d,
        ],
      );
      const clusterId = insertRes.rows[0].id;

      // Assignments for this cluster
      for (const a of result.assignments.filter((x: { cluster_index: number }) => x.cluster_index === cluster.cluster_index)) {
        await pool.query(
          `INSERT INTO niche_tree_assignments
             (run_id, video_id, cluster_id, cluster_index, x_2d, y_2d, distance_to_centroid)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [runId, a.video_id, clusterId, a.cluster_index, a.x_2d, a.y_2d, a.distance],
        );
      }
    }

    // Noise (cluster_index = -1) gets cluster_id NULL but stays attached
    // to the run so we can count it / surface it later.
    for (const a of result.assignments.filter((x: { cluster_index: number }) => x.cluster_index === -1)) {
      await pool.query(
        `INSERT INTO niche_tree_assignments
           (run_id, video_id, cluster_id, cluster_index, x_2d, y_2d, distance_to_centroid)
         VALUES ($1, $2, NULL, -1, $3, $4, $5)`,
        [runId, a.video_id, a.x_2d, a.y_2d, a.distance],
      );
    }

    // Final stage transition + status flip together, so the UI sees one
    // last poll where stage='done' and status='done' arrive simultaneously.
    stagesElapsedMs[currentStage] = Date.now() - new Date(stageStartedAt).getTime();
    await pool.query(
      `UPDATE niche_tree_runs SET status='done', completed_at=NOW(),
         progress = COALESCE(progress, '{}'::jsonb) || $1::jsonb
         WHERE id=$2`,
      [JSON.stringify({
        stage: 'done',
        stageStartedAt: new Date().toISOString(),
        stagesElapsedMs: { ...stagesElapsedMs },
        recentLogs: [...recentLogs],
      }), runId],
    );
    console.log(`[niche-tree] global run ${runId} done: ${result.num_clusters} clusters, ${result.num_noise} noise`);
  } catch (err) {
    console.error('[niche-tree] global run error:', err);
    // Pull a useful chunk of context: child-process stderr is the most
    // diagnostic part; fall back to the wrapping Error.message. Slice
    // generously so timeouts/SIGTERM/Python tracebacks survive the
    // round-trip into the DB and the UI banner.
    const e = err as Error & { stderr?: string; signal?: string; killed?: boolean };
    const detail =
      (e.signal ? `[${e.signal}${e.killed ? '/killed' : ''}] ` : '') +
      (e.stderr || '').toString().slice(-3000) +
      (e.message ? `\n${e.message.slice(0, 500)}` : '');
    await pool.query(
      `UPDATE niche_tree_runs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2`,
      [detail.slice(0, 4000) || 'unknown', runId],
    ).catch(() => {});
  }
}

/**
 * Fetch the latest global L1 run + its clusters, joined with the
 * representative video's title + thumbnail + URL. Powers the Niche Tree
 * admin tab grid.
 *
 * Important: clusters are returned regardless of run status. While the
 * Node-side DB-write phase is in progress (status='running', stage='writing')
 * the UI polls this endpoint every 5s and renders clusters as they're
 * inserted — so the grid populates live, ~5–10 cards per poll.
 */
export async function getLatestGlobalRun(): Promise<{
  run: (TreeRun & { progress?: TreeProgress | null }) | null;
  clusters: Array<TreeCluster & {
    repTitle: string | null;
    repThumbnail: string | null;
    repUrl: string | null;
    repViewCount: number | null;
    repChannelName: string | null;
  }>;
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

  const clusters = clRes.rows.map(row => ({
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
  }));

  return { run, clusters };
}
