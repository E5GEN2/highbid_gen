import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/niche-spy/outliers
 *
 * Returns a video grid where each row is a video whose channel has a
 * computed peer_outlier_score (see /api/admin/outliers/recompute).
 *
 * Filters (all optional):
 *   preset         = 'viral_small' | 'viral_medium' | 'above_1m' | 'high_outlier' | 'high_views_few_vids'
 *   minOutlier     = number  (peer_outlier_score lower bound)
 *   minViews       = number  (video.view_count lower bound)
 *   maxSubs        = number  (channel.subscriber_count upper bound)
 *   minSubs        = number  (channel.subscriber_count lower bound)
 *   postedWithin   = days    (video posted within N days)
 *   type           = 'long' | 'short'  (<= 60s = short)
 *   q              = free-text search against title/channel
 *   limit, offset
 *
 * Ranked by (peer_outlier_score * views) so truly-viral videos on truly-
 * outlying channels rise to the top, rather than letting one dimension
 * dominate. If preset=sort=views, just uses raw views instead.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const sp = req.nextUrl.searchParams;

  const preset = sp.get('preset') || '';
  const type = sp.get('type') || '';
  const q = (sp.get('q') || '').trim();
  const limit = Math.min(parseInt(sp.get('limit') || '60'), 200);
  const offset = parseInt(sp.get('offset') || '0');

  // Parse numeric bounds leniently.
  const numOrNull = (s: string | null): number | null => {
    if (s == null || s.trim() === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  let minOutlier = numOrNull(sp.get('minOutlier'));
  let minViews   = numOrNull(sp.get('minViews'));
  let minSubs    = numOrNull(sp.get('minSubs'));
  let maxSubs    = numOrNull(sp.get('maxSubs'));
  let postedWithinDays = numOrNull(sp.get('postedWithin'));

  // Presets bake in the canonical Nexlev combinations. They OVERRIDE any
  // passed custom bounds so a preset click gives a predictable result.
  switch (preset) {
    case 'viral_small':
      // "Viral videos on small channels" - under 10k subs, recent, big views
      maxSubs = 10000;
      minViews = 100000;
      postedWithinDays = 30;
      break;
    case 'viral_medium':
      maxSubs = 100000;
      minSubs = 10000;
      minViews = 500000;
      postedWithinDays = 30;
      break;
    case 'above_1m':
      minViews = 1000000;
      break;
    case 'high_outlier':
      minOutlier = 5;
      break;
    case 'high_views_few_vids':
      // Channel has few total videos but those videos get big views - the
      // "new creator found the formula fast" signal
      minViews = 50000;
      // Implemented as channel.video_count <= 30 via WHERE clause below.
      break;
  }

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;

  // Require an outlier score. The outliers page is by definition channels
  // with a computed score; channels not enriched / not bucketed get hidden.
  conditions.push(`c.peer_outlier_score IS NOT NULL`);

  if (minOutlier != null) {
    conditions.push(`c.peer_outlier_score >= $${idx}`); params.push(minOutlier); idx++;
  }
  if (minViews != null) {
    conditions.push(`v.view_count >= $${idx}`); params.push(minViews); idx++;
  }
  if (minSubs != null) {
    conditions.push(`c.subscriber_count >= $${idx}`); params.push(minSubs); idx++;
  }
  if (maxSubs != null) {
    conditions.push(`c.subscriber_count <= $${idx}`); params.push(maxSubs); idx++;
  }
  if (postedWithinDays != null) {
    conditions.push(`v.posted_at >= NOW() - ($${idx} || ' days')::interval`);
    params.push(postedWithinDays); idx++;
  }
  if (preset === 'high_views_few_vids') {
    conditions.push(`c.video_count IS NOT NULL AND c.video_count <= 30`);
  }
  if (q) {
    conditions.push(`(v.title ILIKE $${idx} OR v.channel_name ILIKE $${idx})`);
    params.push(`%${q}%`); idx++;
  }
  // type=short -> videos ≤ 60s. We don't have a duration column on
  // niche_spy_videos yet, so approximate via URL shape (shorts URLs contain
  // '/shorts/'). If the shorts column is ever added, swap this for a proper
  // duration <= 60 filter.
  if (type === 'short') {
    conditions.push(`v.url ILIKE '%/shorts/%'`);
  } else if (type === 'long') {
    conditions.push(`v.url NOT ILIKE '%/shorts/%'`);
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  const limitIdx = idx;
  const offsetIdx = idx + 1;
  params.push(limit, offset);

  // One card per channel: pick the channel's single best-performing video
  // (highest view_count among the rows that pass the filters). Nexlev does
  // the same — the same channel repeating 6 times down the grid is noise.
  //
  // DISTINCT ON (c.channel_id) returns the first row per channel after the
  // ORDER BY, so we sort within each channel by view_count DESC first, then
  // wrap that in an outer query to re-sort across channels by peer score.
  const [videosRes, countRes] = await Promise.all([
    pool.query(
      `WITH ranked AS (
         SELECT DISTINCT ON (c.channel_id)
           v.id, v.url, v.title, v.view_count, v.channel_name, v.posted_at,
           v.like_count, v.comment_count, v.thumbnail, v.keyword,
           v.channel_id, v.channel_avatar,
           c.channel_handle, c.subscriber_count, c.peer_outlier_score,
           c.peer_outlier_bucket, c.channel_created_at, c.first_upload_at,
           c.dormancy_days, c.video_count AS channel_video_count
         FROM niche_spy_videos v
         JOIN niche_spy_channels c ON c.channel_id = v.channel_id
         ${where}
         ORDER BY c.channel_id, v.view_count DESC NULLS LAST
       )
       SELECT * FROM ranked
       ORDER BY peer_outlier_score DESC NULLS LAST, view_count DESC NULLS LAST
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ),
    pool.query(
      `SELECT COUNT(DISTINCT c.channel_id) AS cnt
       FROM niche_spy_videos v
       JOIN niche_spy_channels c ON c.channel_id = v.channel_id
       ${where}`,
      params.slice(0, -2)
    ),
  ]);

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
      peerOutlierScore:   r.peer_outlier_score !== null ? parseFloat(r.peer_outlier_score) : null,
      peerOutlierBucket:  r.peer_outlier_bucket,
      channelCreatedAt:   r.channel_created_at,
      firstUploadAt:      r.first_upload_at,
      dormancyDays:       r.dormancy_days !== null ? parseInt(r.dormancy_days) : null,
      channelVideoCount:  r.channel_video_count !== null ? parseInt(r.channel_video_count) : null,
      isShort:            typeof r.url === 'string' && r.url.includes('/shorts/'),
    })),
    total: parseInt(countRes.rows[0].cnt),
  });
}
