import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { runCustomNicheClusteringJob, type TreeClusterParams, type TreeSource } from '@/lib/niche-tree';

/**
 * Sub-clustering for a custom niche, source-aware.
 *
 * The same niche can hold cluster sets for several embedding sources
 * simultaneously (title_v2 / thumbnail_v2 / combined_v2). The UI flips
 * between them; each is a separate niche_tree_run row scoped by
 * (custom_niche_id, source).
 *
 * POST /api/niche-spy/custom-niches/[id]/cluster
 *   body: { source?, minClusterSize?, minSamples?, umapDims?, nNeighbors?, outlierIqrMult?, executionMode? }
 *   source default = 'combined_v2'. Valid: 'title_v2' | 'thumbnail_v2' | 'combined_v2'.
 *   Returns { ok, runId, source }.
 *
 *   Re-clustering with a given source wipes ONLY that source's prior
 *   clusters; other sources' results survive.
 *
 * GET /api/niche-spy/custom-niches/[id]/cluster?source=…
 *   source default = 'combined_v2' (returned in the response so the UI
 *   can pin its tab state). Response shape:
 *     {
 *       ok: true,
 *       source: <active source>,
 *       coverage: { title_v2: {embedded,total}, thumbnail_v2: {…}, combined_v2: {…} },
 *       run:      <run object for the active source | null>,
 *       clusters: <ClusterCardData[] for the active source>,
 *     }
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

const SUPPORTED_SOURCES: TreeSource[] = ['title_v2', 'thumbnail_v2', 'combined_v2'];

function normaliseSource(raw: string | null | undefined): TreeSource {
  return (SUPPORTED_SOURCES as string[]).includes(raw ?? '') ? (raw as TreeSource) : 'combined_v2';
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const body = await req.json().catch(() => ({})) as Partial<TreeClusterParams> & { source?: string };
  const source = normaliseSource(body.source);
  const params: TreeClusterParams = { ...(body as TreeClusterParams), source };

  const pool = await getPool();
  const nicheRow = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM custom_niches WHERE id = $1`, [nicheId],
  );
  if (nicheRow.rows.length === 0) {
    return NextResponse.json({ error: 'custom niche not found' }, { status: 404 });
  }

  // Refuse to start a second run for the SAME source while one is in
  // flight. Different sources can run in parallel — they touch
  // independent cluster sets.
  const inflight = await pool.query<{ id: number }>(
    `SELECT id FROM niche_tree_runs
      WHERE kind = 'custom_niche'
        AND custom_niche_id = $1
        AND source = $2
        AND status = 'running'
      LIMIT 1`,
    [nicheId, source],
  );
  if (inflight.rows.length > 0) {
    return NextResponse.json(
      { ok: false, error: `a ${source} clustering run is already in progress for this niche`, runId: inflight.rows[0].id, source },
      { status: 409 },
    );
  }

  const ins = await pool.query<{ id: number }>(
    `INSERT INTO niche_tree_runs
       (kind, custom_niche_id, level, source, status, params, total_videos)
     VALUES ('custom_niche', $1, 1, $2, 'running', $3::jsonb, 0)
     RETURNING id`,
    [nicheId, source, JSON.stringify(params)],
  );
  const runId = ins.rows[0].id;

  void runCustomNicheClusteringJob({ runId, customNicheId: nicheId, params })
    .catch(err => console.error(`[custom-niche cluster ${nicheId}/${source}] uncaught:`, err));

  return NextResponse.json({ ok: true, runId, source });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const source = normaliseSource(req.nextUrl.searchParams.get('source'));

  const pool = await getPool();

  // Per-source coverage: how many of this niche's videos have each
  // embedding type stored? Lets the UI flag "not enough title_v2
  // embeddings — request them" without an extra round trip.
  const coverageRes = await pool.query<{
    total: number;
    title_v2: number;
    thumbnail_v2: number;
    combined_v2: number;
  }>(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE v.title_embedding_v2     IS NOT NULL)::int AS title_v2,
       COUNT(*) FILTER (WHERE v.thumbnail_embedding_v2 IS NOT NULL)::int AS thumbnail_v2,
       COUNT(*) FILTER (WHERE v.combined_embedding_v2  IS NOT NULL)::int AS combined_v2
       FROM custom_niche_videos cnv
       JOIN niche_spy_videos v ON v.id = cnv.video_id
      WHERE cnv.custom_niche_id = $1`,
    [nicheId],
  );
  const cov = coverageRes.rows[0] || { total: 0, title_v2: 0, thumbnail_v2: 0, combined_v2: 0 };
  const coverage = {
    title_v2:     { embedded: cov.title_v2,     total: cov.total },
    thumbnail_v2: { embedded: cov.thumbnail_v2, total: cov.total },
    combined_v2:  { embedded: cov.combined_v2,  total: cov.total },
  };

  // Pull the latest run for the requested source (each source has its
  // own latest). Returns null if this source has never been clustered
  // for this niche.
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
      WHERE kind = 'custom_niche' AND custom_niche_id = $1 AND source = $2
      ORDER BY started_at DESC
      LIMIT 1`,
    [nicheId, source],
  );

  // List of all (source, latest run status) so the UI can render the
  // source tabs with a status dot — and tell whether each source has
  // ever been clustered. Cheap aggregate over the same runs table.
  const allRunsRes = await pool.query<{ source: string; status: string; num_clusters: number; started_at: string }>(
    `SELECT DISTINCT ON (source) source, status, num_clusters, started_at
       FROM niche_tree_runs
      WHERE kind = 'custom_niche' AND custom_niche_id = $1
      ORDER BY source, started_at DESC`,
    [nicheId],
  );
  const runsBySource: Record<string, { status: string; numClusters: number; startedAt: string }> = {};
  for (const r of allRunsRes.rows) {
    runsBySource[r.source] = {
      status: r.status,
      numClusters: r.num_clusters,
      startedAt: r.started_at,
    };
  }

  if (runRes.rows.length === 0) {
    return NextResponse.json({ ok: true, source, coverage, runsBySource, run: null, clusters: [] });
  }
  const run = runRes.rows[0];

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
    source,
    coverage,
    runsBySource,
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
