import { getPool } from '@/lib/db';
import { pickRandomActiveYtPair, banYtKey } from '@/lib/yt-keys';
import { ytFetchViaProxy } from '@/lib/yt-proxy-fetch';
import { fetchChannelRecentUploads } from '@/lib/yt-recent-uploads';
import { upsertRecentVideos } from '@/lib/outlier-enrich';

/**
 * SHARED channel re-measurement engine — the "essence" both the corpus enricher
 * and the niche Watcher run. Given a set of channel IDs it fetches fresh channel
 * STATS (subs / video_count / uploads-playlist) and, optionally, RECENT UPLOADS
 * via the YT Data API, and writes them to niche_spy_channels + niche_spy_videos.
 *
 * No job / loop / cancellation baggage here — pure engine. The enricher wraps it
 * in a corpus-selection loop; the Watcher wraps it in a watched-niche selection +
 * notification layer. (The enricher itself will migrate onto this next.)
 *
 * Sequential + bounded on purpose — callers pass a bounded batch per tick.
 */
interface YtChannelItem {
  id: string;
  snippet?: {
    title?: string; customUrl?: string; publishedAt?: string;
    thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
  };
  statistics?: { subscriberCount?: string; videoCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

export interface ReMeasureResult {
  requested: number;
  statsUpdated: number;    // channels whose stats row was upserted
  recentPulled: number;    // channels whose recent uploads were refreshed
  errors: number;
}

export async function reMeasureChannels(
  channelIds: string[],
  opts: { recentUploads?: boolean; maxRecent?: number } = {},
): Promise<ReMeasureResult> {
  const pool = await getPool();
  const result: ReMeasureResult = { requested: channelIds.length, statsUpdated: 0, recentPulled: 0, errors: 0 };
  if (channelIds.length === 0) return result;
  const recentUploads = opts.recentUploads ?? true;

  // ── 1) Channel stats, in batches of 50 (YT channels.list cap) ───────────
  for (let i = 0; i < channelIds.length; i += 50) {
    const ids = channelIds.slice(i, i + 50);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1200 * attempt));
      const pair = await pickRandomActiveYtPair();
      if (!pair) { result.errors++; break; }
      const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&id=${ids.join(',')}&key=${pair.key}`;
      const res = await ytFetchViaProxy(url, pair);
      if (!res.ok) {
        const msg = (res.error || '').slice(0, 120);
        if (res.status === 429 || res.status === 403 || /quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(msg)) banYtKey(pair.key);
        if (attempt === 2) result.errors++;
        continue;
      }
      ok = true;
      const items = ((res.data as { items?: YtChannelItem[] } | null)?.items) || [];
      for (const ch of items) {
        const subCount = parseInt(ch.statistics?.subscriberCount || '0') || 0;
        const videoCount = parseInt(ch.statistics?.videoCount || '0') || 0;
        const channelCreatedAt = ch.snippet?.publishedAt ? new Date(ch.snippet.publishedAt) : null;
        const avatar = ch.snippet?.thumbnails?.default?.url || ch.snippet?.thumbnails?.medium?.url || '';
        const channelName = ch.snippet?.title || null;
        const handle = ch.snippet?.customUrl || null;
        const uploadsId = ch.contentDetails?.relatedPlaylists?.uploads || null;
        // ::bigint casts: counts can exceed int4 (billions of views/subs); a bare
        // param would infer int4 and overflow — see the 2026-07-14 enricher incident.
        await pool.query(
          `INSERT INTO niche_spy_channels
             (channel_id, channel_name, channel_handle, channel_avatar,
              subscriber_count, channel_created_at, video_count, uploads_playlist_id, last_channel_fetched_at)
           VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::bigint, $8, NOW())
           ON CONFLICT (channel_id) DO UPDATE SET
             channel_name   = COALESCE(NULLIF(EXCLUDED.channel_name, ''),   niche_spy_channels.channel_name),
             channel_handle = COALESCE(NULLIF(EXCLUDED.channel_handle, ''), niche_spy_channels.channel_handle),
             channel_avatar = COALESCE(NULLIF(EXCLUDED.channel_avatar, ''), niche_spy_channels.channel_avatar),
             subscriber_count = CASE WHEN EXCLUDED.subscriber_count > 0 THEN EXCLUDED.subscriber_count ELSE niche_spy_channels.subscriber_count END,
             channel_created_at = COALESCE(EXCLUDED.channel_created_at, niche_spy_channels.channel_created_at),
             video_count = CASE WHEN EXCLUDED.video_count > 0 THEN EXCLUDED.video_count ELSE niche_spy_channels.video_count END,
             uploads_playlist_id = COALESCE(EXCLUDED.uploads_playlist_id, niche_spy_channels.uploads_playlist_id),
             last_channel_fetched_at = NOW()`,
          [ch.id, channelName, handle, avatar, subCount, channelCreatedAt, videoCount, uploadsId],
        ).then(() => { result.statsUpdated++; }).catch(() => { result.errors++; });
      }
    }
  }

  if (!recentUploads) return result;

  // ── 2) Recent uploads — pulls NEW videos from these (known) channels, which
  //       is how the Watcher surfaces "new". Uses each channel's uploads
  //       playlist (freshly fetched above OR already on the row). ───────────
  const upRes = await pool.query<{ channel_id: string; uploads_playlist_id: string | null }>(
    `SELECT channel_id, uploads_playlist_id FROM niche_spy_channels
      WHERE channel_id = ANY($1::text[]) AND uploads_playlist_id IS NOT NULL`,
    [channelIds],
  );
  for (const row of upRes.rows) {
    const pair = await pickRandomActiveYtPair();
    if (!pair) { result.errors++; continue; }
    try {
      const r = await fetchChannelRecentUploads(row.uploads_playlist_id!, pair, { maxVideos: opts.maxRecent ?? 10 });
      if (r.error) { result.errors++; continue; }
      if (r.videos && r.videos.length > 0) {
        await upsertRecentVideos(pool, row.channel_id, r.videos);
        await pool.query(
          `UPDATE niche_spy_channels SET
             recent_videos_avg_views = $1, recent_videos_median_views = $2, recent_videos_max_views = $3,
             recent_videos_count = $4, last_recent_videos_fetched_at = NOW()
           WHERE channel_id = $5`,
          [r.avgViews, r.medianViews, r.maxViews, r.count, row.channel_id],
        ).catch(() => {});
        result.recentPulled++;
      }
    } catch { result.errors++; }
  }

  return result;
}
