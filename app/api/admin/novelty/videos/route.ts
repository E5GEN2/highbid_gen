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

  const minViews      = numOrNull(sp.get('minViews'))      ?? 0;
  const minNoveltyPct = numOrNull(sp.get('minNoveltyPct')) ?? 50;
  const minOutlier    = numOrNull(sp.get('minOutlier'))    ?? 0;
  // Default 8mo recency — matches /niche/outliers. '' explicitly means
  // "no recency filter" (all-time).
  const postedWithinRaw = sp.get('postedWithin');
  const postedWithinDays = postedWithinRaw === ''
    ? null
    : (numOrNull(postedWithinRaw) ?? 240);
  // Channel age bounds (days). null = no bound. Matches the
  // /api/niche-spy/channels semantics and uses the same effective-age
  // derivation the chip displays: COALESCE(first_upload_at, channel_created_at).
  // Using first_upload_at as the preferred source means an "aged/reactivated"
  // channel (created years ago, first upload recent) is treated as "new" —
  // which is the correct creator-friendly interpretation.
  const minChannelAgeDays = numOrNull(sp.get('minChannelAge'));
  const maxChannelAgeDays = numOrNull(sp.get('maxChannelAge'));
  const type = sp.get('type') || 'long';
  const q = (sp.get('q') || '').trim();
  const limit = Math.min(parseInt(sp.get('limit') || '60'), 200);
  const offset = parseInt(sp.get('offset') || '0');

  const conditions: string[] = [`v.novelty_score IS NOT NULL`];
  const params: (string | number)[] = [];
  let idx = 1;

  // Convert novelty percentile to an absolute score cutoff via the
  // distribution. "Top X%" is more intuitive than "distance > 0.87" which
  // changes whenever the corpus shifts. One extra query but avoids coupling
  // the UI to raw distances.
  if (minNoveltyPct > 0) {
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

  if (minViews > 0) {
    conditions.push(`v.view_count >= $${idx}`); params.push(minViews); idx++;
  }
  if (minOutlier > 0) {
    conditions.push(`c.peer_outlier_score >= $${idx}`); params.push(minOutlier); idx++;
  }
  if (postedWithinDays != null) {
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
  if (q) {
    conditions.push(`(v.title ILIKE $${idx} OR v.channel_name ILIKE $${idx})`);
    params.push(`%${q}%`); idx++;
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  const limitIdx = idx;
  const offsetIdx = idx + 1;
  params.push(limit, offset);

  // Ranking: novelty × outlier × log1p(views). Videos without a channel
  // peer_outlier_score still appear but rank lower (the score contributes
  // 1.0 via COALESCE so they aren't excluded).
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
     ORDER BY blue_ocean_rank DESC NULLS LAST
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
