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
  error?: string;
}

interface PlaylistItem {
  snippet?: { resourceId?: { videoId?: string } };
}
interface PlaylistPage {
  items?: PlaylistItem[];
  nextPageToken?: string;
}
interface VideoItem {
  id?: string;
  statistics?: { viewCount?: string };
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
    return { avgViews: null, medianViews: null, maxViews: null, count: 0, error: 'no uploads playlist' };
  }

  // Step 1: pull the first playlistItems page (newest uploads).
  const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=${maxVideos}&key=${pair.key}`;
  const plRes = await ytFetchViaProxy(plUrl, pair);
  if (!plRes.ok) {
    return {
      avgViews: null, medianViews: null, maxViews: null, count: 0,
      error: `playlistItems ${plRes.status}: ${(plRes.error || '').slice(0, 120)}`,
    };
  }
  const plData = plRes.data as PlaylistPage;
  const videoIds = (plData.items || [])
    .map(it => it.snippet?.resourceId?.videoId)
    .filter((v): v is string => !!v);

  if (videoIds.length === 0) {
    return { avgViews: null, medianViews: null, maxViews: null, count: 0 };
  }

  // Step 2: videos.list with statistics, batched 50 at a time (only need one
  // batch since we capped at 50 above).
  const idsParam = videoIds.join(',');
  const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${idsParam}&key=${pair.key}`;
  const vRes = await ytFetchViaProxy(vUrl, pair);
  if (!vRes.ok) {
    return {
      avgViews: null, medianViews: null, maxViews: null, count: 0,
      error: `videos.list ${vRes.status}: ${(vRes.error || '').slice(0, 120)}`,
    };
  }
  const vData = vRes.data as VideosPage;
  const views = (vData.items || [])
    .map(it => parseInt(it.statistics?.viewCount || '0'))
    .filter(n => Number.isFinite(n) && n >= 0);

  if (views.length === 0) {
    return { avgViews: null, medianViews: null, maxViews: null, count: 0 };
  }

  const sum = views.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / views.length);
  const sorted = [...views].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const max = sorted[sorted.length - 1];

  return { avgViews: avg, medianViews: median, maxViews: max, count: views.length };
}
