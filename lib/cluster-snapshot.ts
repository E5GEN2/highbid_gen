/**
 * Inc 1 of the distributed clustering fleet: snapshot export + tile creation.
 *
 * startClusterRun() freezes a deterministic sample of the combined_v2 (or
 * qwen_v1) vector space into fp16 shard files under FLEET_DIR (served to
 * Colab workers by the fleet-static nginx on :8091), writes the immutable
 * global_idx -> video_id map (cluster_run_index), and cuts the kNN tile
 * queue that /api/cluster-worker hands to workers.
 *
 * TILE SEMANTICS (v2 — query-block scans ALL index shards): a tile is a
 * contiguous block of query rows. The worker downloads its query block via
 * an HTTP Range request, then streams EVERY index shard (LRU-cached across
 * tiles), keeping a running top-(k+1) per query row on GPU. It submits
 * already-global top-k edges — so the server never cross-shard-merges, and
 * cluster_knn_edges stays at N*(k+1) rows, not S* that.
 *
 * DB safety (the pull-local-hang / seq-scan-storm lessons):
 *  - vectors come from the VEC db only (never main's REAL[] column);
 *  - id list first (cheap), then vectors by id in small batches (~1.5K rows
 *    ≈ 45MB of pgvector text per query), sequential, paced — never a long
 *    cursor (idle_in_transaction timeout) and never a parallel storm.
 *
 * Run lifecycle (backward-compat crux): the run row is kind='cluster_pull',
 * status='building' — invisible to the niche-tree single-flight guard, boot
 * orphan-sweep and getLatestGlobalRun until a later increment finalizes it.
 */
import fs from 'fs';
import path from 'path';
import { getPool } from './db';
import { vectorPool } from './vector-db';
import { ensureClusterTables } from './cluster-worker';

const FLEET_DIR = process.env.FLEET_DIR || '/data/fleet';
const FLEET_BASE_URL = process.env.FLEET_BASE_URL || 'http://195.201.198.166:8091';

export const SNAPSHOT_DEFAULTS = {
  sampleTarget: 300_000,   // pilot size; full runs pass the corpus size
  shardRows: 50_000,       // fp16 rows per shard file (~307 MB at 3072-d)
  queryBlock: 10_000,      // query rows per tile
  k: 50,                   // neighbours kept per point (worker fetches k+1 incl self)
  dim: 3072,
  vecBatch: 1_500,         // vectors per fetch query (~45MB text payload)
  paceMs: 120,             // sleep between vector batches — keep the vec DB calm
};

const TABLE_BY_SOURCE: Record<string, string> = {
  combined_v2: 'niche_video_vectors_combined_v2',
  qwen_v1: 'niche_video_vectors_qwen_v1',
};

// float32 -> float16 (IEEE 754 half, round-to-nearest-even via the standard
// bit trick). Hot loop — keep allocation-free.
const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);
function f32ToF16(val: number): number {
  f32buf[0] = val;
  const x = u32buf[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);   // inf/nan
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;                            // overflow -> inf
  if (e <= 0) {                                                   // subnormal/zero
    if (e < -10) return sign;
    mant = (mant | 0x800000) >> (1 - e);
    return sign | (mant >> 13);
  }
  return sign | (e << 10) | (mant >> 13);
}

function parseVecText(s: string, dim: number): Float32Array {
  const out = new Float32Array(dim);
  let idx = 0, start = 1;                     // skip '['
  for (let i = 1; i <= s.length - 1 && idx < dim; i++) {
    const c = s.charCodeAt(i);
    if (c === 44 /* , */ || c === 93 /* ] */) {
      out[idx++] = parseFloat(s.slice(start, i));
      start = i + 1;
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface StartRunOpts {
  source?: 'combined_v2' | 'qwen_v1';
  sampleTarget?: number;
  shardRows?: number;
  queryBlock?: number;
  k?: number;
}

/** Creates the run row and kicks the export off in the background.
 *  Single-flight: refuses if a cluster_pull run is already building. */
export async function startClusterRun(opts: StartRunOpts = {}): Promise<{ ok: boolean; runId?: number; error?: string }> {
  const pool = await getPool();
  await ensureClusterTables();
  const existing = await pool.query(
    `SELECT id FROM niche_tree_runs WHERE kind = 'cluster_pull' AND status = 'building' LIMIT 1`,
  );
  if (existing.rows[0]) return { ok: false, error: `run ${existing.rows[0].id} already building` };

  const source = opts.source === 'qwen_v1' ? 'qwen_v1' : 'combined_v2';
  const cfg = {
    ...SNAPSHOT_DEFAULTS,
    sampleTarget: Math.max(10_000, Math.min(3_000_000, opts.sampleTarget ?? SNAPSHOT_DEFAULTS.sampleTarget)),
    shardRows: Math.max(10_000, Math.min(250_000, opts.shardRows ?? SNAPSHOT_DEFAULTS.shardRows)),
    queryBlock: Math.max(1_000, Math.min(50_000, opts.queryBlock ?? SNAPSHOT_DEFAULTS.queryBlock)),
    k: Math.max(10, Math.min(100, opts.k ?? SNAPSHOT_DEFAULTS.k)),
  };
  // A query block must never span shard files (the tile's Range read assumes
  // one file). Snap queryBlock down to a divisor of shardRows.
  while (cfg.shardRows % cfg.queryBlock !== 0) cfg.queryBlock--;
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO niche_tree_runs (kind, level, source, status, phase, params, total_videos)
     VALUES ('cluster_pull', 1, $1, 'building', 'snapshot', $2, 0) RETURNING id`,
    [source, JSON.stringify({ algo: 'hac', knn: cfg })],
  );
  const runId = ins.rows[0].id;

  // Fire-and-forget export (mirrors the enrich-job pattern). Errors flip the
  // run to status='error' — visible in GET status, never thrown to a request.
  void exportSnapshot(runId, source, cfg).catch(async (err) => {
    console.error(`[cluster-run ${runId}] export failed:`, (err as Error).message);
    await pool.query(
      `UPDATE niche_tree_runs SET status = 'error', error_message = $2, completed_at = NOW() WHERE id = $1`,
      [runId, `snapshot export: ${(err as Error).message}`.slice(0, 400)],
    ).catch(() => {});
  });
  return { ok: true, runId };
}

async function exportSnapshot(
  runId: number,
  source: string,
  cfg: typeof SNAPSHOT_DEFAULTS,
): Promise<void> {
  const pool = await getPool();
  const vec = vectorPool;
  const table = TABLE_BY_SOURCE[source];
  const t0 = Date.now();
  const progress = async (p: Record<string, unknown>) =>
    pool.query(`UPDATE niche_tree_runs SET progress = progress || $2::jsonb WHERE id = $1`,
      [runId, JSON.stringify(p)]).catch(() => {});

  // ── 1. id universe (cheap: ints only) + deterministic every-Mth sample ──
  const idsRes = await vec.query<{ video_id: number }>(
    `SELECT video_id FROM ${table} ORDER BY video_id`,
  );
  const allIds = idsRes.rows.map(r => r.video_id);
  if (allIds.length < 1000) throw new Error(`only ${allIds.length} vectors in ${table}`);
  const step = Math.max(1, Math.floor(allIds.length / cfg.sampleTarget));
  const sampled: number[] = [];
  for (let i = 0; i < allIds.length && sampled.length < cfg.sampleTarget; i += step) sampled.push(allIds[i]);
  const N = sampled.length;
  const nShards = Math.ceil(N / cfg.shardRows);
  await progress({ stage: 'snapshot', universe: allIds.length, sampled: N, shards: nShards });

  // ── 2. cluster_run_index (immutable global_idx -> video_id map) ──
  await pool.query(`DELETE FROM cluster_run_index WHERE run_id = $1`, [runId]);
  for (let i = 0; i < N; i += 5000) {
    const chunk = sampled.slice(i, i + 5000);
    const gidx = chunk.map((_, j) => i + j);
    const shard = gidx.map(g => Math.floor(g / cfg.shardRows));
    await pool.query(
      `INSERT INTO cluster_run_index (run_id, global_idx, video_id, shard)
       SELECT $1, g, v, s FROM UNNEST($2::int[], $3::int[], $4::int[]) AS t(g, v, s)`,
      [runId, gidx, chunk, shard],
    );
  }

  // ── 3. fetch vectors by id in paced batches → fp16 shard files ──
  const runDir = path.join(FLEET_DIR, `run_${runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  const rowBytes = cfg.dim * 2;
  let shardStream: fs.WriteStream | null = null;
  let shardIdx = -1;
  const openShard = (s: number) => {
    if (shardStream) shardStream.end();
    shardIdx = s;
    shardStream = fs.createWriteStream(path.join(runDir, `shard_${s}.bin`));
  };
  const half = new Uint16Array(cfg.dim);
  for (let i = 0; i < N; i += cfg.vecBatch) {
    const batchIds = sampled.slice(i, i + cfg.vecBatch);
    const r = await vec.query<{ video_id: number; e: string }>(
      `SELECT video_id, embedding::text AS e FROM ${table} WHERE video_id = ANY($1::int[]) ORDER BY video_id`,
      [batchIds],
    );
    // batchIds is sorted (sampled is sorted) and ORDER BY matches; verify count.
    if (r.rows.length !== batchIds.length) {
      throw new Error(`vector fetch mismatch at ${i}: got ${r.rows.length}/${batchIds.length}`);
    }
    for (let j = 0; j < r.rows.length; j++) {
      const g = i + j;
      const s = Math.floor(g / cfg.shardRows);
      if (s !== shardIdx) openShard(s);
      const v = parseVecText(r.rows[j].e, cfg.dim);
      for (let d = 0; d < cfg.dim; d++) half[d] = f32ToF16(v[d]);
      shardStream!.write(Buffer.from(half.buffer.slice(0), 0, rowBytes));
    }
    if (i % 30_000 === 0) await progress({ stage: 'snapshot', exported: i, of: N });
    await sleep(cfg.paceMs);
  }
  if (shardStream) await new Promise<void>((res, rej) => shardStream!.end((e: unknown) => e ? rej(e) : res()));

  // sanity: shard sizes on disk
  for (let s = 0; s < nShards; s++) {
    const rows = Math.min(cfg.shardRows, N - s * cfg.shardRows);
    const want = rows * rowBytes;
    const got = fs.statSync(path.join(runDir, `shard_${s}.bin`)).size;
    if (got !== want) throw new Error(`shard_${s} size ${got} != expected ${want}`);
  }

  // ── 4. cut tiles: one per query block; manifest carries Range offsets +
  //      the full index-shard list (the worker must scan them ALL) ──
  const shardsMeta = Array.from({ length: nShards }, (_, s) => ({
    id: s,
    url: `${FLEET_BASE_URL}/run_${runId}/shard_${s}.bin`,
    rows: Math.min(cfg.shardRows, N - s * cfg.shardRows),
    base_idx: s * cfg.shardRows,
  }));
  await pool.query(`DELETE FROM cluster_knn_tiles WHERE run_id = $1`, [runId]);
  let tileIndex = 0;
  for (let q = 0; q < N; q += cfg.queryBlock) {
    const rows = Math.min(cfg.queryBlock, N - q);
    const shard = Math.floor(q / cfg.shardRows);
    const rowInShard = q - shard * cfg.shardRows;
    // a query block never spans shards: queryBlock divides shardRows
    const manifest = {
      k: cfg.k,
      dim: cfg.dim,
      n_total: N,
      query: {
        url: shardsMeta[shard].url,
        byte_start: rowInShard * rowBytes,
        byte_end: (rowInShard + rows) * rowBytes - 1,   // inclusive (HTTP Range)
        base_idx: q,
        rows,
      },
      index_shards: shardsMeta,
    };
    await pool.query(
      `INSERT INTO cluster_knn_tiles (run_id, tile_index, shard_a, shard_b, manifest)
       VALUES ($1, $2, $3, NULL, $4)`,
      [runId, tileIndex++, shard, JSON.stringify(manifest)],
    );
  }

  await pool.query(
    `UPDATE niche_tree_runs SET total_videos = $2, phase = 'knn',
            progress = progress || $3::jsonb
      WHERE id = $1`,
    [runId, N, JSON.stringify({ stage: 'knn', tiles: tileIndex, exportMs: Date.now() - t0 })],
  );
  console.log(`[cluster-run ${runId}] snapshot done: ${N} vectors, ${nShards} shards, ${tileIndex} tiles, ${Math.round((Date.now() - t0) / 1000)}s`);
}

/** Live status incl. tile drain; opportunistically flips phase knn->knn_done. */
export async function getClusterRunStatus(): Promise<Record<string, unknown> | null> {
  const pool = await getPool();
  const run = await pool.query<{ id: number; source: string; status: string; phase: string | null; total_videos: number; params: Record<string, unknown>; progress: Record<string, unknown>; started_at: string }>(
    `SELECT id, source, status, phase, total_videos, params, progress, started_at
       FROM niche_tree_runs WHERE kind = 'cluster_pull'
      ORDER BY id DESC LIMIT 1`,
  );
  const r = run.rows[0];
  if (!r) return null;
  const tiles = await pool.query<{ pending: string; claimed: string; done: string; edges: string }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending,
            COUNT(*) FILTER (WHERE status = 'claimed') AS claimed,
            COUNT(*) FILTER (WHERE status = 'done') AS done,
            COALESCE(SUM(edges_written), 0)::text AS edges
       FROM cluster_knn_tiles WHERE run_id = $1`,
    [r.id],
  );
  const t = tiles.rows[0];
  const pending = parseInt(t.pending), claimed = parseInt(t.claimed), done = parseInt(t.done);
  if (r.status === 'building' && r.phase === 'knn' && pending === 0 && claimed === 0 && done > 0) {
    await pool.query(`UPDATE niche_tree_runs SET phase = 'knn_done' WHERE id = $1 AND phase = 'knn'`, [r.id]).catch(() => {});
    r.phase = 'knn_done';
  }
  return {
    runId: r.id, source: r.source, status: r.status, phase: r.phase,
    totalVideos: r.total_videos, params: r.params, progress: r.progress,
    startedAt: r.started_at,
    tiles: { pending, claimed, done, edges: parseInt(t.edges) },
  };
}

/** Abort a building run: error the row, drop its scratch (files kept on disk). */
export async function abortClusterRun(): Promise<{ ok: boolean; runId?: number }> {
  const pool = await getPool();
  const run = await pool.query<{ id: number }>(
    `UPDATE niche_tree_runs SET status = 'error', error_message = 'aborted by admin', completed_at = NOW()
      WHERE kind = 'cluster_pull' AND status = 'building' RETURNING id`,
  );
  if (!run.rows[0]) return { ok: false };
  return { ok: true, runId: run.rows[0].id };
}
