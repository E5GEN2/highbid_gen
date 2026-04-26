/**
 * Refresh YouTube view/like/comment counts for uploaded Vizard clips.
 *
 * Uses the existing YT Data API key + proxy infrastructure
 * (lib/yt-keys.ts, lib/yt-proxy-fetch.ts) to query
 * GET /youtube/v3/videos?part=statistics&id=<batch-of-50> — 1 quota unit
 * per call. For our typical 40-clip project, that's 1 call total.
 */

import { getPool } from './db';
import { getNextYtPair, banYtKey } from './yt-keys';
import { ytFetchViaProxy } from './yt-proxy-fetch';

/**
 * Extract the 11-char YouTube video ID from a URL. Handles every shape we
 * see in vizard_clips.youtube_url:
 *   https://youtube.com/shorts/<id>
 *   https://www.youtube.com/shorts/<id>
 *   https://youtu.be/<id>
 *   https://www.youtube.com/watch?v=<id>
 * Returns null when the URL doesn't look like a YouTube link or the id can't
 * be isolated.
 */
export function extractYouTubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  // youtu.be/<id>
  let m = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  // /shorts/<id>
  m = url.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  // ?v=<id>
  m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

interface YtStatsItem {
  id?: string;
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

/**
 * Refresh view/like/comment counts for the given clip ids. If `clipIds` is
 * omitted, refreshes EVERY clip with an uploaded YT URL whose stats are stale
 * (older than `staleMinutes`, default 60).
 *
 * Returns the number of clips updated and any errors. The caller can pass
 * { force: true } to skip the staleness gate.
 */
export async function refreshClipViewCounts(options?: {
  clipIds?: number[];
  staleMinutes?: number;
  force?: boolean;
}): Promise<{ ok: true; updated: number; errors: number; calls: number } | { ok: false; error: string }> {
  const pool = await getPool();
  const stale = Math.max(1, options?.staleMinutes ?? 60);
  const force = !!options?.force;

  // Pull rows that need refreshing. youtube_url must be set (clip uploaded).
  const conditions: string[] = ['youtube_url IS NOT NULL'];
  const params: (string | number | number[])[] = [];
  if (options?.clipIds && options.clipIds.length > 0) {
    conditions.push(`id = ANY($${params.length + 1}::int[])`);
    params.push(options.clipIds);
  } else if (!force) {
    // Bulk mode: only refresh stale rows. force=true bypasses this for the
    // "refresh everything now" admin button.
    conditions.push(
      `(youtube_views_fetched_at IS NULL
        OR youtube_views_fetched_at < NOW() - INTERVAL '${stale} minutes')`
    );
  }
  const rows = await pool.query<{ id: number; youtube_url: string; youtube_video_id: string | null }>(
    `SELECT id, youtube_url, youtube_video_id FROM vizard_clips WHERE ${conditions.join(' AND ')}`,
    params
  );

  if (rows.rows.length === 0) {
    return { ok: true, updated: 0, errors: 0, calls: 0 };
  }

  // Build (clipId → videoId) map; backfill youtube_video_id when missing.
  const clipsByVideoId = new Map<string, number[]>();
  const backfills: Array<{ clipId: number; videoId: string }> = [];
  for (const r of rows.rows) {
    const vid = r.youtube_video_id || extractYouTubeVideoId(r.youtube_url);
    if (!vid) continue;
    if (!r.youtube_video_id) backfills.push({ clipId: r.id, videoId: vid });
    if (!clipsByVideoId.has(vid)) clipsByVideoId.set(vid, []);
    clipsByVideoId.get(vid)!.push(r.id);
  }
  for (const b of backfills) {
    await pool.query(`UPDATE vizard_clips SET youtube_video_id = $1 WHERE id = $2`, [b.videoId, b.clipId]).catch(() => {});
  }

  const allVideoIds = Array.from(clipsByVideoId.keys());
  if (allVideoIds.length === 0) {
    return { ok: true, updated: 0, errors: 0, calls: 0 };
  }

  let updated = 0, errors = 0, calls = 0;
  // YT Data API videos.list accepts up to 50 ids per call. Cost: 1 unit each.
  for (let i = 0; i < allVideoIds.length; i += 50) {
    const batch = allVideoIds.slice(i, i + 50);
    const pair = await getNextYtPair();
    if (!pair) return { ok: false, error: 'no YT API key configured (set niche_yt_api_keys or youtube_api_key)' };

    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${batch.join(',')}&key=${pair.key}`;
    const res = await ytFetchViaProxy(url, pair);
    calls++;
    if (!res.ok) {
      errors++;
      // 429/403 → ban this key/proxy pair for the cooldown window so the
      // next batch picks a different one.
      if (res.status === 429 || res.status === 403) banYtKey(pair.key);
      console.warn(`[yt-clip-views] batch ${i / 50 + 1} failed: ${res.status} ${(res.error || '').slice(0, 120)}`);
      continue;
    }
    const data = res.data as { items?: YtStatsItem[] };
    for (const item of data.items || []) {
      const id = item.id; if (!id) continue;
      const clipIds = clipsByVideoId.get(id);
      if (!clipIds) continue;
      const v = parseInt(item.statistics?.viewCount    || '0') || 0;
      const l = parseInt(item.statistics?.likeCount    || '0') || 0;
      const c = parseInt(item.statistics?.commentCount || '0') || 0;
      for (const clipId of clipIds) {
        await pool.query(
          `UPDATE vizard_clips SET
             youtube_view_count = $1,
             youtube_like_count = $2,
             youtube_comment_count = $3,
             youtube_views_fetched_at = NOW()
           WHERE id = $4`,
          [v, l, c, clipId]
        );
        updated++;
      }
    }
  }

  return { ok: true, updated, errors, calls };
}
