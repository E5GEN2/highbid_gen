/**
 * Shared YouTube enrichment logic — fetch video + channel data via YT Data API
 * (proxied through xgodo) and update DB rows.
 *
 * Used by:
 *   - /api/niche-spy/enrich (bulk, with SSE)
 *   - /api/niche-spy/enrich-one (single video, direct)
 */

import type { Pool } from 'pg';
import { ytFetchViaProxy } from './yt-proxy-fetch';

interface YtVideoItem {
  id: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    publishedAt?: string;
    channelId?: string;
    thumbnails?: { high?: { url?: string }; medium?: { url?: string } };
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

interface YtChannelItem {
  id: string;
  snippet?: {
    publishedAt?: string;
    thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
  };
  statistics?: { subscriberCount?: string };
}

export interface EnrichResult {
  ok: boolean;
  videoEnriched: boolean;
  channelEnriched: boolean;
  error?: string;
  proxy?: string;
  data?: {
    title?: string;
    channelName?: string;
    viewCount?: number;
    likeCount?: number;
    commentCount?: number;
    subscriberCount?: number;
    channelCreatedAt?: string;
    publishedAt?: string;
  };
}

/**
 * Enrich a single video by its YouTube video ID.
 * Fetches both video metadata + channel subscriber count, updates DB.
 */
export async function enrichSingleVideo(
  pool: Pool,
  dbId: number,
  ytVideoId: string,
  ytApiKey: string
): Promise<EnrichResult> {
  // Step 1: Fetch video metadata
  const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ytVideoId}&key=${ytApiKey}`;
  const videoRes = await ytFetchViaProxy(videoUrl);

  if (!videoRes.ok) {
    return {
      ok: false,
      videoEnriched: false,
      channelEnriched: false,
      error: `Video fetch failed: ${videoRes.error || `HTTP ${videoRes.status}`}`,
      proxy: videoRes.proxyUsed,
    };
  }

  const videoData = videoRes.data as { items?: YtVideoItem[] } | null;
  const item = videoData?.items?.[0];
  if (!item) {
    return {
      ok: false,
      videoEnriched: false,
      channelEnriched: false,
      error: 'Video not found on YouTube',
      proxy: videoRes.proxyUsed,
    };
  }

  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  const publishedAt = snippet.publishedAt ? new Date(snippet.publishedAt) : null;
  const channelId = snippet.channelId;
  const viewCount = parseInt(stats.viewCount || '0') || 0;
  const likeCount = parseInt(stats.likeCount || '0') || 0;
  const commentCount = parseInt(stats.commentCount || '0') || 0;
  const thumbnail = snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || '';

  // Update video row
  await pool.query(
    `UPDATE niche_spy_videos SET
      enriched_at = NOW(),
      title = COALESCE(NULLIF($1, ''), title),
      channel_name = COALESCE(NULLIF($2, ''), channel_name),
      posted_at = COALESCE($3, posted_at),
      view_count = CASE WHEN $4 > 0 THEN $4 ELSE view_count END,
      like_count = CASE WHEN $5 > 0 THEN $5 ELSE like_count END,
      comment_count = CASE WHEN $6 > 0 THEN $6 ELSE comment_count END,
      thumbnail = COALESCE(NULLIF($7, ''), thumbnail),
      channel_id = COALESCE(channel_id, $9)
    WHERE id = $8`,
    [
      snippet.title || '',
      snippet.channelTitle || '',
      publishedAt,
      viewCount,
      likeCount,
      commentCount,
      thumbnail,
      dbId,
      channelId || null,
    ]
  );

  // Step 2: Fetch channel subscriber count
  let channelEnriched = false;
  let subscriberCount = 0;
  let channelCreatedAt: Date | null = null;

  if (channelId) {
    const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${ytApiKey}`;
    const chRes = await ytFetchViaProxy(channelUrl);

    if (chRes.ok) {
      const chData = chRes.data as { items?: YtChannelItem[] } | null;
      const ch = chData?.items?.[0];
      if (ch) {
        subscriberCount = parseInt(ch.statistics?.subscriberCount || '0') || 0;
        channelCreatedAt = ch.snippet?.publishedAt ? new Date(ch.snippet.publishedAt) : null;
        const avatar = ch.snippet?.thumbnails?.default?.url || ch.snippet?.thumbnails?.medium?.url || '';

        await pool.query(
          `UPDATE niche_spy_videos SET
            subscriber_count = CASE WHEN $1 > 0 THEN $1 ELSE subscriber_count END,
            channel_created_at = COALESCE($2, channel_created_at),
            channel_avatar = COALESCE(NULLIF($4, ''), channel_avatar)
          WHERE id = $3`,
          [subscriberCount, channelCreatedAt, dbId, avatar]
        );

        channelEnriched = subscriberCount > 0 || !!channelCreatedAt;
      }
    }
  }

  return {
    ok: true,
    videoEnriched: true,
    channelEnriched,
    proxy: videoRes.proxyUsed,
    data: {
      title: snippet.title,
      channelName: snippet.channelTitle,
      viewCount,
      likeCount,
      commentCount,
      subscriberCount,
      channelCreatedAt: channelCreatedAt?.toISOString(),
      publishedAt: publishedAt?.toISOString(),
    },
  };
}
