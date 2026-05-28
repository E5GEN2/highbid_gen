import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { runCustomNicheClusteringJob, type TreeClusterParams } from '@/lib/niche-tree';

/**
 * Sub-clustering for a custom niche.
 *
 * POST /api/niche-spy/custom-niches/[id]/cluster
 *   body (all optional):
 *     { minClusterSize?, minSamples?, umapDims?, nNeighbors?,
 *       outlierIqrMult?, source?, executionMode? }
 *   → { ok, runId }
 *
 *   Starts a background HDBSCAN run scoped to the niche's videos.
 *   Reuses the niche_tree pipeline (lib/niche-tree.ts) — same Python
 *   script, same niche_tree_clusters + niche_tree_assignments tables,
 *   just filtered to this niche and scoped via custom_niche_id on the
 *   run row. Tiny inputs (<5K videos, always the case here) run on
 *   the local CPU subprocess.
 *
 *   Replaces the niche's previous sub-cluster set on success (old
 *   niche_tree_clusters with this custom_niche_id are deleted before
 *   the run's results are inserted).
 *
 * GET /api/niche-spy/custom-niches/[id]/cluster
 *   → { ok, run, clusters: [...] }
 *
 *   Returns the latest sub-clustering run for this niche plus its
 *   clusters (with rep video + ai_label/auto_label/label joined).
 *   Returns { ok: true, run: null, clusters: [] } if the niche has
 *   never been clustered.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const body = await req.json().catch(() => ({})) as Partial<TreeClusterParams>;
  const params: TreeClusterParams | undefined = Object.keys(body).length > 0 ? body : undefined;

  const pool = await getPool();
  // Sanity check the niche exists.
  const nicheRow = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM custom_niches WHERE id = $1`, [nicheId],
  );
  if (nicheRow.rows.length === 0) {
    return NextResponse.json({ error: 'custom niche not found' }, { status: 404 });
  }

  // Refuse to start a second run while one is already in flight for
  // this niche. The runCustomNicheClusteringJob would happily race
  // itself but the UI would get confused about which is the "latest".
  const inflight = await pool.query<{ id: number }>(
    `SELECT id FROM niche_tree_runs
      WHERE kind = 'custom_niche'
        AND custom_niche_id = $1
        AND status = 'running'
      LIMIT 1`,
    [nicheId],
  );
  if (inflight.rows.length > 0) {
    return NextResponse.json(
      { ok: false, error: 'a clustering run is already in progress for this niche', runId: inflight.rows[0].id },
      { status: 409 },
    );
  }

  // Create the run row up front so the GET endpoint can show "running"
  // immediately. runCustomNicheClusteringJob updates total_videos +
  // source once it knows them.
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO niche_tree_runs
       (kind, custom_niche_id, level, source, status, params, total_videos)
     VALUES ('custom_niche', $1, 1, $2, 'running', $3::jsonb, 0)
     RETURNING id`,
    [
      nicheId,
      (params?.source) || 'combined_v2',
      JSON.stringify(params ?? {}),
    ],
  );
  const runId = ins.rows[0].id;

  // Fire and forget — the run is durable in the DB row; the route's
  // 300s maxDuration is plenty for a few-hundred-video set but we
  // don't want to block the caller either way.
  void runCustomNicheClusteringJob({ runId, customNicheId: nicheId, params })
    .catch(err => console.error(`[custom-niche cluster ${nicheId}] uncaught:`, err));

  return NextResponse.json({ ok: true, runId });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const pool = await getPool();
  const runRes = await pool.query<{
    id: number; status: string; level: number; source: string;
    num_clusters: number; num_noise: number; total_videos: number;
    error_message: string | null; started_at: string; completed_at: string | null;
    progress: Record<string, unknown> | null;
  }>(
    `SELECT id, status, level, source,
            num_clusters, num_noise, total_videos,
            error_message, started_at, completed_at, progress
       FROM niche_tree_runs
      WHERE kind = 'custom_niche' AND custom_niche_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [nicheId],
  );
  if (runRes.rows.length === 0) {
    return NextResponse.json({ ok: true, run: null, clusters: [] });
  }
  const run = runRes.rows[0];

  // Pull clusters in the shape NicheClusterCard expects. Same join
  // pattern as lib/niche-tree.ts getLatestGlobalRun — pulls top-4
  // popular videos per cluster + a distinct channel count so the
  // existing card component renders identically here.
  const clRes = await pool.query<{
    id: number; cluster_index: number; level: number;
    auto_label: string | null; ai_label: string | null; label: string | null;
    video_count: number; avg_score: number | null;
    total_views: number | null; avg_views: number | null;
    top_channels: string[] | null;
    channel_count: number;
    popular: Array<{
      video_id: number; title: string | null; thumbnail: string | null;
      url: string | null; view_count: number | null; channel_name: string | null;
    }> | null;
  }>(
    `WITH cluster_videos AS (
       SELECT c.id AS cluster_id,
              v.id, v.title, v.thumbnail, v.url, v.view_count, v.channel_name,
              ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY v.view_count DESC NULLS LAST) AS rn
         FROM niche_tree_clusters c
         JOIN niche_tree_assignments a ON a.cluster_id = c.id
         JOIN niche_spy_videos v ON v.id = a.video_id
        WHERE c.run_id = $1
     ),
     popular AS (
       SELECT cluster_id,
              jsonb_agg(jsonb_build_object(
                'video_id', id, 'title', title, 'thumbnail', thumbnail,
                'url', url, 'view_count', view_count, 'channel_name', channel_name
              ) ORDER BY view_count DESC NULLS LAST) AS rows
         FROM cluster_videos
        WHERE rn <= 4
        GROUP BY cluster_id
     ),
     channel_counts AS (
       SELECT c.id AS cluster_id,
              COUNT(DISTINCT v.channel_id)::int AS n
         FROM niche_tree_clusters c
         JOIN niche_tree_assignments a ON a.cluster_id = c.id
         JOIN niche_spy_videos v ON v.id = a.video_id
        WHERE c.run_id = $1
        GROUP BY c.id
     )
     SELECT c.id, c.cluster_index, c.level,
            c.auto_label, c.ai_label, c.label,
            c.video_count, c.avg_score,
            c.total_views, c.avg_views, c.top_channels,
            COALESCE(ch.n, 0) AS channel_count,
            COALESCE(p.rows, '[]'::jsonb) AS popular
       FROM niche_tree_clusters c
       LEFT JOIN popular p        ON p.cluster_id = c.id
       LEFT JOIN channel_counts ch ON ch.cluster_id = c.id
      WHERE c.run_id = $1
      ORDER BY c.video_count DESC`,
    [run.id],
  );

  return NextResponse.json({
    ok: true,
    run: {
      id: run.id,
      status: run.status,
      level: run.level,
      source: run.source,
      numClusters: run.num_clusters,
      numNoise: run.num_noise,
      totalVideos: run.total_videos,
      errorMessage: run.error_message,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      progress: run.progress,
    },
    // Shape matches ClusterCardData from components/NicheClusterCard.tsx
    // so the consumer can pass these straight to <NicheClusterCard cluster=…>.
    clusters: clRes.rows.map(c => ({
      id: c.id,
      level: c.level,
      autoLabel: c.auto_label,
      aiLabel: c.ai_label,
      label: c.label,
      videoCount: c.video_count,
      channelCount: c.channel_count,
      avgScore: c.avg_score,
      avgViews: c.avg_views,
      totalViews: c.total_views,
      topChannels: c.top_channels || [],
      popularVideos: (c.popular || []).map(p => ({
        videoId: p.video_id,
        title: p.title,
        thumbnail: p.thumbnail,
        url: p.url,
        viewCount: p.view_count,
        channelName: p.channel_name,
      })),
      childrenCount: 0,
    })),
  });
}
