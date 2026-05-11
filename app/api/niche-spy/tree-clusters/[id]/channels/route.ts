import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/niche-spy/tree-clusters/[id]/channels
 *
 * Cluster-scoped channels list. Same return shape as
 * /api/niche-spy/channels so the existing NicheChannelCard component
 * renders without changes — just aggregated over videos belonging to
 * one tree cluster instead of one keyword.
 *
 * Params:
 *   sort      views | videos | subs | newest | score    (default: views)
 *   limit     default 60, max 200
 *   offset    default 0 — paginates with the page's infinite scroll
 *
 * Returns: { channels: NicheChannelCard[], total, stats }
 *
 * Channels are deduped by channel_id (with channel_name fallback for
 * legacy rows) — same dedup rule the niche-wide channels endpoint uses.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await ctx.params;
  const clusterId = parseInt(rawId);
  if (!clusterId) return NextResponse.json({ error: 'invalid cluster id' }, { status: 400 });

  const pool = await getPool();
  const sp = req.nextUrl.searchParams;
  const sort = sp.get('sort') || 'views';
  const limit = Math.min(parseInt(sp.get('limit') || '60'), 200);
  const offset = parseInt(sp.get('offset') || '0');

  // Group key: channel_id when present, else "name:<channel_name>" so legacy
  // rows still bucket reasonably. Matches the niche-wide channels endpoint.
  const groupKey = `COALESCE(v.channel_id, 'name:' || v.channel_name)`;

  let orderBy: string;
  switch (sort) {
    case 'videos':  orderBy = 'video_count_in_cluster DESC'; break;
    case 'subs':    orderBy = 'max_subs DESC NULLS LAST'; break;
    case 'newest':  orderBy = 'channel_age_days ASC NULLS LAST'; break;
    case 'score':   orderBy = 'avg_score DESC'; break;
    default:        orderBy = 'total_views DESC NULLS LAST';
  }

  // The "membership" filter — pull every video assigned to this cluster.
  // Subquery in niche_tree_assignments restricted to cluster_id; we then
  // aggregate over the matching niche_spy_videos rows.
  //
  // For an L1 cluster the assignments table has direct rows (the L1's
  // members). For an L2 it's the same (L2 subdivide writes its own
  // assignments). Either way the cluster_id filter just works.
  const baseWhere = `
    WHERE v.id IN (
      SELECT video_id FROM niche_tree_assignments WHERE cluster_id = $1
    )
    AND v.channel_name IS NOT NULL AND v.channel_name != ''
  `;

  const [channelsRes, countRes, statsRes] = await Promise.all([
    pool.query(`
      SELECT
        MAX(v.channel_name)    AS channel_name,
        MAX(v.channel_avatar)  AS channel_avatar,
        MAX(v.channel_id)      AS channel_id,
        MIN(c.channel_handle)  AS channel_handle,
        MIN(c.first_upload_at) AS first_upload_at,
        MIN(c.dormancy_days)   AS dormancy_days,
        COUNT(*)               AS video_count_in_cluster,
        MIN(c.video_count)     AS total_video_count,
        SUM(v.view_count)      AS total_views,
        ROUND(AVG(v.view_count)) AS avg_views,
        MAX(v.view_count)      AS max_views,
        ROUND(AVG(v.score))    AS avg_score,
        MAX(v.score)           AS max_score,
        MAX(v.subscriber_count) AS max_subs,
        SUM(v.like_count)      AS total_likes,
        SUM(v.comment_count)   AS total_comments,
        COALESCE(MIN(c.channel_created_at), MAX(v.channel_created_at)) AS channel_created_at,
        EXTRACT(DAY FROM NOW() - COALESCE(MIN(c.first_upload_at), MIN(c.channel_created_at), MAX(v.channel_created_at))) AS channel_age_days,
        MAX(v.posted_at) AS latest_video_at,
        MIN(v.posted_at) AS earliest_video_at,
        ARRAY_AGG(DISTINCT v.keyword) FILTER (WHERE v.keyword IS NOT NULL) AS keywords
      FROM niche_spy_videos v
      LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
      ${baseWhere}
      GROUP BY ${groupKey}
      ORDER BY ${orderBy}
      LIMIT $2 OFFSET $3
    `, [clusterId, limit, offset]),

    pool.query(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT ${groupKey} AS k
        FROM niche_spy_videos v
        ${baseWhere}
        GROUP BY ${groupKey}
      ) sub
    `, [clusterId]),

    pool.query(`
      WITH channel_agg AS (
        SELECT
          ${groupKey} AS grp_key,
          COALESCE(MIN(c.first_upload_at), MIN(c.channel_created_at), MAX(v.channel_created_at)) AS effective_age_at,
          MAX(v.subscriber_count) AS subs
        FROM niche_spy_videos v
        LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
        ${baseWhere}
        GROUP BY ${groupKey}
      )
      SELECT
        COUNT(*) AS total_channels,
        COUNT(*) FILTER (WHERE effective_age_at > NOW() - INTERVAL '180 days') AS new_channels,
        COUNT(*) FILTER (WHERE effective_age_at > NOW() - INTERVAL '30 days') AS very_new_channels,
        COUNT(*) FILTER (WHERE effective_age_at <= NOW() - INTERVAL '180 days' OR effective_age_at IS NULL) AS established_channels,
        ROUND(AVG(subs) FILTER (WHERE effective_age_at > NOW() - INTERVAL '180 days'), 0) AS new_avg_subs,
        ROUND(AVG(subs) FILTER (WHERE effective_age_at <= NOW() - INTERVAL '180 days'), 0) AS est_avg_subs
      FROM channel_agg
    `, [clusterId]),
  ]);

  // Top-4 popular videos per channel for the wide-row card thumb strip.
  const groupKeys: string[] = channelsRes.rows.map(r =>
    r.channel_id ? r.channel_id : `name:${r.channel_name}`,
  );
  type PopRow = {
    grp_key: string; video_id: number; title: string | null;
    thumbnail: string | null; url: string | null;
    view_count: string | null; posted_at: Date | null; posted_date: string | null; score: number | null;
  };
  const popByChannel = new Map<string, Array<{
    videoId: number; title: string | null; thumbnail: string | null; url: string | null;
    viewCount: number | null; postedAt: string | null; postedDate: string | null; score: number | null;
  }>>();
  if (groupKeys.length > 0) {
    // Scope to cluster videos only so the thumb strip shows what's IN this
    // niche, not the channel's overall top — the cluster page is about
    // this niche after all.
    const popRes = await pool.query<PopRow>(
      `WITH ranked AS (
         SELECT
           COALESCE(v.channel_id, 'name:' || v.channel_name) AS grp_key,
           v.id AS video_id, v.title, v.thumbnail, v.url, v.view_count,
           v.posted_at, v.posted_date, v.score,
           ROW_NUMBER() OVER (
             PARTITION BY COALESCE(v.channel_id, 'name:' || v.channel_name)
             ORDER BY v.view_count DESC NULLS LAST
           ) AS rn
         FROM niche_spy_videos v
         WHERE COALESCE(v.channel_id, 'name:' || v.channel_name) = ANY($1::text[])
           AND v.id IN (SELECT video_id FROM niche_tree_assignments WHERE cluster_id = $2)
       )
       SELECT grp_key, video_id, title, thumbnail, url, view_count, posted_at, posted_date, score
         FROM ranked WHERE rn <= 4
       ORDER BY grp_key, rn`,
      [groupKeys, clusterId],
    );
    for (const row of popRes.rows) {
      const arr = popByChannel.get(row.grp_key) || [];
      arr.push({
        videoId: row.video_id, title: row.title, thumbnail: row.thumbnail, url: row.url,
        viewCount: row.view_count != null ? parseInt(row.view_count) : null,
        postedAt: row.posted_at?.toISOString() ?? null,
        postedDate: row.posted_date,
        score: row.score,
      });
      popByChannel.set(row.grp_key, arr);
    }
  }

  return NextResponse.json({
    channels: channelsRes.rows.map(r => ({
      channelName: r.channel_name,
      channelAvatar: r.channel_avatar || null,
      channelId: r.channel_id || null,
      channelHandle: r.channel_handle || null,
      firstUploadAt: r.first_upload_at || null,
      dormancyDays: r.dormancy_days !== null ? parseInt(r.dormancy_days) : null,
      videoCount: r.total_video_count !== null
        ? parseInt(r.total_video_count)
        : parseInt(r.video_count_in_cluster),
      videoCountInNiche: parseInt(r.video_count_in_cluster),
      totalVideoCount: r.total_video_count !== null ? parseInt(r.total_video_count) : null,
      totalViews: parseInt(r.total_views) || 0,
      avgViews: parseInt(r.avg_views) || 0,
      maxViews: parseInt(r.max_views) || 0,
      avgScore: parseInt(r.avg_score) || 0,
      maxScore: parseInt(r.max_score) || 0,
      subscribers: parseInt(r.max_subs) || 0,
      totalLikes: parseInt(r.total_likes) || 0,
      totalComments: parseInt(r.total_comments) || 0,
      channelCreatedAt: r.channel_created_at,
      channelAgeDays: r.channel_age_days ? Math.round(parseFloat(r.channel_age_days)) : null,
      latestVideoAt: r.latest_video_at,
      earliestVideoAt: r.earliest_video_at,
      keywords: r.keywords || [],
      popularVideos: popByChannel.get(r.channel_id ? r.channel_id : `name:${r.channel_name}`) || [],
    })),
    total: parseInt(countRes.rows[0].cnt),
    stats: {
      totalChannels: parseInt(statsRes.rows[0].total_channels),
      newChannels: parseInt(statsRes.rows[0].new_channels),
      veryNewChannels: parseInt(statsRes.rows[0].very_new_channels),
      establishedChannels: parseInt(statsRes.rows[0].established_channels),
      newAvgSubs: parseInt(statsRes.rows[0].new_avg_subs) || 0,
      estAvgSubs: parseInt(statsRes.rows[0].est_avg_subs) || 0,
    },
  });
}
