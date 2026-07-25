import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import {
  CLUSTER_CLAIM_EXPIRY,
  ensureClusterTables,
  getActiveClusterRun,
  checkClusterWorkerAuth,
} from '@/lib/cluster-worker';

/**
 * PULL-based distributed kNN workers (no ngrok; mirrors /api/qwen-worker).
 *
 * A Colab T4 worker (cluster_knn_worker.ipynb) makes OUTBOUND calls only:
 *   POST {action:'claim'}                              → one kNN tile (soft-claimed 60 min)
 *   POST {action:'submit', tile_id, edges:[[s,d,w]], final?} → persist partial edges (+ close tile)
 *   GET                                                → queue status for the active run
 *
 * Many workers run in parallel — claims use FOR UPDATE SKIP LOCKED and a claim
 * expires after 60 min, so a killed Colab never strands its tile.
 *
 * Auth: Authorization: Bearer <cluster_worker_token from admin_config> — a
 * dedicated narrow token, distinct from qwen_worker_token, so revoking one
 * fleet never breaks the other.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

// One submit shouldn't carry an unbounded payload; workers chunk long tiles.
const MAX_EDGES_PER_SUBMIT = 2_000_000;

export async function GET(req: NextRequest) {
  if (!(await checkClusterWorkerAuth(req.headers.get('authorization'))))
    return NextResponse.json({ error: 'Invalid worker token' }, { status: 401 });
  await ensureClusterTables().catch(() => {});
  const run = await getActiveClusterRun();
  if (!run) return NextResponse.json({ activeRun: null, pending: 0, claimed: 0, done: 0 });
  const pool = await getPool();
  const r = await pool.query<{ pending: string; claimed: string; done: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE status = 'claimed' AND claimed_at > NOW() - INTERVAL '${CLUSTER_CLAIM_EXPIRY}') AS claimed,
       COUNT(*) FILTER (WHERE status = 'done') AS done
     FROM cluster_knn_tiles WHERE run_id = $1`,
    [run.id],
  );
  return NextResponse.json({
    activeRun: run.id,
    phase: run.phase,
    totalVideos: run.total_videos,
    pending: parseInt(r.rows[0].pending),
    claimed: parseInt(r.rows[0].claimed),
    done: parseInt(r.rows[0].done),
  });
}

export async function POST(req: NextRequest) {
  if (!(await checkClusterWorkerAuth(req.headers.get('authorization'))))
    return NextResponse.json({ error: 'Invalid worker token' }, { status: 401 });
  await ensureClusterTables().catch(() => {});
  const body = await req.json().catch(() => ({}));
  const pool = await getPool();

  if (body.action === 'claim') {
    const run = await getActiveClusterRun();
    if (!run) return NextResponse.json({ tile: null });   // no build in progress
    // Atomic claim: SKIP LOCKED keeps concurrent workers off each other's
    // tiles; an expired claim (dead worker) is re-claimable. Ordered by
    // tile_index (deterministic — the snapshot is frozen per run).
    const claimed = await pool.query<{
      id: number; tile_index: number; shard_a: number; shard_b: number | null; manifest: Record<string, unknown>;
    }>(
      `UPDATE cluster_knn_tiles SET status = 'claimed', claimed_at = NOW()
        WHERE id = (
          SELECT id FROM cluster_knn_tiles
           WHERE run_id = $1
             AND (status = 'pending'
                  OR (status = 'claimed' AND claimed_at < NOW() - INTERVAL '${CLUSTER_CLAIM_EXPIRY}'))
           ORDER BY tile_index
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tile_index, shard_a, shard_b, manifest`,
      [run.id],
    );
    const t = claimed.rows[0];
    if (!t) return NextResponse.json({ tile: null });     // all in flight / drained
    // The manifest (written by the snapshot phase) carries shard download
    // URLs + global-index offsets + k; pass it through verbatim.
    return NextResponse.json({
      tile: {
        tile_id: t.id,
        run_id: run.id,
        tile_index: t.tile_index,
        shard_a: t.shard_a,
        shard_b: t.shard_b,
        ...t.manifest,
      },
    });
  }

  if (body.action === 'submit') {
    const run = await getActiveClusterRun();
    if (!run) return NextResponse.json({ error: 'no active run' }, { status: 409 });
    const tileId = parseInt(String(body.tile_id));
    if (!Number.isFinite(tileId)) return NextResponse.json({ error: 'tile_id required' }, { status: 400 });
    const isFinal = body.final !== false;   // default true (one-shot); false = more chunks coming
    const raw: unknown[] = Array.isArray(body.edges) ? body.edges : [];
    if (raw.length > MAX_EDGES_PER_SUBMIT)
      return NextResponse.json({ error: `too many edges (${raw.length} > ${MAX_EDGES_PER_SUBMIT}); chunk the submit` }, { status: 413 });

    // Validate + bounds-check every edge against the run's vertex count.
    const N = run.total_videos;
    const src: number[] = [], dst: number[] = [], w: number[] = [];
    let rejected = 0;
    for (const e of raw) {
      const a = Array.isArray(e) ? e : null;
      const s = a ? parseInt(String(a[0])) : NaN;
      const d = a ? parseInt(String(a[1])) : NaN;
      const wt = a ? Number(a[2]) : NaN;
      if (!Number.isInteger(s) || !Number.isInteger(d) || s < 0 || d < 0
          || (N > 0 && (s >= N || d >= N)) || s === d || !Number.isFinite(wt)) {
        rejected++; continue;
      }
      src.push(s); dst.push(d); w.push(wt);
    }

    // Verify the tile belongs to the active run before writing.
    const tile = await pool.query<{ id: number }>(
      `SELECT id FROM cluster_knn_tiles WHERE id = $1 AND run_id = $2`, [tileId, run.id],
    );
    if (!tile.rows[0]) return NextResponse.json({ error: 'tile not in active run' }, { status: 409 });

    let persisted = 0;
    if (src.length > 0) {
      const res = await pool.query(
        `INSERT INTO cluster_knn_edges (run_id, src_idx, dst_idx, weight)
         SELECT $1, s, d, wt
           FROM UNNEST($2::int[], $3::int[], $4::real[]) AS t(s, d, wt)`,
        [run.id, src, dst, w],
      );
      persisted = res.rowCount ?? src.length;
    }
    await pool.query(
      `UPDATE cluster_knn_tiles
          SET edges_written = COALESCE(edges_written, 0) + $2,
              status = CASE WHEN $3 THEN 'done' ELSE status END,
              completed_at = CASE WHEN $3 THEN NOW() ELSE completed_at END
        WHERE id = $1`,
      [tileId, persisted, isFinal],
    );
    return NextResponse.json({ ok: true, persisted, rejected, final: isFinal });
  }

  return NextResponse.json({ error: "action must be 'claim' or 'submit'" }, { status: 400 });
}
