import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { runClusteringJob, labelClustersWithAI, getLatestClusterRun } from '@/lib/clustering';
import { isAdmin } from '@/lib/admin-auth';

/**
 * GET /api/niche-spy/clusters?keyword=X
 * Returns latest cluster run + cluster data for a keyword.
 */
export async function GET(req: NextRequest) {
  const keyword = req.nextUrl.searchParams.get('keyword');
  if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 });

  const result = await getLatestClusterRun(keyword);
  if (!result) return NextResponse.json({ run: null, clusters: [] });

  return NextResponse.json(result);
}

/**
 * POST /api/niche-spy/clusters
 * Start a clustering job or upgrade labels. Admin only.
 * Body: { keyword, action?: 'cluster' | 'label', minClusterSize?, minSamples?, umapDims? }
 */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  const body = await req.json();
  const { keyword, action = 'cluster', minClusterSize, minSamples, umapDims } = body;

  if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 });

  if (action === 'label') {
    // AI label upgrade for latest run
    const latest = await getLatestClusterRun(keyword);
    if (!latest || latest.run.status !== 'done') {
      return NextResponse.json({ error: 'No completed cluster run to label' }, { status: 400 });
    }
    // Fire and forget
    labelClustersWithAI(latest.run.id, keyword).then(result => {
      console.log(`[clustering] AI labeling done: ${result.labeled} labeled, ${result.errors} errors`);
    }).catch(err => {
      console.error('[clustering] AI labeling error:', err);
    });
    return NextResponse.json({ ok: true, status: 'labeling', runId: latest.run.id });
  }

  // Check for already running job — allow re-run if stuck for >5 min
  const runningRes = await pool.query(
    `SELECT id, started_at FROM niche_cluster_runs WHERE keyword = $1 AND status IN ('running', 'labeling') LIMIT 1`,
    [keyword]
  );
  if (runningRes.rows.length > 0) {
    const stuckMinutes = (Date.now() - new Date(runningRes.rows[0].started_at).getTime()) / 60000;
    if (stuckMinutes < 5) {
      return NextResponse.json({ error: 'Clustering already in progress', runId: runningRes.rows[0].id }, { status: 409 });
    }
    // Stuck for >5 min — mark as error and allow re-run
    await pool.query(
      `UPDATE niche_cluster_runs SET status = 'error', error_message = 'Timed out (stuck >5min)', completed_at = NOW() WHERE id = $1`,
      [runningRes.rows[0].id]
    );
  }

  // Count embedded videos
  const countRes = await pool.query(
    `SELECT COUNT(*) as cnt FROM niche_spy_videos WHERE keyword = $1 AND title_embedding IS NOT NULL`,
    [keyword]
  );
  const embeddedCount = parseInt(countRes.rows[0].cnt);
  if (embeddedCount < 10) {
    return NextResponse.json({ error: `Only ${embeddedCount} embedded videos. Need at least 10.` }, { status: 400 });
  }

  // Create run record
  const params = { minClusterSize, minSamples, umapDims: umapDims || 50 };
  const runRes = await pool.query(
    `INSERT INTO niche_cluster_runs (keyword, params, total_videos) VALUES ($1, $2, $3) RETURNING id`,
    [keyword, JSON.stringify(params), embeddedCount]
  );
  const runId = runRes.rows[0].id;

  // Fire and forget
  runClusteringJob(runId, keyword, params).catch(err => {
    console.error('[clustering] Job failed:', err);
  });

  return NextResponse.json({ ok: true, status: 'started', runId, embeddedVideos: embeddedCount });
}
