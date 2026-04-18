/**
 * Clustering orchestration for sub-niche discovery.
 * Runs HDBSCAN via Python subprocess, stores results in DB, optional Gemini AI labeling.
 */

import { getPool } from './db';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

export type ClusterSource = 'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined';

interface ClusterParams {
  minClusterSize?: number;
  minSamples?: number;
  umapDims?: number;
  minScore?: number;
  source?: ClusterSource;   // which embedding space to cluster on (default title_v1)
}

// Which main-DB column must be non-null for a video to be eligible
// in each source. Combined requires BOTH v2 columns present.
const SOURCE_FILTER: Record<ClusterSource, string> = {
  title_v1:      'title_embedding IS NOT NULL',
  title_v2:      'title_embedding_v2 IS NOT NULL',
  thumbnail_v2:  'thumbnail_embedding_v2 IS NOT NULL',
  combined:      'title_embedding_v2 IS NOT NULL AND thumbnail_embedding_v2 IS NOT NULL',
};

interface ClusterRun {
  id: number;
  keyword: string;
  status: string;
  algorithm: string;
  params: Record<string, unknown>;
  source: ClusterSource;
  numClusters: number;
  numNoise: number;
  totalVideos: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

interface ClusterInfo {
  id: number;
  runId: number;
  keyword: string;
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

/** Start a clustering job (fire-and-forget) */
export async function runClusteringJob(runId: number, keyword: string, params: ClusterParams): Promise<void> {
  const pool = await getPool();

  try {
    // Get pgvector DB URL
    const vectorDbUrl = process.env.VECTOR_DB_URL ||
      'postgresql://postgres:rLcWspOFJIPFDMbJSDdNlynLgcnupOfY@gondola.proxy.rlwy.net:10303/railway';

    // Source selects which embedding space to cluster on. Each has its own
    // main-DB column that must be non-null for the video to qualify.
    const source: ClusterSource = params.source || 'title_v1';
    const filter = SOURCE_FILTER[source];

    // Score threshold — below this the video isn't really in the niche
    const minScore = params.minScore || 80;
    const eligibleRes = await pool.query(
      `SELECT id FROM niche_spy_videos WHERE keyword = $1 AND score >= $2 AND ${filter}`,
      [keyword, minScore]
    );
    const eligibleIds = eligibleRes.rows.map((r: { id: number }) => r.id);

    if (eligibleIds.length < 10) {
      await pool.query(
        `UPDATE niche_cluster_runs SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [`Only ${eligibleIds.length} videos with score >= ${minScore} and ${source} embeddings. Need at least 10.`, runId]
      );
      return;
    }

    // Persist the source so we can show which basis a run used in the UI
    await pool.query(`UPDATE niche_cluster_runs SET source = $1 WHERE id = $2`, [source, runId]).catch(() => {});

    // Write input config to temp file
    const tmpFile = path.join(os.tmpdir(), `cluster-${runId}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({
      db_url: vectorDbUrl,
      keyword,
      video_ids: eligibleIds,
      source,
      min_cluster_size: params.minClusterSize || null,
      min_samples: params.minSamples || null,
      umap_dims: params.umapDims || 50,
    }));

    // Run Python script
    const { stdout, stderr } = await execFileAsync('python3', [
      path.join(SCRIPTS_DIR, 'cluster-niches.py'), tmpFile
    ], { timeout: 300000, maxBuffer: 100 * 1024 * 1024 });

    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }

    if (stderr) console.log('[clustering] Python stderr:', stderr);

    const result = JSON.parse(stdout);

    if (result.error) {
      await pool.query(
        `UPDATE niche_cluster_runs SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [result.error, runId]
      );
      return;
    }

    // Update run with counts
    await pool.query(
      `UPDATE niche_cluster_runs SET num_clusters = $1, num_noise = $2, total_videos = $3, status = 'labeling' WHERE id = $4`,
      [result.num_clusters, result.num_noise, result.total_videos, runId]
    );

    // Insert clusters
    for (const cluster of result.clusters) {
      // Compute aggregate stats from main DB
      const statsRes = await pool.query(
        `SELECT AVG(score) as avg_score, AVG(view_count) as avg_views, SUM(view_count) as total_views
         FROM niche_spy_videos WHERE id = ANY($1)`,
        [cluster.video_ids]
      );
      const stats = statsRes.rows[0];

      // Top channels
      const channelRes = await pool.query(
        `SELECT channel_name, COUNT(*) as cnt FROM niche_spy_videos
         WHERE id = ANY($1) AND channel_name IS NOT NULL
         GROUP BY channel_name ORDER BY cnt DESC LIMIT 5`,
        [cluster.video_ids]
      );
      const topChannels = channelRes.rows.map((r: { channel_name: string }) => r.channel_name);

      const insertRes = await pool.query(
        `INSERT INTO niche_clusters (run_id, keyword, cluster_index, auto_label, label, video_count,
          avg_score, avg_views, total_views, top_channels, representative_video_id, centroid_2d)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [runId, keyword, cluster.cluster_index, cluster.auto_label, cluster.video_count,
         Math.round(parseFloat(stats.avg_score) || 0),
         Math.round(parseFloat(stats.avg_views) || 0),
         Math.round(parseFloat(stats.total_views) || 0),
         topChannels,
         cluster.representative_video_id,
         cluster.centroid_2d]
      );
      const clusterId = insertRes.rows[0].id;

      // Insert assignments for this cluster
      for (const assignment of result.assignments.filter((a: { cluster_index: number }) => a.cluster_index === cluster.cluster_index)) {
        await pool.query(
          `INSERT INTO niche_cluster_assignments (run_id, video_id, cluster_id, cluster_index, x_2d, y_2d, distance_to_centroid)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [runId, assignment.video_id, clusterId, assignment.cluster_index, assignment.x_2d, assignment.y_2d, assignment.distance]
        );
      }
    }

    // Insert noise assignments (cluster_index = -1)
    for (const assignment of result.assignments.filter((a: { cluster_index: number }) => a.cluster_index === -1)) {
      await pool.query(
        `INSERT INTO niche_cluster_assignments (run_id, video_id, cluster_id, cluster_index, x_2d, y_2d, distance_to_centroid)
         VALUES ($1, $2, NULL, -1, $3, $4, $5)`,
        [runId, assignment.video_id, assignment.x_2d, assignment.y_2d, assignment.distance]
      );
    }

    // Mark done
    await pool.query(
      `UPDATE niche_cluster_runs SET status = 'done', completed_at = NOW() WHERE id = $1`,
      [runId]
    );

    console.log(`[clustering] Run ${runId} complete: ${result.num_clusters} clusters, ${result.num_noise} noise`);

  } catch (err) {
    console.error('[clustering] Job error:', err);
    await pool.query(
      `UPDATE niche_cluster_runs SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [(err as Error).message, runId]
    );
  }
}

/** AI-label clusters using Gemini */
export async function labelClustersWithAI(runId: number, keyword: string): Promise<{ labeled: number; errors: number }> {
  const pool = await getPool();
  let labeled = 0, errors = 0;

  // Get Gemini API key
  const keyRes = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_google_api_keys'");
  const apiKeys = (keyRes.rows[0]?.value || '').split(',').map((k: string) => k.trim()).filter(Boolean);
  if (apiKeys.length === 0) {
    // Fallback to PAPAI_API_KEY
    const papaiRes = await pool.query("SELECT value FROM admin_config WHERE key = 'papai_api_key'");
    if (papaiRes.rows[0]?.value) apiKeys.push(papaiRes.rows[0].value);
  }
  if (apiKeys.length === 0) return { labeled: 0, errors: 1 };
  const apiKey = apiKeys[0];

  // Get clusters for this run
  const clusters = await pool.query(
    `SELECT id, cluster_index FROM niche_clusters WHERE run_id = $1 AND cluster_index >= 0 ORDER BY cluster_index`,
    [runId]
  );

  for (const cluster of clusters.rows) {
    try {
      // Get top titles for this cluster
      const titlesRes = await pool.query(
        `SELECT v.title FROM niche_cluster_assignments a
         JOIN niche_spy_videos v ON v.id = a.video_id
         WHERE a.cluster_id = $1
         ORDER BY v.score DESC NULLS LAST, v.view_count DESC NULLS LAST
         LIMIT 10`,
        [cluster.id]
      );
      const titles = titlesRes.rows.map((r: { title: string }) => r.title).filter(Boolean);
      if (titles.length === 0) continue;

      const prompt = `Given these YouTube video titles from a content cluster within the "${keyword}" niche, provide a concise 2-4 word sub-niche name that describes this content category. Respond with ONLY the label, no quotes, no other text.\n\nTitles:\n${titles.map((t: string, i: number) => `${i + 1}. ${t}`).join('\n')}`;

      const res = await fetch('https://papaiapi.com/v1beta/models/gemini-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 50, temperature: 0.3 },
        }),
      });

      const data = await res.json();
      const aiLabel = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (aiLabel && aiLabel.length < 60) {
        await pool.query(
          `UPDATE niche_clusters SET ai_label = $1, label = $1 WHERE id = $2`,
          [aiLabel, cluster.id]
        );
        labeled++;
      }

      // Small delay between API calls
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[clustering] AI label error for cluster ${cluster.id}:`, err);
      errors++;
    }
  }

  return { labeled, errors };
}

/** Get the latest cluster run for a keyword */
export async function getLatestClusterRun(keyword: string): Promise<{ run: ClusterRun; clusters: ClusterInfo[] } | null> {
  const pool = await getPool();

  const runRes = await pool.query(
    `SELECT * FROM niche_cluster_runs WHERE keyword = $1 ORDER BY started_at DESC LIMIT 1`,
    [keyword]
  );
  if (runRes.rows.length === 0) return null;

  const r = runRes.rows[0];
  const run: ClusterRun = {
    id: r.id, keyword: r.keyword, status: r.status, algorithm: r.algorithm,
    params: r.params, source: (r.source || 'title_v1') as ClusterSource,
    numClusters: r.num_clusters, numNoise: r.num_noise,
    totalVideos: r.total_videos, errorMessage: r.error_message,
    startedAt: r.started_at, completedAt: r.completed_at,
  };

  let clusters: ClusterInfo[] = [];
  if (run.status === 'done' || run.status === 'labeling') {
    const clusterRes = await pool.query(
      `SELECT * FROM niche_clusters WHERE run_id = $1 AND cluster_index >= 0 ORDER BY video_count DESC`,
      [run.id]
    );
    clusters = clusterRes.rows.map((c: Record<string, unknown>) => ({
      id: c.id as number, runId: c.run_id as number, keyword: c.keyword as string,
      clusterIndex: c.cluster_index as number, autoLabel: c.auto_label as string | null,
      aiLabel: c.ai_label as string | null, label: c.label as string | null,
      videoCount: c.video_count as number, avgScore: c.avg_score as number | null,
      avgViews: c.avg_views as number | null, totalViews: c.total_views as number | null,
      topChannels: (c.top_channels || []) as string[],
      representativeVideoId: c.representative_video_id as number | null,
      centroid2d: c.centroid_2d as number[] | null,
    }));
  }

  return { run, clusters };
}
