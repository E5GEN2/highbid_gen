import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

// Force dynamic rendering — filters like maxAge change per-request and must
// never hit Next.js's fetch/route cache. Without this, edge caches or the
// data cache can return stale responses when the user switches between age
// filter chips (30d / 3mo / 6mo / 1yr).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/niche-spy/channels
 * Aggregated channel data for a niche.
 * Params: keyword, sort (views|videos|subs|newest), limit, offset, maxAge (days)
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const sp = req.nextUrl.searchParams;

  const keyword = sp.get('keyword');
  const sort = sp.get('sort') || 'views';
  const limit = Math.min(parseInt(sp.get('limit') || '60'), 200);
  const offset = parseInt(sp.get('offset') || '0');
  const maxAge = sp.get('maxAge'); // filter channels created within N days (legacy quick chip)
  const minAge = sp.get('minAge'); // channels AT LEAST N days old (custom range)
  const maxAgeCustom = sp.get('maxAgeCustom'); // channels AT MOST N days old (custom range — overrides quick chip)
  const minScore = parseInt(sp.get('minScore') || '0');
  // Subscriber + total-views range filters. Empty string / missing = no bound.
  // Parsed as floats so the client can pass "50000" or just defaults.
  const parseBound = (s: string | null): number | null => {
    if (s == null || s.trim() === '') return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const minSubs = parseBound(sp.get('minSubs'));
  const maxSubs = parseBound(sp.get('maxSubs'));
  const minViews = parseBound(sp.get('minViews'));
  const maxViews = parseBound(sp.get('maxViews'));

  const conditions: string[] = ['channel_name IS NOT NULL', "channel_name != ''"];
  const params: (string | number)[] = [];
  let idx = 1;

  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $${idx}`);
    params.push(keyword);
    idx++;
  }
  if (minScore > 0) {
    conditions.push(`score >= $${idx}`);
    params.push(minScore);
    idx++;
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  // Channel age filter — must match the displayed age.
  // ChannelAgeChip shows first_upload_at when available (Phase-3 walk) and
  // falls back to channel_created_at, so the filter has to reach into both:
  //   1. niche_spy_channels.first_upload_at   (preferred — real active age)
  //   2. niche_spy_channels.channel_created_at (YT channels.list publishedAt)
  //   3. niche_spy_videos.channel_created_at   (legacy mirror, for rows not yet joined)
  // Without this, selecting "3mo" would filter by v.channel_created_at only
  // and leave in channels whose displayed age is years (because the display
  // reads from c.first_upload_at instead). The filter was checking a
  // different column than the card was rendering.
  const effectiveAgeDateSql =
    `COALESCE(MIN(c.first_upload_at), MIN(c.channel_created_at), MAX(v.channel_created_at))`;
  // Match the same aggregations the SELECT uses so card stats and the
  // filter agree. max_subs = MAX(v.subscriber_count), total_views = SUM.
  const subsAggSql = `MAX(v.subscriber_count)`;
  const totalViewsAggSql = `SUM(v.view_count)`;

  // Build HAVING clauses cumulatively. The existing quick `maxAge` chip is
  // preserved for back-compat, but the new custom `maxAgeCustom` + `minAge`
  // take precedence when present (they come from the new filters dropdown
  // where the user explicitly typed a number).
  const havingParts: string[] = [];
  const effectiveMaxAge = maxAgeCustom || maxAge;
  if (effectiveMaxAge) {
    const days = parseInt(effectiveMaxAge);
    if (Number.isFinite(days) && days > 0) {
      havingParts.push(`${effectiveAgeDateSql} > NOW() - INTERVAL '${days} days'`);
    }
  }
  if (minAge) {
    const days = parseInt(minAge);
    if (Number.isFinite(days) && days > 0) {
      // "at least N days old" → the effective age date must be ≤ N days ago.
      havingParts.push(`${effectiveAgeDateSql} <= NOW() - INTERVAL '${days} days'`);
    }
  }
  if (minSubs != null)  havingParts.push(`${subsAggSql} >= ${Math.floor(minSubs)}`);
  if (maxSubs != null)  havingParts.push(`${subsAggSql} <= ${Math.floor(maxSubs)}`);
  if (minViews != null) havingParts.push(`${totalViewsAggSql} >= ${Math.floor(minViews)}`);
  if (maxViews != null) havingParts.push(`${totalViewsAggSql} <= ${Math.floor(maxViews)}`);
  const havingClause = havingParts.length > 0 ? `HAVING ${havingParts.join(' AND ')}` : '';

  let orderBy: string;
  switch (sort) {
    case 'videos': orderBy = 'video_count DESC'; break;
    case 'subs': orderBy = 'max_subs DESC NULLS LAST'; break;
    case 'newest': orderBy = 'channel_age_days ASC NULLS LAST'; break;
    case 'score': orderBy = 'avg_score DESC'; break;
    // Outlier ratio = best video's view count / channel's average view count.
    // A channel whose best video is 60× its own average is a clear outlier
    // target. We use a CASE to avoid divide-by-zero and rank nulls last.
    case 'outlier': orderBy = `CASE WHEN AVG(v.view_count) > 0 THEN MAX(v.view_count)::float / AVG(v.view_count) ELSE 0 END DESC NULLS LAST`; break;
    default: orderBy = 'total_views DESC NULLS LAST';
  }

  const limitIdx = idx;
  const offsetIdx = idx + 1;
  params.push(limit, offset);

  // Group by channel_id when we have it, else fall back to channel_name.
  // Grouping only on channel_name is wrong: two real YouTube channels can share
  // a display name (especially generic ones like "Baddie In Business"), or
  // xgodo can misattribute a video to a name — either case produced cards
  // where MIN(first_upload_at)=5.3yr but MAX(channel_created_at)=1mo (the two
  // aggregates were pulling from different underlying channels).
  // Using COALESCE keeps legacy rows (ingested before we started capturing
  // channel_id) bucketed by name as a fallback.
  const groupKey = `COALESCE(v.channel_id, 'name:' || v.channel_name)`;

  const [channelsRes, countRes, statsRes] = await Promise.all([
    pool.query(`
      SELECT
        MAX(v.channel_name) as channel_name,
        MAX(v.channel_avatar) as channel_avatar,
        MAX(v.channel_id) as channel_id,
        -- Handle + first-upload come from the channels cache, joined by channel_id
        MIN(c.channel_handle) as channel_handle,
        MIN(c.first_upload_at) as first_upload_at,
        MIN(c.dormancy_days) as dormancy_days,
        -- video_count_in_niche = rows we've scraped for this channel in this niche
        -- total_video_count   = YouTube's reported total videoCount (from enrichment)
        COUNT(*) as video_count_in_niche,
        MIN(c.video_count) as total_video_count,
        SUM(v.view_count) as total_views,
        ROUND(AVG(v.view_count)) as avg_views,
        MAX(v.view_count) as max_views,
        -- Channel-internal outlier multiplier: best video vs. channel average.
        -- CASE guards against divide-by-zero when the channel has only zero-view
        -- rows. NULL when avg is 0, handled as null on the client.
        CASE WHEN AVG(v.view_count) > 0
             THEN ROUND((MAX(v.view_count)::float / AVG(v.view_count))::numeric, 1)
             ELSE NULL END as outlier_multiplier,
        ROUND(AVG(v.score)) as avg_score,
        MAX(v.score) as max_score,
        MAX(v.subscriber_count) as max_subs,
        SUM(v.like_count) as total_likes,
        SUM(v.comment_count) as total_comments,
        -- Prefer the authoritative value from niche_spy_channels (single row
        -- per channel_id, written by the channels.list enrich pass). Fall back
        -- to the videos-table mirror only when we don't have a channels row.
        COALESCE(MIN(c.channel_created_at), MAX(v.channel_created_at)) as channel_created_at,
        -- channel_age_days is what the "Newest" sort orders by, so it has to
        -- be derived from the SAME column ChannelAgeChip displays — otherwise
        -- channels with a recent channel_created_at but old first_upload_at
        -- (reactivated / handle-migrated) float to the top even though the
        -- card shows them as years old. Use the effective-age chain:
        -- first_upload_at → channel_created_at → video mirror.
        EXTRACT(DAY FROM NOW() - COALESCE(MIN(c.first_upload_at), MIN(c.channel_created_at), MAX(v.channel_created_at))) as channel_age_days,
        MAX(v.posted_at) as latest_video_at,
        MIN(v.posted_at) as earliest_video_at,
        ARRAY_AGG(DISTINCT v.keyword) FILTER (WHERE v.keyword IS NOT NULL) as keywords
      FROM niche_spy_videos v
      LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
      ${where.replace(/\bkeyword\b/g, 'v.keyword').replace(/\bscore\b/g, 'v.score').replace(/\bchannel_name\b/g, 'v.channel_name')}
      GROUP BY ${groupKey}
      ${havingClause}
      ORDER BY ${orderBy}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, params),

    // Count query needs the same JOIN so HAVING can reference c.first_upload_at
    // and c.channel_created_at, and must GROUP BY the same key so the HAVING
    // aggregate matches the main query's filtering.
    pool.query(`
      SELECT COUNT(*) as cnt FROM (
        SELECT ${groupKey} AS k
        FROM niche_spy_videos v
        LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
        ${where.replace(/\bkeyword\b/g, 'v.keyword').replace(/\bscore\b/g, 'v.score').replace(/\bchannel_name\b/g, 'v.channel_name')}
        GROUP BY ${groupKey}
        ${havingClause}
      ) sub
    `, params.slice(0, -2)),

    // Stats box — aggregate per distinct channel (same grouping + same
    // effective-age derivation as the main query, so the "<30 days" /
    // "<6 months" / "Established" counts stay consistent with whichever
    // cards pass the age filter. Using an inner aggregation so each channel
    // contributes one row with its effective age.
    pool.query(`
      WITH channel_agg AS (
        SELECT
          ${groupKey} AS grp_key,
          COALESCE(MIN(c.first_upload_at), MIN(c.channel_created_at), MAX(v.channel_created_at)) AS effective_age_at,
          MAX(v.subscriber_count) AS subs
        FROM niche_spy_videos v
        LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
        ${where.replace(/\bkeyword\b/g, 'v.keyword').replace(/\bscore\b/g, 'v.score').replace(/\bchannel_name\b/g, 'v.channel_name')}
        GROUP BY ${groupKey}
      )
      SELECT
        COUNT(*) as total_channels,
        COUNT(*) FILTER (WHERE effective_age_at > NOW() - INTERVAL '180 days') as new_channels,
        COUNT(*) FILTER (WHERE effective_age_at > NOW() - INTERVAL '30 days') as very_new_channels,
        COUNT(*) FILTER (WHERE effective_age_at <= NOW() - INTERVAL '180 days' OR effective_age_at IS NULL) as established_channels,
        ROUND(AVG(subs) FILTER (WHERE effective_age_at > NOW() - INTERVAL '180 days'), 0) as new_avg_subs,
        ROUND(AVG(subs) FILTER (WHERE effective_age_at <= NOW() - INTERVAL '180 days'), 0) as est_avg_subs
      FROM channel_agg
    `, params.slice(0, -2)),
  ]);

  return NextResponse.json({
    channels: channelsRes.rows.map(r => ({
      channelName: r.channel_name,
      channelAvatar: r.channel_avatar || null,
      channelId: r.channel_id || null,
      channelHandle: r.channel_handle || null,
      firstUploadAt: r.first_upload_at || null,
      dormancyDays: r.dormancy_days !== null ? parseInt(r.dormancy_days) : null,
      // videoCount is the authoritative YouTube total (from Data API enrichment).
      // Falls back to in-niche count when we haven't enriched the channel yet.
      videoCount: r.total_video_count !== null
        ? parseInt(r.total_video_count)
        : parseInt(r.video_count_in_niche),
      videoCountInNiche: parseInt(r.video_count_in_niche),
      totalVideoCount: r.total_video_count !== null ? parseInt(r.total_video_count) : null,
      totalViews: parseInt(r.total_views) || 0,
      avgViews: parseInt(r.avg_views) || 0,
      maxViews: parseInt(r.max_views) || 0,
      outlierMultiplier: r.outlier_multiplier !== null ? parseFloat(r.outlier_multiplier) : null,
      avgScore: parseInt(r.avg_score) || 0,
      maxScore: parseInt(r.max_score) || 0,
      subscribers: parseInt(r.max_subs) || 0,
      totalLikes: parseInt(r.total_likes) || 0,
      totalComments: parseInt(r.total_comments) || 0,
      channelCreatedAt: r.channel_created_at,
      channelAgeDays: r.channel_age_days ? Math.round(parseFloat(r.channel_age_days)) : null,
      latestVideoAt: r.latest_video_at,
      earliestVideoAt: r.earliest_video_at,    // used as lower-bound fallback for active age
      keywords: r.keywords || [],
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
