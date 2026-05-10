import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { runGlobalClusteringJob, cancelGlobalRun, type TreeSource, type TreeProgress } from '@/lib/niche-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * Agent-driven niche-tree control surface. Compact responses tuned for
 * an automated caller (Claude / Code) that wants to drive clustering
 * without the full UI: start a run, poll a single JSON until it's
 * done, cancel if needed.
 *
 *   GET    /api/admin/niche-tree/agent          → compact status
 *   POST   /api/admin/niche-tree/agent          → start a new run
 *     body: { source?: TreeSource; force?: boolean; minClusterSize?, minSamples?, umapDims?, minScore? }
 *     - force=true cancels any in-flight run before starting
 *   DELETE /api/admin/niche-tree/agent          → cancel the active run
 *
 * Auth: same as the other admin routes (Bearer hba_… token, x-admin-token
 * header, or admin_token cookie).
 */

interface AgentStatus {
  runId: number | null;
  status: string | null;             // 'running' | 'done' | 'error' | null
  stage: string | null;              // current TreeStage
  source: string | null;
  startedAt: string | null;
  completedAt: string | null;
  numClusters: number;               // expected (from python)
  numNoise: number;                  // expected
  totalVideos: number;
  clustersWritten: number;           // live count from niche_tree_clusters
  assignmentsWritten: number;        // live count from niche_tree_assignments (cluster_id NOT NULL)
  noiseWritten: number;              // live count of cluster_id IS NULL
  expectedAssignments: number;       // numClusters' worth — derived
  percentComplete: number;           // rough overall % across all stages
  etaSeconds: number | null;         // best-effort
  errorMessage: string | null;
  recentLogs: string[];
  stitch: {
    prevRunId: number | null;
    same: number;
    grew: number;
    shrank: number;
    split: number;
    merged: number;
    born: number;
    died: number;
    totalNewClusters: number;
  } | null;
  stitchError: string | null;
}

const STAGE_ORDER = ['starting', 'fetching', 'umap_cluster', 'hdbscan', 'labeling', 'writing', 'stitching', 'baking_l2', 'done'];
// Coarse stage weighting for an overall % bar. Empirical from the last
// few runs: fetching+umap_cluster eat the lion's share, writing is now
// fast post-bulk-insert, stitching takes ~30s, and baking_l2 is
// optional/skippable.
const STAGE_FRACTION: Record<string, number> = {
  starting:     0,
  fetching:     0.05,
  umap_cluster: 0.55,
  hdbscan:      0.65,
  labeling:     0.70,
  writing:      0.92,
  stitching:    0.95,
  baking_l2:    0.99,
  done:         1.00,
};

async function buildStatus(): Promise<AgentStatus> {
  const pool = await getPool();
  const r = await pool.query(
    `SELECT * FROM niche_tree_runs WHERE kind='global' ORDER BY started_at DESC LIMIT 1`,
  );
  if (r.rows.length === 0) {
    return {
      runId: null, status: null, stage: null, source: null,
      startedAt: null, completedAt: null,
      numClusters: 0, numNoise: 0, totalVideos: 0,
      clustersWritten: 0, assignmentsWritten: 0, noiseWritten: 0,
      expectedAssignments: 0, percentComplete: 0, etaSeconds: null,
      errorMessage: null, recentLogs: [],
      stitch: null, stitchError: null,
    };
  }
  const row = r.rows[0];
  const progress = (row.progress && typeof row.progress === 'object') ? row.progress as TreeProgress : null;
  const stage = progress?.stage ?? null;

  const live = await pool.query<{ clusters: string; assigned: string; noise: string }>(
    `SELECT
       (SELECT COUNT(*)::text FROM niche_tree_clusters WHERE run_id=$1 AND parent_cluster_id IS NULL) AS clusters,
       (SELECT COUNT(*)::text FROM niche_tree_assignments WHERE run_id=$1 AND cluster_id IS NOT NULL)  AS assigned,
       (SELECT COUNT(*)::text FROM niche_tree_assignments WHERE run_id=$1 AND cluster_id IS NULL)      AS noise`,
    [row.id],
  );
  const clustersWritten = parseInt(live.rows[0]?.clusters ?? '0') || 0;
  const assignmentsWritten = parseInt(live.rows[0]?.assigned ?? '0') || 0;
  const noiseWritten = parseInt(live.rows[0]?.noise ?? '0') || 0;

  const numClusters = row.num_clusters || 0;
  const numNoise = row.num_noise || 0;
  const totalVideos = row.total_videos || 0;
  const expectedAssignments = Math.max(0, totalVideos - numNoise);

  // Overall %: anchor on the active stage's base fraction, then within
  // the writing stage interpolate by rows-written progress so the user
  // sees motion per chunk.
  let percent = STAGE_FRACTION[stage ?? 'starting'] ?? 0;
  if (stage === 'writing' && expectedAssignments > 0) {
    const writingProgress = (assignmentsWritten + noiseWritten) / Math.max(1, expectedAssignments + numNoise);
    percent = STAGE_FRACTION['writing'] - 0.25 + Math.min(0.25, writingProgress * 0.25);
  }
  if (row.status === 'done') percent = 1;
  if (row.status === 'error') percent = Math.min(percent, 0.99);

  // ETA: only useful inside the writing stage where rate is observable.
  let etaSeconds: number | null = null;
  if (stage === 'writing' && progress?.stageStartedAt) {
    const elapsed = (Date.now() - new Date(progress.stageStartedAt).getTime()) / 1000;
    const written = assignmentsWritten + noiseWritten;
    const remaining = (expectedAssignments + numNoise) - written;
    if (written > 0 && remaining > 0 && elapsed > 5) {
      etaSeconds = Math.round(remaining / (written / elapsed));
    }
  }

  // Stitch summary (populated after the stitching stage runs)
  const stitchProg = progress?.stitch;
  const stitch = stitchProg ? {
    prevRunId: stitchProg.prev_run_id,
    same:   stitchProg.same,
    grew:   stitchProg.grew,
    shrank: stitchProg.shrank,
    split:  stitchProg.split,
    merged: stitchProg.merged,
    born:   stitchProg.born,
    died:   stitchProg.died,
    totalNewClusters: stitchProg.total_new_clusters,
  } : null;

  return {
    runId: row.id,
    status: row.status,
    stage,
    source: row.source,
    startedAt: row.started_at?.toISOString?.() ?? null,
    completedAt: row.completed_at?.toISOString?.() ?? null,
    numClusters, numNoise, totalVideos,
    clustersWritten, assignmentsWritten, noiseWritten,
    expectedAssignments,
    percentComplete: Math.round(percent * 1000) / 10,  // one decimal place
    etaSeconds,
    errorMessage: row.error_message ?? null,
    recentLogs: progress?.recentLogs ?? [],
    stitch,
    stitchError: progress?.stitch_error ?? null,
  };
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  return NextResponse.json(await buildStatus());
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  let body: {
    source?: TreeSource;
    force?: boolean;
    minClusterSize?: number;
    minSamples?: number;
    umapDims?: number;
    minScore?: number;
  } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  // Detect existing in-flight run.
  const inflight = await pool.query<{ id: number; started_at: Date }>(
    `SELECT id, started_at FROM niche_tree_runs
       WHERE kind='global' AND status='running'
       ORDER BY started_at DESC LIMIT 1`,
  );
  if (inflight.rows.length > 0) {
    if (body.force) {
      await cancelGlobalRun(inflight.rows[0].id);
    } else {
      return NextResponse.json(
        { error: 'A run is already in progress; pass {force: true} to cancel and restart',
          runningRunId: inflight.rows[0].id },
        { status: 409 },
      );
    }
  }

  const params = {
    source:         body.source         ?? 'combined_v2',
    minClusterSize: body.minClusterSize ?? 80,
    minSamples:     body.minSamples     ?? 10,
    umapDims:       body.umapDims       ?? 50,
    minScore:       body.minScore       ?? 0,
  };

  const runRes = await pool.query<{ id: number }>(
    `INSERT INTO niche_tree_runs (kind, parent_cluster_id, level, source, params, status)
     VALUES ('global', NULL, 1, $1, $2, 'running')
     RETURNING id`,
    [params.source, JSON.stringify(params)],
  );
  const runId = runRes.rows[0].id;

  // Fire-and-forget; the job patches its own progress + status row.
  runGlobalClusteringJob(runId, params).catch(err => {
    console.error('[niche-tree-agent] run failed:', err);
  });

  return NextResponse.json({ ok: true, runId, params, status: 'started' });
}

export async function DELETE(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  const inflight = await pool.query<{ id: number }>(
    `SELECT id FROM niche_tree_runs
       WHERE kind='global' AND status='running'
       ORDER BY started_at DESC LIMIT 1`,
  );
  const runId = inflight.rows[0]?.id;
  if (!runId) return NextResponse.json({ error: 'No active run to cancel' }, { status: 404 });

  const result = await cancelGlobalRun(runId);
  return NextResponse.json({ ...result, runId });
}
