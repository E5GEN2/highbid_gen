import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/novelty/videos
 *
 * Lists videos ranked for "blue ocean" potential — high novelty (unique
 * in the embedding space) × high outlier performance (channel is
 * outperforming peers). Used by the admin Novelty tab.
 *
 * Filters:
 *   minViews         — video.view_count lower bound (default 0)
 *   minNoveltyPct    — novelty percentile rank lower bound (0..100, default 50)
 *                      E.g. 90 = top 10% most-novel videos only.
 *   minOutlier       — channel.peer_outlier_score lower bound (default 0)
 *   postedWithinDays — video.posted_at within N days (default 240 / 8mo)
 *   type             — 'long' | 'short' | '' (default long; infers by /shorts/ in url)
 *   limit, offset
 *
 * Ordering: `novelty_score * peer_outlier_score * log(1 + view_count)`
 * in descending order. The log on views prevents a single 50M-view video
 * from dominating the ranking just because it has huge views.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const sp = req.nextUrl.searchParams;

  const numOrNull = (s: string | null): number | null => {
    if (s == null || s.trim() === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  // All bounds default to NULL (= no filter). The UI passes '0' or '' for
  // "no lower bound" and a real number for an active filter. This gives the
  // admin true max-control: every knob can be turned off independently.
  const minViews      = numOrNull(sp.get('minViews'));
  const maxViews      = numOrNull(sp.get('maxViews'));
  const minNoveltyPct = numOrNull(sp.get('minNoveltyPct'));
  const minOutlier    = numOrNull(sp.get('minOutlier'));
  const maxOutlier    = numOrNull(sp.get('maxOutlier'));
  const minSubs       = numOrNull(sp.get('minSubs'));
  const maxSubs       = numOrNull(sp.get('maxSubs'));
  // Recency bound. '' explicitly means "no recency filter" (all-time).
  // Default: null (no filter) — admin view, show everything unless asked.
  const postedWithinRaw = sp.get('postedWithin');
  const postedWithinDays = postedWithinRaw === '' || postedWithinRaw === null
    ? null
    : numOrNull(postedWithinRaw);
  // Channel age bounds (days). null = no bound. Uses the same
  // effective-age chain the chip displays: COALESCE(first_upload_at,
  // channel_created_at). first_upload_at is preferred so an "aged /
  // reactivated" channel (old creation date, recent first upload) is
  // treated as new — the creator-friendly interpretation.
  const minChannelAgeDays = numOrNull(sp.get('minChannelAge'));
  const maxChannelAgeDays = numOrNull(sp.get('maxChannelAge'));
  // type: 'long' | 'short' | 'any' (default 'any' so the unfiltered admin
  // view includes everything). Empty string = same as 'any'.
  const typeRaw = (sp.get('type') || 'any').toLowerCase();
  const type = typeRaw === 'long' || typeRaw === 'short' ? typeRaw : 'any';
  // requireOutlier: when 'true', exclude videos whose channel lacks a
  // peer_outlier_score. When 'false' (default), include them and they
  // contribute 1.0 to the composite ranking. Being able to toggle this off
  // is critical for auditing whether the outlier signal is helping or
  // hurting the novelty list.
  const requireOutlier = sp.get('requireOutlier') === 'true';
  // sort: 'blue_ocean' | 'novelty' | 'views' | 'outlier' | 'recency'
  // Default 'blue_ocean' preserves the previous behaviour. Explicit sort
  // lets the admin see pure novelty ranking (ignoring views and outlier)
  // to judge the raw metric quality.
  const sortMode = (sp.get('sort') || 'blue_ocean').toLowerCase();
  const q = (sp.get('q') || '').trim();
  const limit = Math.min(parseInt(sp.get('limit') || '60'), 200);
  const offset = parseInt(sp.get('offset') || '0');

  const conditions: string[] = [`v.novelty_score IS NOT NULL`];
  const params: (string | number)[] = [];
  let idx = 1;

  // Convert novelty percentile to an absolute score cutoff via the
  // distribution. "Top X%" is more intuitive than "distance > 0.87" which
  // changes whenever the corpus shifts. Skipped when minNoveltyPct is null
  // (admin opted into "show everything novel-enough to be scored at all").
  if (minNoveltyPct != null && minNoveltyPct > 0) {
    const percentile = Math.min(99.9, Math.max(0, minNoveltyPct)) / 100;
    const cutoffRes = await pool.query<{ cutoff: number | null }>(
      `SELECT PERCENTILE_CONT($1) WITHIN GROUP (ORDER BY novelty_score) AS cutoff
       FROM niche_spy_videos WHERE novelty_score IS NOT NULL`,
      [percentile],
    );
    const cutoff = cutoffRes.rows[0]?.cutoff;
    if (cutoff != null) {
      conditions.push(`v.novelty_score >= $${idx}`);
      params.push(cutoff);
      idx++;
    }
  }

  if (minViews != null && minViews > 0) {
    conditions.push(`v.view_count >= $${idx}`); params.push(minViews); idx++;
  }
  if (maxViews != null && maxViews > 0) {
    conditions.push(`v.view_count <= $${idx}`); params.push(maxViews); idx++;
  }
  // Outlier bounds. `requireOutlier` decides whether videos with a NULL
  // peer_outlier_score are included at all. With the toggle OFF (default),
  // the comparisons only fire when the score is non-null so NULL rows pass.
  if (requireOutlier) {
    conditions.push(`c.peer_outlier_score IS NOT NULL`);
  }
  if (minOutlier != null && minOutlier > 0) {
    conditions.push(`c.peer_outlier_score >= $${idx}`); params.push(minOutlier); idx++;
  }
  if (maxOutlier != null && maxOutlier > 0) {
    conditions.push(`c.peer_outlier_score <= $${idx}`); params.push(maxOutlier); idx++;
  }
  if (minSubs != null && minSubs > 0) {
    conditions.push(`c.subscriber_count >= $${idx}`); params.push(minSubs); idx++;
  }
  if (maxSubs != null && maxSubs > 0) {
    conditions.push(`c.subscriber_count <= $${idx}`); params.push(maxSubs); idx++;
  }
  if (postedWithinDays != null && postedWithinDays > 0) {
    conditions.push(`v.posted_at >= NOW() - ($${idx} || ' days')::interval`);
    params.push(postedWithinDays); idx++;
  }
  // Channel age filter — applies to the channel's effective active age
  // (first_upload_at preferred over channel_created_at, same chain the chip
  // displays). A channel is INCLUDED when its effective age falls inside
  // [minChannelAgeDays, maxChannelAgeDays].
  //   minChannelAge=30   → channel is at least 30 days old
  //   maxChannelAge=365  → channel is at most 1 year old
  if (minChannelAgeDays != null && minChannelAgeDays > 0) {
    conditions.push(
      `COALESCE(c.first_upload_at, c.channel_created_at) <= NOW() - ($${idx} || ' days')::interval`
    );
    params.push(minChannelAgeDays); idx++;
  }
  if (maxChannelAgeDays != null && maxChannelAgeDays > 0) {
    conditions.push(
      `COALESCE(c.first_upload_at, c.channel_created_at) >= NOW() - ($${idx} || ' days')::interval`
    );
    params.push(maxChannelAgeDays); idx++;
  }
  if (type === 'short') {
    conditions.push(`v.url ILIKE '%/shorts/%'`);
  } else if (type === 'long') {
    conditions.push(`v.url NOT ILIKE '%/shorts/%'`);
  }
  // type === 'any' → no filter (default)
  if (q) {
    conditions.push(`(v.title ILIKE $${idx} OR v.channel_name ILIKE $${idx})`);
    params.push(`%${q}%`); idx++;
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  const limitIdx = idx;
  const offsetIdx = idx + 1;
  params.push(limit, offset);

  // Sort mode: standalone knobs so the admin can isolate each signal.
  //   blue_ocean — default, novelty × outlier × log1p(views)
  //   novelty    — pure novelty_score (audit the raw metric)
  //   views      — view_count
  //   outlier    — peer_outlier_score (NULLS LAST)
  //   recency    — posted_at
  //   subs_asc   — subscriber_count ASC (smallest channels first)
  //   channel_age_asc — youngest channels first
  let orderBy: string;
  switch (sortMode) {
    case 'novelty':
      orderBy = 'v.novelty_score DESC NULLS LAST';
      break;
    case 'views':
      orderBy = 'v.view_count DESC NULLS LAST';
      break;
    case 'outlier':
      orderBy = 'c.peer_outlier_score DESC NULLS LAST';
      break;
    case 'recency':
      orderBy = 'v.posted_at DESC NULLS LAST';
      break;
    case 'subs_asc':
      orderBy = 'c.subscriber_count ASC NULLS LAST';
      break;
    case 'channel_age_asc':
      orderBy = 'COALESCE(c.first_upload_at, c.channel_created_at) DESC NULLS LAST';
      break;
    case 'blue_ocean':
    default:
      orderBy =
        `(v.novelty_score * COALESCE(c.peer_outlier_score, 1.0) * LN(1 + GREATEST(v.view_count, 1))) DESC NULLS LAST`;
  }

  const videosRes = await pool.query(
    `SELECT
       v.id, v.url, v.title, v.view_count, v.channel_name, v.posted_at,
       v.like_count, v.comment_count, v.thumbnail, v.keyword,
       v.channel_id, v.channel_avatar, v.novelty_score,
       c.channel_handle, c.subscriber_count, c.peer_outlier_score,
       c.peer_outlier_bucket, c.channel_created_at, c.first_upload_at,
       c.dormancy_days, c.video_count AS channel_video_count,
       v.novelty_score *
         COALESCE(c.peer_outlier_score, 1.0) *
         LN(1 + GREATEST(v.view_count, 1)) AS blue_ocean_rank
     FROM niche_spy_videos v
     LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
     ${where}
     ORDER BY ${orderBy}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );

  const countRes = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM niche_spy_videos v
     LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
     ${where}`,
    params.slice(0, -2),
  );

  // Compute each row's novelty percentile for display. Do it via a window
  // function on the response rows only — not the full table — since we
  // only need the percentiles of what the user is seeing.
  const ids = videosRes.rows.map(r => r.id);
  let percentileById = new Map<number, number>();
  if (ids.length > 0) {
    const pctRes = await pool.query<{ id: number; pct: number }>(
      `WITH all_scored AS (
         SELECT id, novelty_score,
                PERCENT_RANK() OVER (ORDER BY novelty_score) AS pct
         FROM niche_spy_videos
         WHERE novelty_score IS NOT NULL
       )
       SELECT id, pct FROM all_scored WHERE id = ANY($1::int[])`,
      [ids],
    );
    percentileById = new Map(pctRes.rows.map(r => [r.id, parseFloat(String(r.pct))]));
  }

  return NextResponse.json({
    videos: videosRes.rows.map(r => ({
      id:                 r.id,
      url:                r.url,
      title:              r.title,
      viewCount:          parseInt(r.view_count) || 0,
      channelName:        r.channel_name,
      channelId:          r.channel_id,
      channelHandle:      r.channel_handle,
      channelAvatar:      r.channel_avatar,
      subscriberCount:    r.subscriber_count ? parseInt(r.subscriber_count) : null,
      postedAt:           r.posted_at,
      likeCount:          parseInt(r.like_count) || 0,
      commentCount:       parseInt(r.comment_count) || 0,
      thumbnail:          r.thumbnail,
      keyword:            r.keyword,
      noveltyScore:       r.novelty_score !== null ? parseFloat(r.novelty_score) : null,
      // 0..1 percentile rank among scored videos. 0.98 = in top 2% most-novel.
      noveltyPercentile:  percentileById.get(r.id) ?? null,
      peerOutlierScore:   r.peer_outlier_score !== null ? parseFloat(r.peer_outlier_score) : null,
      peerOutlierBucket:  r.peer_outlier_bucket,
      firstUploadAt:      r.first_upload_at,
      channelCreatedAt:   r.channel_created_at,
      dormancyDays:       r.dormancy_days !== null ? parseInt(r.dormancy_days) : null,
      channelVideoCount:  r.channel_video_count !== null ? parseInt(r.channel_video_count) : null,
      isShort:            typeof r.url === 'string' && r.url.includes('/shorts/'),
    })),
    total: parseInt(countRes.rows[0].cnt),
  });
}
