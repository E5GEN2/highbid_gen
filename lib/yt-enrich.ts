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
    title?: string;
    publishedAt?: string;
    customUrl?: string;
    thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
  };
  statistics?: { subscriberCount?: string; videoCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
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
    const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&id=${channelId}&key=${ytApiKey}`;
    const chRes = await ytFetchViaProxy(channelUrl);

    if (chRes.ok) {
      const chData = chRes.data as { items?: YtChannelItem[] } | null;
      const ch = chData?.items?.[0];
      if (ch) {
        subscriberCount = parseInt(ch.statistics?.subscriberCount || '0') || 0;
        const videoCount = parseInt(ch.statistics?.videoCount || '0') || 0;
        channelCreatedAt = ch.snippet?.publishedAt ? new Date(ch.snippet.publishedAt) : null;
        const avatar = ch.snippet?.thumbnails?.default?.url || ch.snippet?.thumbnails?.medium?.url || '';
        const channelName = ch.snippet?.title || null;
        const handle = ch.snippet?.customUrl || null;
        const uploadsId = ch.contentDetails?.relatedPlaylists?.uploads || null;

        // Upsert into channels table — single source of truth
        await pool.query(`
          INSERT INTO niche_spy_channels
            (channel_id, channel_name, channel_handle, channel_avatar,
             subscriber_count, channel_created_at, video_count, uploads_playlist_id,
             last_channel_fetched_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (channel_id) DO UPDATE SET
            channel_name   = COALESCE(NULLIF(EXCLUDED.channel_name, ''),   niche_spy_channels.channel_name),
            channel_handle = COALESCE(NULLIF(EXCLUDED.channel_handle, ''), niche_spy_channels.channel_handle),
            channel_avatar = COALESCE(NULLIF(EXCLUDED.channel_avatar, ''), niche_spy_channels.channel_avatar),
            subscriber_count   = CASE WHEN EXCLUDED.subscriber_count > 0 THEN EXCLUDED.subscriber_count ELSE niche_spy_channels.subscriber_count END,
            channel_created_at = COALESCE(EXCLUDED.channel_created_at,    niche_spy_channels.channel_created_at),
            video_count        = CASE WHEN EXCLUDED.video_count > 0 THEN EXCLUDED.video_count ELSE niche_spy_channels.video_count END,
            uploads_playlist_id = COALESCE(EXCLUDED.uploads_playlist_id,  niche_spy_channels.uploads_playlist_id),
            last_channel_fetched_at = NOW()
        `, [channelId, channelName, handle, avatar, subscriberCount, channelCreatedAt, videoCount, uploadsId]).catch(() => {});

        // Mirror into video row so existing reads keep working
        await pool.query(
          `UPDATE niche_spy_videos SET
            subscriber_count = CASE WHEN $1 > 0 THEN $1 ELSE subscriber_count END,
            channel_created_at = COALESCE($2, channel_created_at),
            channel_avatar = COALESCE(NULLIF($4, ''), channel_avatar)
          WHERE id = $3`,
          [subscriberCount, channelCreatedAt, dbId, avatar]
        );

        channelEnriched = subscriberCount > 0 || !!channelCreatedAt;

        // Opportunistically kick off first-upload check for this channel IF we don't
        // have it yet AND video count looks tractable. We use the SAME API key the
        // video fetch is using — no need for a key-proxy pair, ytFetchViaProxy will
        // pick any available proxy.
        if (uploadsId && videoCount > 0 && videoCount <= 200) {
          const existingRes = await pool.query(
            `SELECT first_upload_at FROM niche_spy_channels WHERE channel_id = $1`,
            [channelId]
          );
          if (!existingRes.rows[0]?.first_upload_at) {
            // Fire-and-forget — don't block the main video enrichment response
            (async () => {
              try {
                const { fetchChannelFirstUpload } = await import('./yt-channel-age');
                // Build a minimal pair object so fetchChannelFirstUpload accepts it
                const pair = { key: ytApiKey, proxyUrl: '', proxyDeviceId: 'single', banned: false, banExpiry: 0 };
                const age = await fetchChannelFirstUpload(
                  channelCreatedAt?.toISOString() || null,
                  uploadsId,
                  videoCount,
                  pair,
                  { skipOverVideoCount: 200 },
                );
                await pool.query(`
                  UPDATE niche_spy_channels SET
                    first_upload_at  = COALESCE($1, first_upload_at),
                    latest_upload_at = COALESCE($2, latest_upload_at),
                    dormancy_days    = COALESCE($3, dormancy_days),
                    last_uploads_fetched_at = NOW(),
                    error_message    = $4
                  WHERE channel_id = $5
                `, [age.firstUploadAt, age.latestUploadAt, age.dormancyDays, age.error || null, channelId]);
              } catch (err) {
                console.warn('[enrichSingleVideo] first-upload check failed:', (err as Error).message);
              }
            })();
          }
        }
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
