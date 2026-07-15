import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { auth } from '@/lib/auth';
import { fetchUploadHistograms, fetchClusterOpportunities } from '@/lib/niche-tree';

/**
 * Niche-level favourites — parallel to /api/niche-spy/favourites but
 * keyed by cluster_id instead of video_id.
 *
 * GET    /api/niche-spy/favourite-niches             → full cluster cards (hydrated)
 * GET    /api/niche-spy/favourite-niches?onlyIds=1   → just the ids (light, for star state)
 * POST   /api/niche-spy/favourite-niches  {clusterId} → star
 * DELETE /api/niche-spy/favourite-niches  {clusterId} → unstar
 *
 * The hydrated GET returns the same shape as /api/niche-spy/tree-clusters
 * so the existing NicheClusterCard component renders favourite niches
 * with zero tweaks.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  const pool = await getPool();
  const onlyIds = req.nextUrl.searchParams.get('onlyIds') === '1';

  if (!userId) {
    // Logged out → no favourites (don't 401 a GET; let the page render empty).
    return onlyIds ? NextResponse.json({ ids: [] }) : NextResponse.json({ niches: [], total: 0 });
  }

  if (onlyIds) {
    const r = await pool.query(
      `SELECT cluster_id FROM niche_spy_favourite_clusters WHERE user_id = $1 ORDER BY added_at DESC`,
      [userId],
    );
    return NextResponse.json({ ids: r.rows.map((row: { cluster_id: number }) => row.cluster_id) });
  }

  // 1. Pull the cluster rows in favourite-order (most recently starred first).
  //    Drop dead-thumb rep videos via the same LEFT JOIN tree-clusters uses.
  const clRes = await pool.query<{
    id: number; run_id: number; parent_cluster_id: number | null; level: number; cluster_index: number;
    auto_label: string | null; ai_label: string | null; label: string | null;
    video_count: number;
    avg_score: number | null; avg_views: string | null; total_views: string | null;
    top_channels: string[] | null;
    representative_video_id: number | null;
    rep_title: string | null; rep_thumbnail: string | null; rep_url: string | null;
    rep_view_count: string | null; rep_channel_name: string | null;
    added_at: string;
  }>(
    `SELECT
       c.id, c.run_id, c.parent_cluster_id, c.level, c.cluster_index,
       c.auto_label, c.ai_label, c.label, c.video_count, c.avg_score,
       c.avg_views, c.total_views, c.top_channels, c.representative_video_id,
       v.title         AS rep_title,
       v.thumbnail     AS rep_thumbnail,
       v.url           AS rep_url,
       v.view_count    AS rep_view_count,
       v.channel_name  AS rep_channel_name,
       f.added_at
     FROM niche_spy_favourite_clusters f
     JOIN niche_tree_clusters c ON c.id = f.cluster_id
     LEFT JOIN niche_spy_videos v ON v.id = c.representative_video_id AND v.thumbnail_dead_at IS NULL
     WHERE f.user_id = $1
     ORDER BY f.added_at DESC`,
    [userId],
  );
  if (clRes.rows.length === 0) {
    return NextResponse.json({ niches: [], total: 0 });
  }
  const allClusterIds = clRes.rows.map(r => r.id);
  const l1IdsOnPage = clRes.rows.filter(r => r.parent_cluster_id == null).map(r => r.id);

  // 2. Hydrate with the same per-cluster aggregates the niches grid
  //    uses (popular videos / channel count / histogram / opportunity
  //    / children stats). Same query shapes — all in parallel.
  const [popRes, ccRes, histogramByCluster, opportunityByCluster, csRes] = await Promise.all([
    pool.query<{
      cluster_id: number; video_id: number;
      title: string | null; thumbnail: string | null; url: string | null;
      view_count: string | null; channel_name: string | null;
    }>(
      `WITH per_channel AS (
         SELECT a.cluster_id,
                v.id AS video_id, v.title, v.thumbnail, v.url, v.view_count,
                v.channel_name, a.distance_to_centroid,
                ROW_NUMBER() OVER (
                  PARTITION BY a.cluster_id, v.channel_name
                  ORDER BY a.distance_to_centroid ASC NULLS LAST
                ) AS channel_rn
           FROM niche_tree_assignments a
           JOIN niche_spy_videos v ON v.id = a.video_id
          WHERE a.cluster_id = ANY($1::int[])
            AND v.channel_name IS NOT NULL
            AND v.thumbnail_dead_at IS NULL
       ),
       ranked AS (
         SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY cluster_id
                    ORDER BY distance_to_centroid ASC NULLS LAST
                  ) AS rn
           FROM per_channel WHERE channel_rn = 1
       )
       SELECT cluster_id, video_id, title, thumbnail, url, view_count, channel_name
         FROM ranked WHERE rn <= 4 ORDER BY cluster_id, rn`,
      [allClusterIds],
    ),
    pool.query<{ cluster_id: number; cnt: string }>(
      `SELECT a.cluster_id, COUNT(DISTINCT v.channel_name)::text AS cnt
         FROM niche_tree_assignments a
         JOIN niche_spy_videos v ON v.id = a.video_id
        WHERE a.cluster_id = ANY($1::int[]) AND v.channel_name IS NOT NULL AND v.channel_name <> ''
        GROUP BY a.cluster_id`,
      [allClusterIds],
    ),
    fetchUploadHistograms(pool, { clusterIds: allClusterIds }),
    fetchClusterOpportunities(pool, { clusterIds: allClusterIds }),
    l1IdsOnPage.length > 0
      ? pool.query<{ parent_id: number; children_count: string }>(
          `SELECT parent_cluster_id AS parent_id, COUNT(*)::text AS children_count
             FROM niche_tree_clusters
             WHERE parent_cluster_id = ANY($1::int[])
             GROUP BY parent_cluster_id`,
          [l1IdsOnPage],
        )
      : Promise.resolve({ rows: [] as Array<{ parent_id: number; children_count: string }> }),
  ]);

  const popByCluster = new Map<number, Array<{
    videoId: number; title: string | null; thumbnail: string | null; url: string | null;
    viewCount: number | null; channelName: string | null;
  }>>();
  for (const row of popRes.rows) {
    const arr = popByCluster.get(row.cluster_id) || [];
    arr.push({
      videoId: row.video_id, title: row.title, thumbnail: row.thumbnail, url: row.url,
      viewCount: row.view_count != null ? parseInt(row.view_count) : null,
      channelName: row.channel_name,
    });
    popByCluster.set(row.cluster_id, arr);
  }
  const channelCountByCluster = new Map<number, number>();
  for (const r of ccRes.rows) channelCountByCluster.set(r.cluster_id, parseInt(r.cnt) || 0);
  const childrenCountByParent = new Map<number, number>();
  for (const r of csRes.rows) childrenCountByParent.set(r.parent_id, parseInt(r.children_count) || 0);

  // 3. Mirror the tree-clusters response shape so the /niche/favourites
  //    page can hand the data straight to NicheClusterCard.
  const niches = clRes.rows.map(c => ({
    id: c.id,
    level: c.level,
    parentClusterId: c.parent_cluster_id,
    autoLabel: c.auto_label,
    aiLabel: c.ai_label,
    label: c.label,
    videoCount: c.video_count,
    avgScore: c.avg_score,
    avgViews: c.avg_views != null ? parseInt(c.avg_views) : null,
    totalViews: c.total_views != null ? parseInt(c.total_views) : null,
    topChannels: c.top_channels || [],
    popularVideos: popByCluster.get(c.id) || [],
    channelCount: channelCountByCluster.get(c.id) ?? 0,
    uploadHistogram: histogramByCluster.get(c.id) || new Array(52).fill(0),
    opportunity: opportunityByCluster.get(c.id) ?? null,
    childrenCount: childrenCountByParent.get(c.id) ?? 0,
    addedAt: c.added_at,
  }));

  return NextResponse.json({ niches, total: niches.length });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const pool = await getPool();
  const { clusterId } = await req.json().catch(() => ({}));
  if (!clusterId || typeof clusterId !== 'number') {
    return NextResponse.json({ error: 'clusterId (number) required' }, { status: 400 });
  }
  // Defence: refuse if the cluster doesn't exist
  const check = await pool.query('SELECT 1 FROM niche_tree_clusters WHERE id = $1', [clusterId]);
  if (check.rows.length === 0) return NextResponse.json({ error: 'Cluster not found' }, { status: 404 });

  await pool.query(
    `INSERT INTO niche_spy_favourite_clusters (user_id, cluster_id) VALUES ($1, $2) ON CONFLICT (user_id, cluster_id) DO NOTHING`,
    [session.user.id, clusterId],
  );
  return NextResponse.json({ ok: true, starred: true });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const pool = await getPool();
  const { clusterId } = await req.json().catch(() => ({}));
  if (!clusterId || typeof clusterId !== 'number') {
    return NextResponse.json({ error: 'clusterId (number) required' }, { status: 400 });
  }
  await pool.query(`DELETE FROM niche_spy_favourite_clusters WHERE user_id = $1 AND cluster_id = $2`, [session.user.id, clusterId]);
  return NextResponse.json({ ok: true, starred: false });
}
