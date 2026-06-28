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
  //
  //    Each ytFetchViaProxy attempt has a hard 8s cap (Promise.race against
  //    a rejecting setTimeout). Without this, a wedged xgodo proxy hangs
  //    the entire producer/start route — observed 2026-06-10 when a curl
  //    POST to /start sat for 90+ seconds and never returned because
  //    refreshChannelStats blocked on a proxy that never responded.
  //    With the cap, the whole loop is bounded at MAX_RETRIES × 8s worst case,
  //    but in practice ~1-2s on a healthy proxy (403s/200s return fast; only a
  //    wedged proxy hits the 8s cap, so more retries cost ~nothing normally).
  // 100 (was 10): the YT Data API pool is ~3900 active keys but a busy bake
  // (analyze + captures + refresh) leaves CLUSTERS of keys quota-exhausted (403)
  // at any moment. getNextYtPair is round-robin + ban-aware, so each 403 BANS the
  // offender (5min) and the next attempt advances to a fresh pair — i.e. retries
  // dig DEEPER into the pool and converge it to working keys. 10 was far too
  // shallow: it gave up inside one exhausted cluster, dropping proof stats to the
  // stale SUM AND skipping every channel_b candidate ("fails min-stats gate,
  // subs=?"). Deep rotation reliably finds a quota-fresh key (403s return fast, so
  // the cost is tiny — the loop STOPS the instant a key works; the ceiling is only
  // hit if a huge run of keys is exhausted). Required data points (proof
  // subs/views/videos, channel_b stats) must NOT be dropped — dig as deep as
  // needed. (user 2026-06-26: "rotate deep enough"; "don't be afraid to try 1k".)
  const MAX_RETRIES = 1000;
  const PER_ATTEMPT_TIMEOUT_MS = 8_000;
  // TOTAL time budget — dig deep through the pool, but NEVER hang the render. If
  // a key cluster is heavily quota-exhausted at this moment, stop after DEADLINE_MS
  // and fall back to the stored stat (already a recent prod-API value). Without
  // this cap the 1000-retry loop churned ~50min on ONE channel when the pool was
  // exhausted, hanging the whole render (user 2026-06-26).
  const DEADLINE_MS = 45_000;
  const startMs = Date.now();
  let item: YtChannelStatsItem | undefined;
  let lastError = '';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (Date.now() - startMs > DEADLINE_MS) { lastError = `time budget ${DEADLINE_MS}ms exhausted after ${attempt} attempts`; break; }
    const pair = await getNextYtPair();
    if (!pair) {
      lastError = 'no YT API pair available';
      break;
    }
    const url =
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${pair.key}`;
    let res: Awaited<ReturnType<typeof ytFetchViaProxy>>;
    try {
      res = await Promise.race([
        ytFetchViaProxy(url, pair),
        new Promise<Awaited<ReturnType<typeof ytFetchViaProxy>>>((_, reject) => setTimeout(
          () => reject(new Error(`HARD_TIMEOUT ${PER_ATTEMPT_TIMEOUT_MS}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)),
          PER_ATTEMPT_TIMEOUT_MS,
        )),
      ]);
    } catch (e) {
      lastError = (e as Error).message;
      continue;  // proxy hung — try a different one
    }
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
  //    EXPLICIT ::bigint casts on subscriber_count and total_views — these
  //    can exceed INT4 max (2.1B) for whales like MrBeast (128B views). Without
  //    the cast, Postgres types the `$N > 0` comparison as INTEGER and
  //    overflows at bind time with "value X is out of range for type integer"
  //    (observed 2026-06-10 on the 10-channel listicle render — every channel
  //    with >2.1B views failed loadChannel).
  await pool.query(
    `UPDATE niche_spy_channels SET
       subscriber_count   = CASE WHEN $2::bigint > 0 THEN $2::bigint ELSE subscriber_count END,
       video_count        = CASE WHEN $3 > 0 THEN $3 ELSE video_count END,
       total_views        = CASE WHEN $4::bigint > 0 THEN $4::bigint ELSE total_views END,
       stats_refreshed_at = $5
     WHERE channel_id = $1`,
    [channelId, subscriberCount, videoCount, viewCount, refreshedAt],
  );

  return { channelId, subscriberCount, videoCount, viewCount, refreshedAt };
}
