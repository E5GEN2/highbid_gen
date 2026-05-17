import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { findSimilarClustersByVector, getClusterVector } from '@/lib/vector-db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/niche-spy/clusters/[clusterId]/similar?k=12
 *
 * Returns up to K niche-tree clusters whose signature vector is closest
 * (cosine) to the source cluster's vector. Mixed L1 + L2 — caller renders
 * the badge so the user can see the level mix at a glance.
 *
 * Powered by niche_tree_cluster_vectors (pgvector halfvec(3072)). The
 * source cluster is excluded from the result set.
 *
 * Response shape mirrors /api/niche-spy/search-niches so the existing
 * NicheClusterCard component renders results without any tweaks.
 *
 * Slug is `clusterId` (not `id`) to match the sibling route
 * `/api/niche-spy/clusters/[clusterId]/videos` — Next.js requires
 * consistent slug names within the same dynamic path segment.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ clusterId: string }> }) {
  const { clusterId } = await ctx.params;
  const sourceClusterId = parseInt(clusterId);
  if (Number.isNaN(sourceClusterId)) {
    return NextResponse.json({ error: 'invalid cluster id' }, { status: 400 });
  }

  const k = Math.max(1, Math.min(parseInt(_req.nextUrl.searchParams.get('k') || '12'), 50));

  // 1. Load the source cluster's signature vector.
  const pool = await getPool();
  const embedding = await getClusterVector(sourceClusterId);
  if (!embedding) {
    return NextResponse.json({ similar: [], reason: 'source cluster has no signature vector' });
  }

  // 2. Find K+1 closest (we'll filter the source out and trim to K).
  //    No level filter — caller asked for mixed L1+L2.
  const hits = await findSimilarClustersByVector(embedding, { limit: k + 1 });
  const filtered = hits.filter(h => h.clusterId !== sourceClusterId).slice(0, k);
  if (filtered.length === 0) {
    return NextResponse.json({ similar: [] });
  }
  const ids = filtered.map(h => h.clusterId);
  const simMap = new Map(filtered.map(h => [h.clusterId, h.similarity]));

  // 3. Hydrate each cluster with the same fields the niche-card UI uses.
  //    Rep video LEFT JOIN excludes thumbnail-dead rows so cards don't
  //    surface broken thumbnails (same filter as search-niches).
  const clRes = await pool.query<{
    id: number; run_id: number; parent_cluster_id: number | null; level: number; cluster_index: number;
    auto_label: string | null; ai_label: string | null; label: string | null;
    video_count: number;
    avg_score: number | null; avg_views: string | null; total_views: string | null;
    top_channels: string[] | null;
    representative_video_id: number | null;
    rep_title: string | null; rep_thumbnail: string | null; rep_url: string | null;
    rep_view_count: string | null; rep_channel_name: string | null;
  }>(
    `SELECT
       c.id, c.run_id, c.parent_cluster_id, c.level, c.cluster_index,
       c.auto_label, c.ai_label, c.label, c.video_count, c.avg_score,
       c.avg_views, c.total_views, c.top_channels, c.representative_video_id,
       v.title         AS rep_title,
       v.thumbnail     AS rep_thumbnail,
       v.url           AS rep_url,
       v.view_count    AS rep_view_count,
       v.channel_name  AS rep_channel_name
     FROM niche_tree_clusters c
     LEFT JOIN niche_spy_videos v ON v.id = c.representative_video_id AND v.thumbnail_dead_at IS NULL
     WHERE c.id = ANY($1::int[])`,
    [ids],
  );

  // 4. Top-4 popular videos per cluster — same dedupe-by-channel +
  //    closest-to-centroid query the niche-card surface uses elsewhere.
  const popRes = await pool.query<{
    cluster_id: number; video_id: number;
    title: string | null; thumbnail: string | null; url: string | null;
    view_count: string | null; channel_name: string | null;
  }>(
    `WITH per_channel AS (
       SELECT a.cluster_id, v.id AS video_id, v.title, v.thumbnail, v.url, v.view_count,
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
    [ids],
  );
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

  // 5. Map rows preserving the cosine-similarity ordering (clRes returns
  //    in arbitrary order; sort by the simMap before emitting).
  const clusters = clRes.rows
    .map(c => ({
      id: c.id,
      runId: c.run_id,
      parentClusterId: c.parent_cluster_id,
      level: c.level,
      clusterIndex: c.cluster_index,
      autoLabel: c.auto_label,
      aiLabel: c.ai_label,
      label: c.label,
      videoCount: c.video_count,
      avgScore: c.avg_score,
      avgViews: c.avg_views != null ? parseInt(c.avg_views) : null,
      totalViews: c.total_views != null ? parseInt(c.total_views) : null,
      topChannels: c.top_channels || [],
      representativeVideoId: c.representative_video_id,
      repTitle: c.rep_title,
      repThumbnail: c.rep_thumbnail,
      repUrl: c.rep_url,
      repViewCount: c.rep_view_count != null ? parseInt(c.rep_view_count) : null,
      repChannelName: c.rep_channel_name,
      popularVideos: popByCluster.get(c.id) || [],
      similarity: simMap.get(c.id) ?? 0,
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return NextResponse.json({
    sourceClusterId,
    k,
    similar: clusters,
  });
}
