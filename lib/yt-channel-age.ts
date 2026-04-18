/**
 * Fetch "real active age" for a YouTube channel by finding its first-ever upload.
 *
 * The uploads playlist is returned newest-first, so we paginate via pageToken
 * until the last page. The LAST item on the LAST page is the first upload.
 *
 * Quota cost: 1 unit per page of 50. For channels with >200 uploads we skip
 * the deep check (they're almost always legitimate).
 *
 * Returns first_upload_at, latest_upload_at, and dormancy_days computed
 * against the passed-in channel_created_at.
 */

import { ytFetchViaProxy } from './yt-proxy-fetch';
import type { YtKeyProxyPair } from './yt-keys';

export interface AgeResult {
  firstUploadAt: string | null;     // ISO timestamp of channel's first upload
  latestUploadAt: string | null;    // ISO timestamp of channel's most recent upload
  dormancyDays: number | null;      // days between channel creation and first upload
  pagesWalked: number;              // how many playlistItems pages we hit (for quota accounting)
  skipped: boolean;                 // true if we early-exited (e.g. videoCount > threshold)
  error?: string;
}

interface PlaylistItem {
  snippet?: { publishedAt?: string };
}
interface PlaylistPage {
  items?: PlaylistItem[];
  nextPageToken?: string;
}

export async function fetchChannelFirstUpload(
  channelCreatedAt: string | null,
  uploadsPlaylistId: string,
  videoCount: number,
  pair: YtKeyProxyPair,
  options?: { skipOverVideoCount?: number; maxPages?: number },
): Promise<AgeResult> {
  const skipOver = options?.skipOverVideoCount ?? 200;
  const maxPages = options?.maxPages ?? 30;   // hard cap at 1500 uploads

  if (!uploadsPlaylistId) {
    return { firstUploadAt: null, latestUploadAt: null, dormancyDays: null, pagesWalked: 0, skipped: false, error: 'no uploads playlist' };
  }
  if (videoCount === 0) {
    return { firstUploadAt: null, latestUploadAt: null, dormancyDays: null, pagesWalked: 0, skipped: false };
  }
  if (videoCount > skipOver) {
    return { firstUploadAt: null, latestUploadAt: null, dormancyDays: null, pagesWalked: 0, skipped: true };
  }

  let pageToken: string | undefined;
  let firstPage: PlaylistPage | null = null;
  let lastPage: PlaylistPage | null = null;
  let pages = 0;

  for (let p = 0; p < maxPages; p++) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}&key=${pair.key}`;
    const res = await ytFetchViaProxy(url, pair);
    if (!res.ok) {
      // Return whatever we have so far with an error
      return {
        firstUploadAt: null,
        latestUploadAt: firstPage?.items?.[0]?.snippet?.publishedAt || null,
        dormancyDays: null,
        pagesWalked: pages,
        skipped: false,
        error: `YT ${res.status}: ${(res.error || '').slice(0, 120)}`,
      };
    }
    const data = res.data as PlaylistPage;
    pages++;
    if (p === 0) firstPage = data;
    lastPage = data;
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  const firstItems = firstPage?.items || [];
  const lastItems = lastPage?.items || [];
  const latestUploadAt = firstItems[0]?.snippet?.publishedAt || null;
  const firstUploadAt = lastItems[lastItems.length - 1]?.snippet?.publishedAt || null;

  let dormancyDays: number | null = null;
  if (firstUploadAt && channelCreatedAt) {
    const diffMs = new Date(firstUploadAt).getTime() - new Date(channelCreatedAt).getTime();
    dormancyDays = Math.round(diffMs / 86_400_000);
  }

  return {
    firstUploadAt,
    latestUploadAt,
    dormancyDays,
    pagesWalked: pages,
    skipped: false,
  };
}
