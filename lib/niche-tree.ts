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
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

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
    const tmpFile = path.join(os.tmpdir(), `cluster-tree-${runId}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({
      db_url: vectorDbUrl,
      keyword: '__global__',
      video_ids: eligibleIds,
      source,
      min_cluster_size: params.minClusterSize || 80,
      min_samples:      params.minSamples     || 10,
      umap_dims:        params.umapDims       || 50,
    }));

    // 30min timeout — global L1 on the full dataset (currently ~73K
    // videos at 6144 dims) does PCA + UMAP + HDBSCAN end-to-end. With
    // PCA pre-reduction down to 256 dims first, the heavy parts run
    // in 1-2 min, but we leave generous headroom.
    const { stdout, stderr } = await execFileAsync('python3', [
      path.join(SCRIPTS_DIR, 'cluster-niches.py'), tmpFile,
    ], { timeout: 1_800_000, maxBuffer: 200 * 1024 * 1024 });

    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
    if (stderr) console.log('[niche-tree] Python stderr:', stderr);

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

    await pool.query(
      `UPDATE niche_tree_runs SET status='done', completed_at=NOW() WHERE id=$1`,
      [runId],
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
 */
export async function getLatestGlobalRun(): Promise<{
  run: TreeRun | null;
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
  const run: TreeRun = {
    id: r.id, kind: r.kind, parentClusterId: r.parent_cluster_id, level: r.level,
    source: r.source, status: r.status, params: r.params || {},
    numClusters: r.num_clusters, numNoise: r.num_noise, totalVideos: r.total_videos,
    errorMessage: r.error_message, startedAt: r.started_at, completedAt: r.completed_at,
  };

  if (run.status !== 'done') return { run, clusters: [] };

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
  }));

  return { run, clusters };
}
