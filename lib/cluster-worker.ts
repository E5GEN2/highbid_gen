/**
 * Distributed pull-based clustering — server helpers.
 *
 * A fleet of Colab T4 workers builds the EXACT kNN graph for a clustering
 * run by claiming tiles from /api/cluster-worker, computing per-tile top-k
 * edges on-GPU, and submitting them back. The box then merges the partial
 * edges into the global kNN graph and solves it with ParHAC.
 *
 * This module owns:
 *   - ensureClusterTables():  idempotent scratch-table DDL (mirrors
 *     ensureQwenTables — self-provisions per-request + at boot).
 *   - getActiveClusterRun():  the single in-flight build (kind='cluster_pull',
 *     status='building'), which claim/submit are scoped to.
 *
 * Backward-compat: a build sits in status='building' (NOT 'running') and
 * kind='cluster_pull' (NOT 'global'), so the niche-tree single-flight guard,
 * the boot orphan-sweep, and getLatestGlobalRun never see it until finalize
 * atomically flips it to kind='global'/status='done'/is_active=true.
 */
import { getPool } from './db';

// A tile (shard downloads + full index scan) runs minutes, not seconds.
// 20 min covers a slow first tile (cold shard cache) with margin, while
// keeping the self-heal window short when a worker dies mid-tile — an
// expired claim is re-handed to whoever's alive. Workers that FAIL should
// release explicitly (action:'release'); the TTL is the backstop.
export const CLUSTER_CLAIM_EXPIRY = '20 minutes';

let clusterTablesReady = false;

/** Idempotent — safe to call on every request. Cheap after the first call. */
export async function ensureClusterTables(): Promise<void> {
  if (clusterTablesReady) return;
  const pool = await getPool();
  // Frozen per-run global_idx → niche_spy_videos.id map (survives redeploy;
  // lets the merge translate worker edge indices back to real video ids).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cluster_run_index (
      run_id INTEGER NOT NULL,
      global_idx INTEGER NOT NULL,
      video_id INTEGER NOT NULL,
      shard INTEGER NOT NULL,
      PRIMARY KEY (run_id, global_idx)
    )
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cri_run_video ON cluster_run_index(run_id, video_id)`).catch(() => {});
  // kNN tile queue — one row per work unit. NO FK on run_id (scratch data;
  // lets the merge DELETE freely with no cascade surprise).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cluster_knn_tiles (
      id SERIAL PRIMARY KEY,
      run_id INTEGER NOT NULL,
      tile_index INTEGER NOT NULL,
      shard_a INTEGER NOT NULL,
      shard_b INTEGER,                         -- NULL = self-block (a x a)
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | done
      claimed_at TIMESTAMPTZ,
      edges_written INTEGER,
      manifest JSONB DEFAULT '{}',             -- shard urls, global offsets, row_count, k, dtype
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      UNIQUE(run_id, tile_index)
    )
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ckt_claim ON cluster_knn_tiles(run_id, status, claimed_at)`).catch(() => {});
  // Diagnosis: Colab consoles are invisible to us, so workers report failures
  // back via action:'release' and we keep the count + last message per tile.
  await pool.query(`ALTER TABLE cluster_knn_tiles ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE cluster_knn_tiles ADD COLUMN IF NOT EXISTS last_error TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE cluster_knn_tiles ADD COLUMN IF NOT EXISTS last_worker TEXT`).catch(() => {});
  // Partial kNN edges (GLOBAL vertex indices; mapped to video_ids at merge).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cluster_knn_edges (
      run_id INTEGER NOT NULL,
      src_idx INTEGER NOT NULL,
      dst_idx INTEGER NOT NULL,
      weight REAL NOT NULL
    )
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cke_run ON cluster_knn_edges(run_id)`).catch(() => {});
  clusterTablesReady = true;
}

export interface ClusterRun {
  id: number;
  total_videos: number;
  phase: string | null;
}

/** The single in-flight distributed build, if any. claim/submit scope to it. */
export async function getActiveClusterRun(): Promise<ClusterRun | null> {
  const pool = await getPool();
  const r = await pool.query<{ id: number; total_videos: number | null; phase: string | null }>(
    `SELECT id, total_videos, phase
       FROM niche_tree_runs
      WHERE kind = 'cluster_pull' AND status = 'building'
      ORDER BY id DESC
      LIMIT 1`,
  );
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, total_videos: row.total_videos ?? 0, phase: row.phase };
}

/** Exact-string Bearer check vs admin_config.cluster_worker_token. */
export async function checkClusterWorkerAuth(authHeader: string | null): Promise<boolean> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  if (!token) return false;
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'cluster_worker_token'`,
  );
  return !!r.rows[0]?.value && r.rows[0].value === token;
}
