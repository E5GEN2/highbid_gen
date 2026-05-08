/**
 * Refresh YouTube view/like/comment counts for uploaded Vizard clips.
 *
 * Uses the existing YT Data API key + proxy infrastructure
 * (lib/yt-keys.ts, lib/yt-proxy-fetch.ts) to query
 * GET /youtube/v3/videos?part=statistics&id=<batch-of-50> — 1 quota unit
 * per call.
 *
 * Threading: batches of 50 ids are sliced across N worker threads
 * (default 10). Each worker pulls a key+proxy pair pinned to its
 * threadIdx so we don't hammer one key with N parallel calls.
 *
 * Progress reporting: an optional `jobId` writes per-batch updates to
 * the vizard_refresh_jobs row, so callers can poll the DB for status
 * instead of holding a long SSE connection.
 */

import { getPool } from './db';
import { pickRandomActiveYtPair, banYtKey } from './yt-keys';
import { ytFetchViaProxy } from './yt-proxy-fetch';

/**
 * Extract the 11-char YouTube video ID from a URL. Handles every shape we
 * see in vizard_clips.youtube_url:
 *   https://youtube.com/shorts/<id>
 *   https://www.youtube.com/shorts/<id>
 *   https://youtu.be/<id>
 *   https://www.youtube.com/watch?v=<id>
 */
export function extractYouTubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  let m = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

interface YtStatsItem {
  id?: string;
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

export interface RefreshClipViewsProgress {
  totalBatches: number;
  completedBatches: number;
  totalClips: number;
  updated: number;
  errors: number;
  calls: number;
}

const DEFAULT_THREADS = 10;
const MAX_THREADS = 30;

/**
 * Refresh view/like/comment counts for the given clip ids. If `clipIds`
 * is omitted, refreshes EVERY clip with an uploaded YT URL whose stats
 * are stale (older than `staleMinutes`, default 60). Pass `force: true`
 * to skip the staleness gate.
 */
export async function refreshClipViewCounts(options?: {
  clipIds?: number[];
  staleMinutes?: number;
  force?: boolean;
  /** Number of parallel workers (default 10, capped at 30 and at the active key count). */
  threads?: number;
  /** If set, persist progress to vizard_refresh_jobs.<jobId> after every batch
   *  AND check that row's status='running' before each batch (cancellation). */
  jobId?: number;
  /** Optional in-process progress callback for SSE / live UI. Fires after every batch. */
  onProgress?: (p: RefreshClipViewsProgress) => void;
}): Promise<{ ok: true; updated: number; errors: number; calls: number; totalClips: number; cancelled?: boolean } | { ok: false; error: string }> {
  const pool = await getPool();
  const stale = Math.max(1, options?.staleMinutes ?? 60);
  const force = !!options?.force;
  const requestedThreads = Math.max(1, Math.min(MAX_THREADS, options?.threads ?? DEFAULT_THREADS));

  const conditions: string[] = ['youtube_url IS NOT NULL'];
  const params: (string | number | number[])[] = [];
  if (options?.clipIds && options.clipIds.length > 0) {
    conditions.push(`id = ANY($${params.length + 1}::int[])`);
    params.push(options.clipIds);
  } else if (!force) {
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
    options?.onProgress?.({ totalBatches: 0, completedBatches: 0, totalClips: 0, updated: 0, errors: 0, calls: 0 });
    if (options?.jobId) await markJobDone(options.jobId, 0, 0, 0, 0, 0);
    return { ok: true, updated: 0, errors: 0, calls: 0, totalClips: 0 };
  }

  // Build (videoId → clipIds[]) map; backfill youtube_video_id when missing.
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
  const totalClips = rows.rows.length;
  const totalBatches = Math.ceil(allVideoIds.length / 50);
  if (allVideoIds.length === 0) {
    options?.onProgress?.({ totalBatches: 0, completedBatches: 0, totalClips, updated: 0, errors: 0, calls: 0 });
    if (options?.jobId) await markJobDone(options.jobId, totalClips, 0, 0, 0, 0);
    return { ok: true, updated: 0, errors: 0, calls: 0, totalClips };
  }

  // Build a shared work queue of {batch, attempts} items. Workers shift
  // off the queue; on transient failure (429/403/proxy), they push the
  // batch back with attempts+1 so a different worker (with a different
  // key+proxy) gets a fresh try. This was the bug behind "0 of 688
  // clips updated" — pre-sliced thread-local lists meant any failed
  // batch was permanently lost regardless of how many other keys were
  // available. Cap attempts so a poison batch doesn't loop forever.
  const MAX_ATTEMPTS = 3;
  type QueueItem = { batch: string[]; attempts: number };
  const queue: QueueItem[] = [];
  for (let i = 0; i < allVideoIds.length; i += 50) {
    queue.push({ batch: allVideoIds.slice(i, i + 50), attempts: 0 });
  }
  const threadCount = Math.max(1, Math.min(requestedThreads, queue.length));

  // Shared mutable counters — every worker writes here. JS is single-
  // threaded; the only async boundary is the await between batches, so
  // ordinary increment is safe.
  let updated = 0, errors = 0, calls = 0, completedBatches = 0;
  let cancelled = false;
  const initial: RefreshClipViewsProgress = { totalBatches, completedBatches: 0, totalClips, updated: 0, errors: 0, calls: 0 };
  options?.onProgress?.(initial);
  if (options?.jobId) await persistProgress(options.jobId, totalClips, totalBatches, 0, 0, 0, 0);

  // Cancel-check throttle: hit the DB at most once per second per
  // worker so we don't drown the connection pool.
  let lastCancelCheck = 0;
  const isCancelled = async (): Promise<boolean> => {
    if (!options?.jobId) return false;
    if (cancelled) return true;
    if (Date.now() - lastCancelCheck < 1000) return false;
    lastCancelCheck = Date.now();
    try {
      const r = await pool.query<{ status: string }>(`SELECT status FROM vizard_refresh_jobs WHERE id = $1`, [options.jobId]);
      if (r.rows[0]?.status === 'cancelled') {
        cancelled = true;
        return true;
      }
    } catch { /* transient — assume not cancelled */ }
    return false;
  };

  async function worker(threadIdx: number) {
    while (true) {
      if (await isCancelled()) return;
      const item = queue.shift();
      if (!item) return;  // queue empty — worker exits

      const pair = await pickRandomActiveYtPair();
      if (!pair) {
        // No keys at all — count as final failure for this batch.
        errors++;
        completedBatches++;
        continue;
      }

      const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${item.batch.join(',')}&key=${pair.key}`;
      let succeeded = false;
      let retryable = false;
      try {
        const res = await ytFetchViaProxy(url, pair);
        calls++;
        if (!res.ok) {
          // 429/403/5xx are transient — different key+proxy may work.
          // 400 is usually a bad request shape (won't fix on retry).
          retryable = res.status === 429 || res.status === 403 || (res.status >= 500 && res.status < 600) || res.status === 0;
          if (res.status === 429 || res.status === 403) banYtKey(pair.key);
          console.warn(`[yt-clip-views] thread ${threadIdx} batch failed (attempt ${item.attempts + 1}): ${res.status} ${(res.error || '').slice(0, 120)}`);
        } else {
          succeeded = true;
          const data = res.data as { items?: YtStatsItem[] };
          for (const item2 of data.items || []) {
            const id = item2.id; if (!id) continue;
            const clipIds = clipsByVideoId.get(id);
            if (!clipIds) continue;
            const v = parseInt(item2.statistics?.viewCount    || '0') || 0;
            const l = parseInt(item2.statistics?.likeCount    || '0') || 0;
            const c = parseInt(item2.statistics?.commentCount || '0') || 0;
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
      } catch (err) {
        // Network / proxy throw — retry with a fresh pair.
        retryable = true;
        console.warn(`[yt-clip-views] thread ${threadIdx} batch threw (attempt ${item.attempts + 1}):`, err instanceof Error ? err.message : err);
      }

      if (succeeded) {
        completedBatches++;
      } else if (retryable && item.attempts + 1 < MAX_ATTEMPTS) {
        // Push back for another worker to pick up. Don't bump
        // completedBatches — the batch isn't done yet.
        queue.push({ batch: item.batch, attempts: item.attempts + 1 });
      } else {
        // Out of retries or non-retryable error — count it as a
        // permanent batch error.
        errors++;
        completedBatches++;
      }

      const snapshot: RefreshClipViewsProgress = { totalBatches, completedBatches, totalClips, updated, errors, calls };
      options?.onProgress?.(snapshot);
      if (options?.jobId) {
        // Per-batch DB write is fine (10 threads × few batches each =
        // tens of writes total, dwarfed by the YT API call latency).
        persistProgress(options.jobId, totalClips, totalBatches, completedBatches, updated, errors, calls).catch(() => {});
      }
    }
  }

  // N parallel workers all pulling from the shared queue.
  await Promise.all(Array.from({ length: threadCount }, (_, i) => worker(i)));

  if (cancelled) {
    if (options?.jobId) await markJobCancelled(options.jobId, totalClips, totalBatches, completedBatches, updated, errors, calls);
    return { ok: true, updated, errors, calls, totalClips, cancelled: true };
  }
  if (options?.jobId) await markJobDone(options.jobId, totalClips, totalBatches, updated, errors, calls);
  return { ok: true, updated, errors, calls, totalClips };
}

async function persistProgress(jobId: number, totalClips: number, totalBatches: number, completedBatches: number, updated: number, errors: number, calls: number): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE vizard_refresh_jobs
       SET total_clips = $1,
           total_batches = $2,
           completed_batches = $3,
           updated = $4,
           errors = $5,
           calls = $6,
           last_progress_at = NOW()
     WHERE id = $7 AND status = 'running'`,
    [totalClips, totalBatches, completedBatches, updated, errors, calls, jobId]
  );
}

async function markJobDone(jobId: number, totalClips: number, totalBatches: number, updated: number, errors: number, calls: number): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE vizard_refresh_jobs
       SET status = 'done',
           total_clips = $1,
           total_batches = $2,
           completed_batches = $2,
           updated = $3,
           errors = $4,
           calls = $5,
           completed_at = NOW(),
           last_progress_at = NOW()
     WHERE id = $6 AND status = 'running'`,
    [totalClips, totalBatches, updated, errors, calls, jobId]
  );
}

async function markJobCancelled(jobId: number, totalClips: number, totalBatches: number, completedBatches: number, updated: number, errors: number, calls: number): Promise<void> {
  const pool = await getPool();
  // Only flip if it's still 'running' — DELETE handler may have already set 'cancelled'.
  await pool.query(
    `UPDATE vizard_refresh_jobs
       SET total_clips = $1,
           total_batches = $2,
           completed_batches = $3,
           updated = $4,
           errors = $5,
           calls = $6,
           completed_at = NOW(),
           last_progress_at = NOW()
     WHERE id = $7`,
    [totalClips, totalBatches, completedBatches, updated, errors, calls, jobId]
  );
}
