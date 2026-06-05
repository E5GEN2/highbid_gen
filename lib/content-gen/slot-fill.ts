/**
 * Slot-fill — assemble the complete per-channel data inventory.
 *
 * Combines the three sources we've built into one script-ready object
 * per channel, computing the money figures (the highest-uplift data
 * points):
 *   - DB stats          (niche_spy_channels + niche_spy_videos)
 *   - content analysis  (content_gen_channel_analysis)
 *   - RPM               (content_gen_channel_rpm)
 *
 * Money math: $ = RPM × views / 1000.
 *   - top_video_lump_sum = rpm × top_video_views        ("one video made ~$X")
 *   - per_video          = rpm × avg_views_per_video
 *   - monthly            = rpm × (avg_views × uploads/month)
 *   - yearly             = monthly × 12
 *
 * Everything carries its inputs so the figures are auditable, and we
 * follow the data-points.json rules: prefer yearly/daily when the number
 * is impressive, present the $ outcome (never the RPM math), round to 2
 * sig figs.
 */

import { getPool } from '../db';

export interface ChannelSlots {
  channel_id: string;
  channel_name: string | null;
  channel_handle: string | null;
  channel_avatar: string | null;
  channel_url: string;

  // ── niche / content ──
  niche_label: string | null;
  breadth: string | null;
  content_summary: string | null;
  recipe_formula: string | null;
  production_format: string | null;
  voice_type: string | null;
  language: string | null;
  is_faceless: boolean | null;

  // ── scale ──
  subscribers: number | null;
  subscribers_display: string;
  video_count: number | null;
  channel_age_days: number | null;
  channel_age_phrase: string;

  // ── performance ──
  top_video: { views: number; views_display: string; title: string | null; url: string | null; thumbnail: string | null; age_phrase: string } | null;
  top_videos: Array<{ views: number; views_display: string; title: string | null }>;
  avg_views_per_video: number | null;
  median_views: number | null;
  views_to_subs_ratio: number | null;
  uploads_per_month: number | null;

  // ── money (RPM-derived; null when RPM missing) ──
  rpm: { low: number; typical: number; high: number; geo: string | null; grounded_on: string | null } | null;
  money: {
    top_video_lump_sum: number | null;
    per_video: number | null;
    monthly_estimate: number | null;
    yearly_estimate: number | null;
    monthly_views_estimate: number | null;
    // the framing the script should prefer + a ready display string
    headline: { kind: 'yearly' | 'monthly' | 'per_video' | 'lump_sum'; usd: number; display: string } | null;
  } | null;

  // ── growth ("got X views in N months") ──
  growth: { total_indexed_views: number; months_active: number; phrase: string } | null;

  // provenance / readiness
  has_analysis: boolean;
  has_rpm: boolean;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B';
  if (abs >= 1_000_000) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (abs >= 1_000) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1_000) return '$' + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return '$' + Math.round(n).toLocaleString();
}

function agePhrase(days: number | null): string {
  if (days == null) return 'unknown age';
  if (days < 45) return `just ${Math.max(1, Math.round(days))} days old`;
  if (days < 365) return `just ${Math.round(days / 30)} months old`;
  const y = days / 365;
  return y < 2 ? `${y.toFixed(1)} years old` : `${Math.round(y)} years old`;
}

function videoAgePhrase(postedAt: string | Date | null): string {
  if (!postedAt) return '';
  const days = (Date.now() - new Date(postedAt).getTime()) / 86_400_000;
  if (days < 45) return `${Math.max(1, Math.round(days))} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(days < 730 ? 1 : 0)} years ago`;
}

/** Round money to 2 significant figures (per data-points.json presentation rule). */
function round2sig(n: number): number {
  if (n === 0) return 0;
  const mag = Math.floor(Math.log10(Math.abs(n)));
  const factor = Math.pow(10, mag - 1);
  return Math.round(n / factor) * factor;
}

export async function assembleChannelSlots(channelId: string): Promise<ChannelSlots> {
  const pool = await getPool();

  const ch = (await pool.query<{
    channel_name: string | null; channel_handle: string | null; channel_avatar: string | null;
    subscriber_count: number | null; channel_created_at: string | null; first_upload_at: string | null;
    latest_upload_at: string | null; video_count: number | null;
    recent_videos_avg_views: number | null; recent_videos_median_views: number | null;
  }>(
    `SELECT channel_name, channel_handle, channel_avatar, subscriber_count,
            channel_created_at, first_upload_at, latest_upload_at, video_count,
            recent_videos_avg_views, recent_videos_median_views
       FROM niche_spy_channels WHERE channel_id = $1`,
    [channelId],
  )).rows[0] ?? null;

  // Top videos (live) + aggregate view stats from our index.
  const vids = (await pool.query<{ view_count: number; title: string | null; url: string | null; thumbnail: string | null; posted_at: string | null }>(
    `SELECT view_count, title, url, thumbnail, posted_at
       FROM niche_spy_videos
      WHERE channel_id = $1 AND view_count IS NOT NULL AND thumbnail_dead_at IS NULL
      ORDER BY view_count DESC NULLS LAST`,
    [channelId],
  )).rows;

  const agg = (await pool.query<{ total_views: number; avg_views: number; median_views: number; n: number; earliest: string | null }>(
    `SELECT COALESCE(SUM(view_count),0)::bigint AS total_views,
            COALESCE(AVG(view_count),0)::bigint AS avg_views,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY view_count),0)::bigint AS median_views,
            COUNT(*)::int AS n,
            MIN(posted_at) AS earliest
       FROM niche_spy_videos
      WHERE channel_id = $1 AND view_count IS NOT NULL AND thumbnail_dead_at IS NULL`,
    [channelId],
  )).rows[0];

  const an = (await pool.query<{
    niche_label: string | null; breadth: string | null; content_summary: string | null;
    recipe_formula: string | null; production_format: string | null; voice_type: string | null;
    language: string | null; is_faceless: boolean | null;
  }>(
    `SELECT niche_label, breadth, content_summary, recipe_formula, production_format, voice_type, language, is_faceless
       FROM content_gen_channel_analysis WHERE channel_id = $1`,
    [channelId],
  )).rows[0] ?? null;

  const rpmRow = (await pool.query<{ rpm_low: number; rpm_typical: number; rpm_high: number; geo_guess: string | null; grounded_on: string | null }>(
    `SELECT rpm_low, rpm_typical, rpm_high, geo_guess, grounded_on
       FROM content_gen_channel_rpm WHERE channel_id = $1`,
    [channelId],
  )).rows[0] ?? null;

  // ── derive ──
  const subs = ch?.subscriber_count ?? null;
  const createdRef = ch?.first_upload_at ?? ch?.channel_created_at ?? agg?.earliest ?? null;
  const ageDays = createdRef ? Math.round((Date.now() - new Date(createdRef).getTime()) / 86_400_000) : null;
  const monthsActive = ageDays != null ? Math.max(1, ageDays / 30) : null;

  const videoCount = ch?.video_count ?? agg?.n ?? null;
  const avgViews = (ch?.recent_videos_avg_views != null && ch.recent_videos_avg_views > 0)
    ? Number(ch.recent_videos_avg_views)
    : (agg?.avg_views ? Number(agg.avg_views) : null);
  const medianViews = (ch?.recent_videos_median_views != null && ch.recent_videos_median_views > 0)
    ? Number(ch.recent_videos_median_views)
    : (agg?.median_views ? Number(agg.median_views) : null);

  const uploadsPerMonth = (videoCount != null && monthsActive != null && monthsActive > 0)
    ? Math.round((videoCount / monthsActive) * 10) / 10
    : null;

  const topRow = vids[0] ?? null;
  const topViews = topRow ? Number(topRow.view_count) : null;
  const ratio = (topViews != null && subs && subs > 0) ? Math.round((topViews / subs) * 10) / 10 : null;

  // ── money ──
  let money: ChannelSlots['money'] = null;
  if (rpmRow) {
    const rpm = Number(rpmRow.rpm_typical);
    const lump = topViews != null ? round2sig(rpm * topViews / 1000) : null;
    const perVideo = avgViews != null ? round2sig(rpm * avgViews / 1000) : null;
    const monthlyViews = (avgViews != null && uploadsPerMonth != null) ? avgViews * uploadsPerMonth : null;
    const monthly = monthlyViews != null ? round2sig(rpm * monthlyViews / 1000) : null;
    const yearly = monthly != null ? round2sig(monthly * 12) : null;

    // Headline framing: prefer yearly if impressive (≥$50k), else monthly,
    // else per-video, else lump.
    let headline: NonNullable<ChannelSlots['money']>['headline'] = null;
    if (yearly != null && yearly >= 50_000) headline = { kind: 'yearly', usd: yearly, display: `${fmtUsd(yearly)}/year` };
    else if (monthly != null && monthly >= 200) headline = { kind: 'monthly', usd: monthly, display: `${fmtUsd(monthly)}/month` };
    else if (perVideo != null) headline = { kind: 'per_video', usd: perVideo, display: `${fmtUsd(perVideo)}/video` };
    else if (lump != null) headline = { kind: 'lump_sum', usd: lump, display: `${fmtUsd(lump)} from their top video` };

    money = {
      top_video_lump_sum: lump,
      per_video: perVideo,
      monthly_estimate: monthly,
      yearly_estimate: yearly,
      monthly_views_estimate: monthlyViews != null ? Math.round(monthlyViews) : null,
      headline,
    };
  }

  // ── growth ──
  let growth: ChannelSlots['growth'] = null;
  if (agg && monthsActive != null && Number(agg.total_views) > 0) {
    const totalViews = Number(agg.total_views);
    growth = {
      total_indexed_views: totalViews,
      months_active: Math.round(monthsActive),
      phrase: `${fmtNum(totalViews)} views in ${Math.round(monthsActive)} month${Math.round(monthsActive) === 1 ? '' : 's'}`,
    };
  }

  const handle = ch?.channel_handle ?? null;
  const channelUrl = handle
    ? `https://www.youtube.com/${handle.startsWith('@') ? handle : '@' + handle}`
    : `https://www.youtube.com/channel/${channelId}`;

  return {
    channel_id: channelId,
    channel_name: ch?.channel_name ?? null,
    channel_handle: handle,
    channel_avatar: ch?.channel_avatar ?? null,
    channel_url: channelUrl,

    niche_label: an?.niche_label ?? null,
    breadth: an?.breadth ?? null,
    content_summary: an?.content_summary ?? null,
    recipe_formula: an?.recipe_formula ?? null,
    production_format: an?.production_format ?? null,
    voice_type: an?.voice_type ?? null,
    language: an?.language ?? null,
    is_faceless: an?.is_faceless ?? null,

    subscribers: subs,
    subscribers_display: fmtNum(subs),
    video_count: videoCount,
    channel_age_days: ageDays,
    channel_age_phrase: agePhrase(ageDays),

    top_video: topRow ? {
      views: topViews!,
      views_display: fmtNum(topViews),
      title: topRow.title,
      url: topRow.url,
      thumbnail: topRow.thumbnail,
      age_phrase: videoAgePhrase(topRow.posted_at),
    } : null,
    top_videos: vids.slice(0, 5).map(v => ({ views: Number(v.view_count), views_display: fmtNum(Number(v.view_count)), title: v.title })),
    avg_views_per_video: avgViews,
    median_views: medianViews,
    views_to_subs_ratio: ratio,
    uploads_per_month: uploadsPerMonth,

    rpm: rpmRow ? { low: Number(rpmRow.rpm_low), typical: Number(rpmRow.rpm_typical), high: Number(rpmRow.rpm_high), geo: rpmRow.geo_guess, grounded_on: rpmRow.grounded_on } : null,
    money,
    growth,

    has_analysis: !!an,
    has_rpm: !!rpmRow,
  };
}
