import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import {
  getFleetWorkers,
  getXgodoColabStatus,
  getColabConfig,
  spawnColabInstances,
} from '@/lib/colab-fleet';
import { getActiveClusterRun } from '@/lib/cluster-worker';
import { getPool } from '@/lib/db';

/**
 * Colab fleet control + overwatch (the "Colab" admin tab).
 *
 * GET  → fleet snapshot: connected/stale workers (heartbeat-tracked via
 *        /api/cluster-worker pulls), xgodo colab-job running/planned counts,
 *        active cluster run + tile queue, config in use.
 * POST → { action:'spawn', count:N }  — submit N planned tasks to the xgodo
 *        colab job (each = one Colab instance opening the worker notebook).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const [workers, xgodo, cfg, run] = await Promise.all([
    getFleetWorkers(),
    getXgodoColabStatus(),
    getColabConfig(),
    getActiveClusterRun(),
  ]);

  // Tile queue for the active run (if any) — what the fleet is chewing on.
  let tiles: { pending: number; claimed: number; done: number } | null = null;
  if (run) {
    const pool = await getPool();
    const t = await pool.query<{ pending: string; claimed: string; done: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE status = 'claimed') AS claimed,
         COUNT(*) FILTER (WHERE status = 'done') AS done
       FROM cluster_knn_tiles WHERE run_id = $1`,
      [run.id],
    ).catch(() => ({ rows: [{ pending: '0', claimed: '0', done: '0' }] }));
    tiles = {
      pending: parseInt(t.rows[0].pending),
      claimed: parseInt(t.rows[0].claimed),
      done: parseInt(t.rows[0].done),
    };
  }

  return NextResponse.json({
    workers,
    connectedCount: workers.filter(w => w.connected).length,
    xgodo,
    activeRun: run ? { id: run.id, phase: run.phase, totalVideos: run.total_videos } : null,
    tiles,
    config: { jobId: cfg.jobId, notebookUrl: cfg.notebookUrl, tokenConfigured: !!cfg.token },
  });
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  if (body.action === 'spawn') {
    const count = Math.max(1, Math.min(30, parseInt(String(body.count)) || 1));
    const result = await spawnColabInstances(count);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  }

  return NextResponse.json({ error: "action must be 'spawn'" }, { status: 400 });
}
