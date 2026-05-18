import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { fetchUploadHistograms, fetchClusterOpportunities } from '@/lib/niche-tree';

/**
 * Custom niches — user-curated video collections (vs. the
 * auto-discovered niche_tree_clusters).
 *
 * GET  /api/niche-spy/custom-niches → every niche with full card
 *   stats (avg/total views, channel count, top channels, popular
 *   videos, 52-week heartbeat, OPP score). Same shape NicheClusterCard
 *   consumes for auto clusters, so the My Niches grid can render the
 *   exact same card. Ordered by updated_at DESC.
 *
 *   Aggregates are computed on the fly. Five parallel queries: row
 *   counts, top channels, top-4 popular videos, upload heartbeat,
 *   opportunity score. Per-niche cost is small because user-curated
 *   collections are tens-of-videos, not thousands.
 *
 * POST /api/niche-spy/custom-niches → create a new one
 *   body: { name: string, description?: string }
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_NAME = 80;
const MAX_DESCRIPTION = 280;

export async function GET() {
  const pool = await getPool();

  // 1. Pull the base rows + a video count per niche. Same query as
  //    before — it gives us the niche metadata + tells us which
  //    nicheIds need aggregation.
  const baseRes = await pool.query<{
    id: number; name: string; description: string | null;
    video_count: string; created_at: string; updated_at: string;
  }>(
    `SELECT
       n.id, n.name, n.description, n.created_at, n.updated_at,
       COALESCE(c.cnt, 0)::text AS video_count
     FROM custom_niches n
     LEFT JOIN (
       SELECT custom_niche_id, COUNT(*) AS cnt
         FROM custom_niche_videos
         GROUP BY custom_niche_id
     ) c ON c.custom_niche_id = n.id
     ORDER BY n.updated_at DESC`,
  );

  const nicheIds = baseRes.rows.map(r => r.id);
  if (nicheIds.length === 0) {
    return NextResponse.json({ niches: [], total: 0 });
  }

  // 2. Aggregates in parallel — same fan-out pattern as the
  //    tree-clusters route. Each query keys results by
  //    custom_niche_id (which we alias to cluster_id in the helpers
  //    so the Map keys are interchangeable).
  const [aggRes, topChannelsRes, popularRes, histogramByNiche, opportunityByNiche] = await Promise.all([
    pool.query<{
      custom_niche_id: number;
      avg_views: string | null;
      total_views: string | null;
      avg_score: string | null;
      channel_count: string;
    }>(
      `SELECT m.custom_niche_id,
              AVG(v.view_count)::bigint::text       AS avg_views,
              SUM(v.view_count)::bigint::text       AS total_views,
              AVG(v.score)::numeric(6,2)::text      AS avg_score,
              COUNT(DISTINCT v.channel_name)::text  AS channel_count
         FROM custom_niche_videos m
         JOIN niche_spy_videos v ON v.id = m.video_id
        WHERE m.custom_niche_id = ANY($1::int[])
        GROUP BY m.custom_niche_id`,
      [nicheIds],
    ),
    pool.query<{ custom_niche_id: number; top_channels: string[] }>(
      // Top 3 channels by number of videos in the niche. Hoisted
      // window result back into an array_agg so we emit one row
      // per niche.
      `WITH ranked AS (
         SELECT m.custom_niche_id, v.channel_name,
                COUNT(*) AS cnt,
                ROW_NUMBER() OVER (
                  PARTITION BY m.custom_niche_id
                  ORDER BY COUNT(*) DESC NULLS LAST
                ) AS rn
           FROM custom_niche_videos m
           JOIN niche_spy_videos v ON v.id = m.video_id
          WHERE m.custom_niche_id = ANY($1::int[])
            AND v.channel_name IS NOT NULL AND v.channel_name <> ''
          GROUP BY m.custom_niche_id, v.channel_name
       )
       SELECT custom_niche_id,
              ARRAY_AGG(channel_name ORDER BY cnt DESC) AS top_channels
         FROM ranked
        WHERE rn <= 3
        GROUP BY custom_niche_id`,
      [nicheIds],
    ),
    pool.query<{
      custom_niche_id: number;
      video_id: number;
      title: string | null;
      thumbnail: string | null;
      url: string | null;
      view_count: string | null;
      channel_name: string | null;
    }>(
      // Top 4 popular videos by view_count per niche, deduped to
      // one per channel (mirrors what the auto cluster card does
      // with centroid distance). Custom niches don't have a
      // centroid, so views is the best proxy for "representative."
      `WITH per_channel AS (
         SELECT m.custom_niche_id,
                v.id AS video_id, v.title, v.thumbnail, v.url,
                v.view_count, v.channel_name,
                ROW_NUMBER() OVER (
                  PARTITION BY m.custom_niche_id, v.channel_name
                  ORDER BY v.view_count DESC NULLS LAST
                ) AS channel_rn
           FROM custom_niche_videos m
           JOIN niche_spy_videos v ON v.id = m.video_id
          WHERE m.custom_niche_id = ANY($1::int[])
            AND v.channel_name IS NOT NULL
            AND v.thumbnail_dead_at IS NULL
       ),
       ranked AS (
         SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY custom_niche_id
                    ORDER BY view_count DESC NULLS LAST
                  ) AS rn
           FROM per_channel WHERE channel_rn = 1
       )
       SELECT custom_niche_id, video_id, title, thumbnail, url, view_count, channel_name
         FROM ranked WHERE rn <= 4
        ORDER BY custom_niche_id, rn`,
      [nicheIds],
    ),
    fetchUploadHistograms(pool, { customNicheIds: nicheIds }),
    fetchClusterOpportunities(pool, { customNicheIds: nicheIds }),
  ]);

  // 3. Build per-niche lookups so the final assembly is O(1) per row.
  const aggByNiche = new Map<number, { avgViews: number | null; totalViews: number | null; avgScore: number | null; channelCount: number }>();
  for (const row of aggRes.rows) {
    aggByNiche.set(row.custom_niche_id, {
      avgViews: row.avg_views != null ? parseInt(row.avg_views) : null,
      totalViews: row.total_views != null ? parseInt(row.total_views) : null,
      avgScore: row.avg_score != null ? parseFloat(row.avg_score) : null,
      channelCount: parseInt(row.channel_count) || 0,
    });
  }
  const topChannelsByNiche = new Map<number, string[]>();
  for (const row of topChannelsRes.rows) topChannelsByNiche.set(row.custom_niche_id, row.top_channels || []);
  const popularByNiche = new Map<number, Array<{
    videoId: number; title: string | null; thumbnail: string | null; url: string | null;
    viewCount: number | null; channelName: string | null;
  }>>();
  for (const row of popularRes.rows) {
    const arr = popularByNiche.get(row.custom_niche_id) || [];
    arr.push({
      videoId: row.video_id, title: row.title, thumbnail: row.thumbnail, url: row.url,
      viewCount: row.view_count != null ? parseInt(row.view_count) : null,
      channelName: row.channel_name,
    });
    popularByNiche.set(row.custom_niche_id, arr);
  }

  // 4. Assemble. Shape matches what NicheClusterCard's ClusterCardData
  //    expects, with `level: 0` + `kind: 'custom'` as sentinels for
  //    the card to render the custom variant.
  const niches = baseRes.rows.map(row => {
    const agg = aggByNiche.get(row.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      videoCount: parseInt(row.video_count) || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Card-shaped aggregates — populated even when zero so the
      // card never has to special-case missing fields.
      avgScore:     agg?.avgScore     ?? null,
      avgViews:     agg?.avgViews     ?? null,
      totalViews:   agg?.totalViews   ?? null,
      channelCount: agg?.channelCount ?? 0,
      topChannels:  topChannelsByNiche.get(row.id) ?? [],
      popularVideos: popularByNiche.get(row.id) ?? [],
      uploadHistogram: histogramByNiche.get(row.id) ?? new Array(52).fill(0),
      opportunity: opportunityByNiche.get(row.id) ?? null,
      childrenCount: 0,
    };
  });

  return NextResponse.json({ niches, total: niches.length });
}

export async function POST(req: NextRequest) {
  const pool = await getPool();
  const body = await req.json().catch(() => ({})) as { name?: string; description?: string };
  const name = (body.name || '').trim();
  const description = (body.description || '').trim() || null;
  if (!name) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  if (name.length > MAX_NAME) {
    return NextResponse.json({ error: `name must be ≤ ${MAX_NAME} chars` }, { status: 400 });
  }
  if (description && description.length > MAX_DESCRIPTION) {
    return NextResponse.json({ error: `description must be ≤ ${MAX_DESCRIPTION} chars` }, { status: 400 });
  }

  const r = await pool.query<{
    id: number; name: string; description: string | null;
    created_at: string; updated_at: string;
  }>(
    `INSERT INTO custom_niches (name, description) VALUES ($1, $2)
     RETURNING id, name, description, created_at, updated_at`,
    [name, description],
  );
  const row = r.rows[0];
  return NextResponse.json({
    niche: {
      id: row.id,
      name: row.name,
      description: row.description,
      videoCount: 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Empty aggregates for shape parity — a brand-new niche has
      // no videos so all the numeric fields are zero/null.
      avgScore: null, avgViews: null, totalViews: null,
      channelCount: 0, topChannels: [],
      popularVideos: [], uploadHistogram: new Array(52).fill(0),
      opportunity: null, childrenCount: 0,
    },
  });
}
