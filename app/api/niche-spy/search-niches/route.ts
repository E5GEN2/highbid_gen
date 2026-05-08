import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { searchNichesByText } from '@/lib/niche-search';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * POST /api/niche-spy/search-niches
 *
 * Semantic NICHE search — embeds the text query in the combined_v2
 * multimodal space and finds the closest niche clusters across both
 * L1 and L2. Returns full cluster cards (with rep video, top channels,
 * popular videos) ranked by cosine similarity.
 *
 * Same query string is cached in search_queries so a popular query
 * doesn't re-pay the Gemini round trip.
 *
 * Body: { query: string, limit?: number, minSimilarity?: number, level?: 1 | 2 }
 *   query           text to search by (required, 2-300 chars)
 *   limit           max niches to return (default 60, cap 200)
 *   minSimilarity   drop matches below this cosine similarity (default 0)
 *   level           filter to a specific tree level (omit = all)
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    query?: string;
    limit?: number;
    minSimilarity?: number;
    level?: number;
  };

  const raw = (body.query || '').trim();
  if (!raw) return NextResponse.json({ error: 'query required' }, { status: 400 });
  if (raw.length > 300) return NextResponse.json({ error: 'query too long (max 300 chars)' }, { status: 400 });

  const limit = Math.min(Math.max(parseInt(String(body.limit ?? 60)) || 60, 1), 200);
  const minSimilarity = Math.max(0, Math.min(1, body.minSimilarity ?? 0));
  const level = body.level === 1 || body.level === 2 ? body.level : undefined;

  let searchResult: Awaited<ReturnType<typeof searchNichesByText>>;
  try {
    searchResult = await searchNichesByText({ query: raw, limit, minSimilarity, level });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const { hitFromCache, results: hits } = searchResult;
  if (hits.length === 0) {
    return NextResponse.json({ query: raw, hitFromCache, count: 0, niches: [] });
  }

  // Hydrate cluster cards from the main DB. Same shape as
  // /api/niche-spy/tree-clusters returns so the existing
  // NicheClusterCard renders without changes.
  const pool = await getPool();
  const ids = hits.map(h => h.clusterId);
  const simMap = new Map(hits.map(h => [h.clusterId, h.similarity]));

  // Cluster rows + rep video info.
  const clRes = await pool.query(
    `SELECT
       c.id, c.run_id, c.parent_cluster_id, c.level, c.cluster_index,
       c.auto_label, c.label, c.video_count, c.avg_score,
       c.avg_views, c.total_views, c.top_channels, c.representative_video_id,
       v.title         AS rep_title,
       v.thumbnail     AS rep_thumbnail,
       v.url           AS rep_url,
       v.view_count    AS rep_view_count,
       v.channel_name  AS rep_channel_name
     FROM niche_tree_clusters c
     LEFT JOIN niche_spy_videos v ON v.id = c.representative_video_id
     WHERE c.id = ANY($1::int[])`,
    [ids],
  );

  // Children counts so the "N sub-niches" pill renders correctly.
  const childCountRes = await pool.query<{ parent_cluster_id: number; cnt: string }>(
    `SELECT parent_cluster_id, COUNT(*)::text AS cnt
       FROM niche_tree_clusters
      WHERE parent_cluster_id = ANY($1::int[])
   GROUP BY parent_cluster_id`,
    [ids],
  );
  const childrenByParent = new Map<number, number>();
  for (const r of childCountRes.rows) childrenByParent.set(r.parent_cluster_id, parseInt(r.cnt));

  // 4 popular videos per cluster — same query shape used by tree-clusters
  // / getLatestGlobalRun. Closest-to-centroid + dedupe by channel.
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
  const popByCluster = new Map<number, Array<{ videoId: number; title: string | null; thumbnail: string | null; url: string | null; viewCount: number | null; channelName: string | null }>>();
  for (const row of popRes.rows) {
    const arr = popByCluster.get(row.cluster_id) || [];
    arr.push({
      videoId: row.video_id, title: row.title, thumbnail: row.thumbnail, url: row.url,
      viewCount: row.view_count != null ? parseInt(row.view_count) : null,
      channelName: row.channel_name,
    });
    popByCluster.set(row.cluster_id, arr);
  }

  // Distinct-channel count per cluster (replaces the redundant
  // "Videos" tile on the card — see NicheClusterCard).
  const channelCountByCluster = new Map<number, number>();
  const ccRes = await pool.query<{ cluster_id: number; cnt: string }>(
    `SELECT a.cluster_id, COUNT(DISTINCT v.channel_name)::text AS cnt
       FROM niche_tree_assignments a
       JOIN niche_spy_videos v ON v.id = a.video_id
      WHERE a.cluster_id = ANY($1::int[]) AND v.channel_name IS NOT NULL AND v.channel_name <> ''
      GROUP BY a.cluster_id`,
    [ids],
  );
  for (const row of ccRes.rows) channelCountByCluster.set(row.cluster_id, parseInt(row.cnt) || 0);

  // Upload heartbeat — 52 weekly buckets per cluster covering the
  // last year. Same shape as the lib/niche-tree.ts helper but
  // inlined here since we already have the cluster id allowlist.
  const HISTOGRAM_WEEKS = 52;
  const histogramByCluster = new Map<number, number[]>();
  const hRes = await pool.query<{ cluster_id: number; weeks_ago: number; cnt: number }>(
    `SELECT a.cluster_id,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - v.posted_at)) / 604800)::int AS weeks_ago,
            COUNT(*)::int AS cnt
       FROM niche_tree_assignments a
       JOIN niche_spy_videos v ON v.id = a.video_id
      WHERE a.cluster_id = ANY($1::int[])
        AND v.posted_at IS NOT NULL
        AND v.posted_at > NOW() - INTERVAL '${HISTOGRAM_WEEKS} weeks'
   GROUP BY a.cluster_id, weeks_ago`,
    [ids],
  );
  for (const row of hRes.rows) {
    const wAgo = row.weeks_ago;
    if (wAgo < 0 || wAgo >= HISTOGRAM_WEEKS) continue;
    let arr = histogramByCluster.get(row.cluster_id);
    if (!arr) { arr = new Array(HISTOGRAM_WEEKS).fill(0); histogramByCluster.set(row.cluster_id, arr); }
    arr[HISTOGRAM_WEEKS - 1 - wAgo] = row.cnt;
  }

  const niches = clRes.rows
    .map(row => ({
      id: row.id,
      level: row.level,
      parentClusterId: row.parent_cluster_id,
      autoLabel: row.auto_label,
      label: row.label,
      videoCount: row.video_count,
      avgScore: row.avg_score != null ? Number(row.avg_score) : null,
      avgViews: row.avg_views != null ? Number(row.avg_views) : null,
      totalViews: row.total_views != null ? Number(row.total_views) : null,
      topChannels: row.top_channels || [],
      representativeVideoId: row.representative_video_id,
      repTitle: row.rep_title,
      repThumbnail: row.rep_thumbnail,
      repUrl: row.rep_url,
      repViewCount: row.rep_view_count != null ? Number(row.rep_view_count) : null,
      repChannelName: row.rep_channel_name,
      popularVideos: popByCluster.get(row.id) || [],
      channelCount: channelCountByCluster.get(row.id) ?? 0,
      uploadHistogram: histogramByCluster.get(row.id) || new Array(HISTOGRAM_WEEKS).fill(0),
      childrenCount: childrenByParent.get(row.id) ?? 0,
      similarity: simMap.get(row.id) ?? 0,
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return NextResponse.json({ query: raw, hitFromCache, count: niches.length, niches });
}
