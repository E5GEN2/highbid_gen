import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { runClusteringJob, labelClustersWithAI, getLatestClusterRun } from '@/lib/clustering';
import { isAdmin } from '@/lib/admin-auth';

/**
 * GET /api/niche-spy/clusters?keyword=X
 * Returns latest cluster run + cluster data for a keyword.
 *
 * Each cluster is enriched with the same channel + opportunity stats shown on
 * niche cards (channelCount, highScoreCount, newChannelCount, opportunity.*)
 * so the sub-niche cards can render identically to keyword cards.
 */
export async function GET(req: NextRequest) {
  const keyword = req.nextUrl.searchParams.get('keyword');
  if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 });

  const result = await getLatestClusterRun(keyword);
  if (!result) return NextResponse.json({ run: null, clusters: [] });

  // If there's no completed run there are no clusters to enrich
  if (result.clusters.length === 0 || !result.run) return NextResponse.json(result);

  const pool = await getPool();
  const runId = result.run.id;

  // Compute per-cluster stats in a single query: channel count + score bucket counts
  // + opportunity stats (NOS / top-left / newcomer / ceiling), exactly like the
  // keywords endpoint does per keyword. Scoped to this run's cluster_id set.
  const statsRes = await pool.query(`
    WITH all_videos AS (
      SELECT a.cluster_id, v.channel_name, v.score, v.channel_created_at
      FROM niche_cluster_assignments a
      JOIN niche_spy_videos v ON v.id = a.video_id
      WHERE a.run_id = $1
    ),
    counts AS (
      SELECT cluster_id,
             COUNT(DISTINCT channel_name) AS channel_count,
             COUNT(*) FILTER (WHERE score >= 80) AS high_score_count,
             COUNT(DISTINCT channel_name) FILTER (WHERE channel_created_at > NOW() - INTERVAL '180 days') AS new_channel_count
      FROM all_videos
      GROUP BY cluster_id
    ),
    scored AS (
      SELECT a.cluster_id, v.view_count AS v, v.subscriber_count AS s, v.channel_created_at AS c,
             LOG(v.view_count::numeric) / LOG(GREATEST(v.subscriber_count, 10)::numeric) AS ratio
      FROM niche_cluster_assignments a
      JOIN niche_spy_videos v ON v.id = a.video_id
      WHERE a.run_id = $1
        AND v.score >= 80 AND v.view_count > 0 AND v.subscriber_count > 0
    ),
    agg AS (
      SELECT cluster_id,
             COUNT(*) AS sample,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ratio) AS nos,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS med_v,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS med_s,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY v)
               FILTER (WHERE c IS NOT NULL AND c > NOW() - INTERVAL '180 days') AS new_med_v,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY v)
               FILTER (WHERE s < 10000) AS low_sub_ceiling
      FROM scored
      GROUP BY cluster_id
    ),
    tl AS (
      SELECT s.cluster_id,
             COUNT(*) FILTER (WHERE s.v > a.med_v AND s.s < a.med_s)::float
               / NULLIF(COUNT(*), 0) * 100 AS top_left_pct
      FROM scored s JOIN agg a USING (cluster_id)
      GROUP BY s.cluster_id
    )
    SELECT c.cluster_id, c.channel_count, c.high_score_count, c.new_channel_count,
           a.sample, a.nos, a.med_v, a.new_med_v, a.low_sub_ceiling, t.top_left_pct
    FROM counts c
    LEFT JOIN agg a USING (cluster_id)
    LEFT JOIN tl t USING (cluster_id)
  `, [runId]);

  const statsByCluster = new Map<number, Record<string, unknown>>();
  for (const row of statsRes.rows) {
    statsByCluster.set(row.cluster_id, row);
  }

  const enrichedClusters = result.clusters.map(c => {
    const stats = statsByCluster.get(c.id);
    if (!stats) return { ...c, channelCount: 0, highScoreCount: 0, newChannelCount: 0, opportunity: null };

    const sample = parseInt(stats.sample as string) || 0;
    const nos = parseFloat(stats.nos as string) || 0;
    const medV = parseFloat(stats.med_v as string) || 0;
    const newMedV = parseFloat(stats.new_med_v as string) || 0;
    const nosDisplay = Math.round(Math.max(0, Math.min(100, ((nos - 0.5) / 2.0) * 100)));

    // Need >=10 high-score videos for indicators to be meaningful (same rule as niches)
    const opportunity = sample >= 10 ? {
      sample, nos, nosDisplay,
      topLeftPct: Math.round(parseFloat(stats.top_left_pct as string) || 0),
      newcomerRate: medV > 0 ? Math.round((newMedV / medV) * 100) : 0,
      lowSubCeiling: Math.round(parseFloat(stats.low_sub_ceiling as string) || 0),
    } : null;

    return {
      ...c,
      channelCount: parseInt(stats.channel_count as string) || 0,
      highScoreCount: parseInt(stats.high_score_count as string) || 0,
      newChannelCount: parseInt(stats.new_channel_count as string) || 0,
      opportunity,
    };
  });

  return NextResponse.json({ run: result.run, clusters: enrichedClusters });
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
  const { keyword, action = 'cluster', minClusterSize, minSamples, umapDims, minScore } = body;

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
  const params = { minClusterSize, minSamples, umapDims: umapDims || 50, minScore: minScore || 80 };
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
