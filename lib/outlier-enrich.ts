/**
 * Outlier Pipeline channel enrichment — shared-queue worker that walks
 * each channel's most recent uploads (playlistItems + videos.list)
 * and writes back unbiased avg / median / max view stats to
 * niche_spy_channels. The values feed the peer-bucket outlier score.
 *
 * Mirrors the patterns we settled on for refresh-views:
 *   - pickRandomActiveYtPair (random key + freshly-random proxy on
 *     each call) so a transient bad proxy can't take down a slice
 *   - shared queue with attempts++ on retryable failures, max 3
 *   - jobId-aware DB progress writes + cooperative cancel
 *
 * Cost per channel: 1 quota unit playlistItems + 1 unit videos.list
 * = 2 units. With the 487-key pool that's tens of thousands of
 * channels per day on free tier.
 */

import { getPool } from './db';
import { pickRandomActiveYtPair, banYtKey, invalidateYtKey } from './yt-keys';
import { fetchChannelRecentUploads } from './yt-recent-uploads';

export interface OutlierEnrichProgress {
  total: number;
  processed: number;
  withStats: number;
  errors: number;
  calls: number;
}

interface ChannelRow {
  channel_id: string;
  uploads_playlist_id: string;
}

const MAX_ATTEMPTS = 3;

export async function runOutlierEnrich(opts: {
  limit?: number;
  threads?: number;
  maxVideos?: number;
  staleDays?: number;
  force?: boolean;
  /** When set, persist per-batch progress to outlier_enrich_jobs.<jobId>
   *  AND check the row's status='running' before each unit (cancel). */
  jobId?: number;
  /** Optional in-process progress callback for SSE / live UI. */
  onProgress?: (p: OutlierEnrichProgress) => void;
}): Promise<OutlierEnrichProgress & { ok: true; cancelled?: boolean }> {
  const pool = await getPool();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 5000);
  const requestedThreads = Math.max(1, Math.min(opts.threads ?? 10, 30));
  const maxVideos = Math.min(Math.max(opts.maxVideos ?? 30, 5), 50);
  const staleDays = Math.max(opts.staleDays ?? 7, 0);
  const force = !!opts.force;

  const staleCondition = force
    ? ''
    : `AND (last_recent_videos_fetched_at IS NULL
           OR last_recent_videos_fetched_at < NOW() - INTERVAL '${staleDays} days')`;

  const dueRes = await pool.query<ChannelRow>(
    `SELECT channel_id, uploads_playlist_id
       FROM niche_spy_channels
      WHERE uploads_playlist_id IS NOT NULL
        ${staleCondition}
   ORDER BY last_recent_videos_fetched_at ASC NULLS FIRST
      LIMIT $1`,
    [limit],
  );

  type QueueItem = { channel: ChannelRow; attempts: number };
  const queue: QueueItem[] = dueRes.rows.map(c => ({ channel: c, attempts: 0 }));
  const total = queue.length;
  const threadCount = Math.max(1, Math.min(requestedThreads, total));

  let processed = 0, withStats = 0, errors = 0, calls = 0;
  let cancelled = false;

  const emit = () => {
    const p: OutlierEnrichProgress = { total, processed, withStats, errors, calls };
    opts.onProgress?.(p);
    if (opts.jobId) {
      persistProgress(opts.jobId, total, processed, withStats, errors, calls).catch(() => {});
    }
  };
  emit();

  if (total === 0) {
    if (opts.jobId) await markJobDone(opts.jobId, total, processed, withStats, errors, calls);
    return { ok: true, total, processed, withStats, errors, calls };
  }

  // Cancel-check throttle so we don't drown the connection pool.
  let lastCancelCheck = 0;
  const isCancelled = async (): Promise<boolean> => {
    if (!opts.jobId) return false;
    if (cancelled) return true;
    if (Date.now() - lastCancelCheck < 1000) return false;
    lastCancelCheck = Date.now();
    try {
      const r = await pool.query<{ status: string }>(
        `SELECT status FROM outlier_enrich_jobs WHERE id = $1`,
        [opts.jobId],
      );
      if (r.rows[0]?.status === 'cancelled') {
        cancelled = true;
        return true;
      }
    } catch { /* transient — assume not cancelled */ }
    return false;
  };

  async function worker() {
    while (queue.length > 0) {
      if (await isCancelled()) return;
      const item = queue.shift();
      if (!item) return;

      const pair = await pickRandomActiveYtPair();
      if (!pair) {
        errors++;
        processed++;
        emit();
        continue;
      }

      let succeeded = false;
      let retryable = false;

      try {
        const result = await fetchChannelRecentUploads(item.channel.uploads_playlist_id, pair, { maxVideos });
        // Each enrich call costs ~2 quota units (playlistItems + videos.list).
        calls += 2;
        if (result.error) {
          // Classify so we ban or invalidate appropriately and decide
          // whether to requeue.
          const msg = result.error;
          const is429   = /429|RESOURCE_EXHAUSTED|quota/i.test(msg);
          const is403   = /403/.test(msg);
          const is400   = /\b400\b/.test(msg);
          const isProxy = /curl exit|proxy|Tunnel|Connection/i.test(msg);
          const is5xx   = /\b5\d\d\b/.test(msg);

          if (is403 && /denied|disabled/i.test(msg)) {
            invalidateYtKey(pair.key, msg.slice(0, 80)).catch(() => {});
          } else if (is429 || is403) {
            banYtKey(pair.key);
          }

          retryable = is429 || is403 || is5xx || isProxy || msg.includes('subprocess failed');
          if (!retryable) {
            // Persist the error on the channel row so the operator can
            // see why it didn't enrich (matches old behavior).
            await pool.query(
              `UPDATE niche_spy_channels SET error_message = $1 WHERE channel_id = $2`,
              [msg.slice(0, 500), item.channel.channel_id],
            ).catch(() => {});
          }

          if (!is400 && (is429 || is403)) {
            // No-op: ban already applied above.
          }
          if (!retryable) {
            console.warn(`[outlier-enrich] non-retryable err on ${item.channel.channel_id}: ${msg.slice(0, 120)}`);
          }
        } else {
          succeeded = true;
          await pool.query(
            `UPDATE niche_spy_channels SET
               recent_videos_avg_views      = $1,
               recent_videos_median_views   = $2,
               recent_videos_max_views      = $3,
               recent_videos_count          = $4,
               last_recent_videos_fetched_at = NOW(),
               error_message                 = NULL
             WHERE channel_id = $5`,
            [result.avgViews, result.medianViews, result.maxViews, result.count, item.channel.channel_id],
          );
          if ((result.count || 0) > 0) withStats++;
        }
      } catch (err) {
        // Hard throw — proxy timeout, JSON parse, etc. Always retryable.
        retryable = true;
        console.warn(`[outlier-enrich] thread threw on ${item.channel.channel_id}:`, err instanceof Error ? err.message : err);
      }

      if (succeeded) {
        processed++;
      } else if (retryable && item.attempts + 1 < MAX_ATTEMPTS) {
        queue.push({ channel: item.channel, attempts: item.attempts + 1 });
      } else {
        errors++;
        processed++;
      }
      emit();
    }
  }

  await Promise.all(Array.from({ length: threadCount }, () => worker()));

  if (cancelled) {
    if (opts.jobId) await markJobCancelled(opts.jobId, total, processed, withStats, errors, calls);
    return { ok: true, total, processed, withStats, errors, calls, cancelled: true };
  }
  if (opts.jobId) await markJobDone(opts.jobId, total, processed, withStats, errors, calls);
  return { ok: true, total, processed, withStats, errors, calls };
}

async function persistProgress(
  jobId: number, total: number, processed: number, withStats: number, errors: number, calls: number,
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE outlier_enrich_jobs
        SET target_channels = $1,
            processed = $2,
            with_stats = $3,
            errors = $4,
            api_calls = $5,
            last_progress_at = NOW()
      WHERE id = $6 AND status = 'running'`,
    [total, processed, withStats, errors, calls, jobId],
  );
}

async function markJobDone(
  jobId: number, total: number, processed: number, withStats: number, errors: number, calls: number,
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE outlier_enrich_jobs
        SET status = 'done',
            target_channels = $1,
            processed = $2,
            with_stats = $3,
            errors = $4,
            api_calls = $5,
            completed_at = NOW(),
            last_progress_at = NOW()
      WHERE id = $6 AND status = 'running'`,
    [total, processed, withStats, errors, calls, jobId],
  );
}

async function markJobCancelled(
  jobId: number, total: number, processed: number, withStats: number, errors: number, calls: number,
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE outlier_enrich_jobs
        SET target_channels = $1,
            processed = $2,
            with_stats = $3,
            errors = $4,
            api_calls = $5,
            completed_at = NOW(),
            last_progress_at = NOW()
      WHERE id = $6`,
    [total, processed, withStats, errors, calls, jobId],
  );
}
