/**
 * Fetch a channel's MOST RECENT N uploads with view counts, to compute an
 * unbiased avg_views baseline for peer-outlier scoring.
 *
 * The uploads playlist returns items newest-first, so page 1 gives us the
 * last 50 uploads for ~free. We then call videos.list once on those ids to
 * pull view counts (up to 50 per call, 1 quota unit).
 *
 * Total quota cost per channel: 1 (playlistItems) + 1 (videos.list) = 2 units.
 * A 10k-channel enrich run = 20k units — easily absorbed by a few API keys.
 */

import { ytFetchViaProxy } from './yt-proxy-fetch';
import type { YtKeyProxyPair } from './yt-keys';

export interface RecentUploadsResult {
  avgViews: number | null;       // rounded integer
  medianViews: number | null;    // rounded integer
  maxViews: number | null;
  count: number;                 // how many videos we actually pulled stats for
  /** Raw per-video records from the videos.list response. The
   *  outlier-enrich worker upserts these into niche_spy_videos so
   *  the channel cards have actual videos to render. Empty when the
   *  underlying videos.list call failed or returned nothing. */
  videos: RecentUploadVideo[];
  error?: string;
}

export interface RecentUploadVideo {
  videoId: string;
  title: string | null;
  description: string | null;
  thumbnail: string | null;
  publishedAt: string | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  /** Video length in seconds (from contentDetails). null if unparseable.
   *  ≤ 61s ⇒ a Short. Used by the shorts-profile gate (content-gen #14). */
  durationSeconds: number | null;
}

/** Parse an ISO-8601 video duration ("PT1M30S") → seconds. */
function parseIso8601Duration(d: string | null | undefined): number | null {
  const m = (d ?? '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return (parseInt(m[1] || '0') * 3600) + (parseInt(m[2] || '0') * 60) + parseInt(m[3] || '0');
}

interface PlaylistItem {
  snippet?: {
    resourceId?: { videoId?: string };
    title?: string;
    description?: string;
    publishedAt?: string;
    thumbnails?: {
      maxres?: { url?: string };
      high?: { url?: string };
      medium?: { url?: string };
      default?: { url?: string };
    };
  };
}
interface PlaylistPage {
  items?: PlaylistItem[];
  nextPageToken?: string;
}
interface VideoItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    thumbnails?: {
      maxres?: { url?: string };
      high?: { url?: string };
      medium?: { url?: string };
      default?: { url?: string };
    };
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
}
interface VideosPage {
  items?: VideoItem[];
}

/**
 * Pulls up to `maxVideos` most recent upload stats for a channel.
 * Typical call: maxVideos = 50 (first playlist page + one videos.list batch).
 */
export async function fetchChannelRecentUploads(
  uploadsPlaylistId: string,
  pair: YtKeyProxyPair,
  options?: { maxVideos?: number },
): Promise<RecentUploadsResult> {
  const maxVideos = Math.min(options?.maxVideos ?? 50, 50);

  if (!uploadsPlaylistId) {
    return { avgViews: null, medianViews: null, maxViews: null, count: 0, videos: [], error: 'no uploads playlist' };
  }

  // Step 1: pull the first playlistItems page (newest uploads).
  const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=${maxVideos}&key=${pair.key}`;
  const plRes = await ytFetchViaProxy(plUrl, pair);
  if (!plRes.ok) {
    return {
      avgViews: null, medianViews: null, maxViews: null, count: 0, videos: [],
      error: `playlistItems ${plRes.status}: ${(plRes.error || '').slice(0, 120)}`,
    };
  }
  const plData = plRes.data as PlaylistPage;
  const videoIds = (plData.items || [])
    .map(it => it.snippet?.resourceId?.videoId)
    .filter((v): v is string => !!v);

  if (videoIds.length === 0) {
    return { avgViews: null, medianViews: null, maxViews: null, count: 0, videos: [] };
  }

  // Step 2: videos.list with snippet + statistics. The snippet is a
  // separate part with its own quota cost, but we need title +
  // thumbnail to persist the videos to niche_spy_videos for the
  // channel-card thumb strip. Same one batch (capped at 50 above).
  const idsParam = videoIds.join(',');
  const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${idsParam}&key=${pair.key}`;
  const vRes = await ytFetchViaProxy(vUrl, pair);
  if (!vRes.ok) {
    return {
      avgViews: null, medianViews: null, maxViews: null, count: 0, videos: [],
      error: `videos.list ${vRes.status}: ${(vRes.error || '').slice(0, 120)}`,
    };
  }
  const vData = vRes.data as VideosPage;

  const videos: RecentUploadVideo[] = (vData.items || [])
    .filter(it => it.id)
    .map(it => {
      const sn = it.snippet ?? {};
      const stats = it.statistics ?? {};
      const thumb =
        sn.thumbnails?.maxres?.url ??
        sn.thumbnails?.high?.url ??
        sn.thumbnails?.medium?.url ??
        sn.thumbnails?.default?.url ??
        null;
      return {
        videoId: it.id!,
        title: sn.title ?? null,
        description: sn.description ?? null,
        thumbnail: thumb,
        publishedAt: sn.publishedAt ?? null,
        viewCount: parseInt(stats.viewCount || '0') || 0,
        likeCount: parseInt(stats.likeCount || '0') || 0,
        commentCount: parseInt(stats.commentCount || '0') || 0,
        durationSeconds: parseIso8601Duration(it.contentDetails?.duration),
      };
    });

  const views = videos.map(v => v.viewCount).filter(n => Number.isFinite(n) && n >= 0);

  if (views.length === 0) {
    return { avgViews: null, medianViews: null, maxViews: null, count: 0, videos };
  }

  const sum = views.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / views.length);
  const sorted = [...views].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const max = sorted[sorted.length - 1];

  return { avgViews: avg, medianViews: median, maxViews: max, count: views.length, videos };
}
