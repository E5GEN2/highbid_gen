/**
 * Refresh a channel's stats (subscriber_count, video_count, total_views)
 * from the YouTube Data API via the xgodo proxy pool, and persist to
 * niche_spy_channels.
 *
 * Why: the producer's narration ("X subscribers", "Y views") needs to
 * MATCH the about_modal screenshot that's captured at render time.
 * niche_spy_channels gets stale because no other pipeline keeps the
 * channel stats fresh — so by the time the producer runs, the DB can
 * be months behind what YT serves on the live page.
 *
 * Called from producer/start before loading channel data; safe to skip
 * silently on API failure (we keep using whatever the DB has).
 */

import type { Pool } from 'pg';
import { ytFetchViaProxy } from '../yt-proxy-fetch';
import { getNextYtPair, banYtKey } from '../yt-keys';

export interface RefreshedStats {
  channelId: string;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
  refreshedAt: Date;
}

interface YtChannelStatsItem {
  id: string;
  statistics?: {
    subscriberCount?: string;
    videoCount?: string;
    viewCount?: string;
  };
}

/**
 * Hit YT Data API `channels?part=statistics` for the given channelId,
 * update niche_spy_channels with fresh stats, and return them. Returns
 * null if the API failed or returned no items.
 *
 * Skips entirely if the channel was refreshed within the last 5 minutes
 * — producer runs in batches per listicle render, so the cache prevents
 * re-hitting the API for every niche that shares a channel.
 */
export async function refreshChannelStats(
  pool: Pool,
  channelId: string,
  opts: { maxAgeSeconds?: number } = {},
): Promise<RefreshedStats | null> {
  const maxAgeSeconds = opts.maxAgeSeconds ?? 300;

  // 1. Skip if recently refreshed.
  const cached = await pool.query<{
    subscriber_count: number | null;
    video_count: number | null;
    total_views: number | null;
    stats_refreshed_at: Date | null;
  }>(
    `SELECT subscriber_count, video_count, total_views, stats_refreshed_at
       FROM niche_spy_channels WHERE channel_id = $1`,
    [channelId],
  );
  const row = cached.rows[0];
  if (row?.stats_refreshed_at) {
    const ageSec = (Date.now() - row.stats_refreshed_at.getTime()) / 1000;
    if (ageSec < maxAgeSeconds && row.total_views != null) {
      return {
        channelId,
        subscriberCount: Number(row.subscriber_count ?? 0),
        videoCount: Number(row.video_count ?? 0),
        viewCount: Number(row.total_views ?? 0),
        refreshedAt: row.stats_refreshed_at,
      };
    }
  }

  // 2. Try up to 5 pairs — keys can be suspended/quota-exhausted; banYtKey
  //    rotates the offender out so the next getNextYtPair returns a fresh one.
  const MAX_RETRIES = 5;
  let item: YtChannelStatsItem | undefined;
  let lastError = '';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const pair = await getNextYtPair();
    if (!pair) {
      lastError = 'no YT API pair available';
      break;
    }
    const url =
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${pair.key}`;
    const res = await ytFetchViaProxy(url, pair);
    if (!res.ok) {
      if (res.status === 429 || res.status === 403) banYtKey(pair.key);
      lastError = `YT API ${res.status}: ${res.error ?? ''}`;
      continue;  // retry with a different key
    }
    const data = res.data as { items?: YtChannelStatsItem[] } | null;
    item = data?.items?.[0];
    if (!item?.statistics) {
      lastError = 'no statistics in response';
      continue;
    }
    break;
  }
  if (!item?.statistics) {
    console.warn(`[refresh-channel-stats] all retries failed for ${channelId}: ${lastError}`);
    return null;
  }
  const subscriberCount = parseInt(item.statistics.subscriberCount ?? '0', 10) || 0;
  const videoCount      = parseInt(item.statistics.videoCount      ?? '0', 10) || 0;
  const viewCount       = parseInt(item.statistics.viewCount       ?? '0', 10) || 0;
  const refreshedAt = new Date();

  // 4. Persist. Only overwrite columns when API returns >0 (defensive against
  //    YT occasionally returning zero counts during rolling updates).
  await pool.query(
    `UPDATE niche_spy_channels SET
       subscriber_count   = CASE WHEN $2 > 0 THEN $2 ELSE subscriber_count END,
       video_count        = CASE WHEN $3 > 0 THEN $3 ELSE video_count END,
       total_views        = CASE WHEN $4 > 0 THEN $4 ELSE total_views END,
       stats_refreshed_at = $5
     WHERE channel_id = $1`,
    [channelId, subscriberCount, videoCount, viewCount, refreshedAt],
  );

  return { channelId, subscriberCount, videoCount, viewCount, refreshedAt };
}
