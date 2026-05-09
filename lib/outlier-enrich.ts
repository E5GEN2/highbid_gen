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
import { fetchChannelRecentUploads, type RecentUploadVideo } from './yt-recent-uploads';

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

/**
 * Run a single pass — picks up to `limit` pending channels and walks
 * them. The exported `runOutlierEnrich` wraps this in an optional
 * indefinite outer loop.
 */
async function runOutlierEnrichOnce(opts: {
  limit?: number;
  threads?: number;
  maxVideos?: number;
  staleDays?: number;
  force?: boolean;
  jobId?: number;
  onProgress?: (p: OutlierEnrichProgress) => void;
  /** Counters carry across passes when running in indefinite mode so
   *  the persisted job row reflects cumulative work rather than
   *  resetting every loop. */
  cumulative?: { processed: number; withStats: number; errors: number; calls: number };
}): Promise<OutlierEnrichProgress & { ok: true; cancelled?: boolean; touchedAny: boolean }> {
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

  // Per-pass counters. When the caller is the indefinite-mode loop,
  // it passes a `cumulative` accumulator we add into so the persisted
  // job row reflects total work across passes — and emits the
  // running totals so the agent endpoint shows monotonically-growing
  // numbers.
  let processed = 0, withStats = 0, errors = 0, calls = 0;
  let cancelled = false;

  const emit = () => {
    const cumP = (opts.cumulative?.processed  ?? 0) + processed;
    const cumS = (opts.cumulative?.withStats  ?? 0) + withStats;
    const cumE = (opts.cumulative?.errors     ?? 0) + errors;
    const cumC = (opts.cumulative?.calls      ?? 0) + calls;
    // For UI: when in a single-pass run, total == this pass's queue size.
    // In indef mode the wrapper recomputes the agent-visible totals.
    const p: OutlierEnrichProgress = { total, processed: cumP, withStats: cumS, errors: cumE, calls: cumC };
    opts.onProgress?.(p);
    if (opts.jobId) {
      persistProgress(opts.jobId, total, cumP, cumS, cumE, cumC).catch(() => {});
    }
  };
  emit();

  if (total === 0) {
    return { ok: true, total, processed, withStats, errors, calls, touchedAny: false };
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

          // Persist the recent uploads themselves into niche_spy_videos.
          // Without this step the channel cards on /niche/channels can
          // only show videos that came in via the keyword scrape — most
          // channels end up with 0–1 thumbs in the strip even though
          // the aggregate stats look great. We upsert ON CONFLICT
          // (url) so existing rows aren't clobbered (preserves their
          // keyword tag, embeddings, etc.). channel_name is sourced
          // from the videos.list response when present, else falls
          // back to the channels table.
          await upsertRecentVideos(pool, item.channel.channel_id, result.videos);
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

  return { ok: true, total, processed, withStats, errors, calls, cancelled, touchedAny: total > 0 };
}

/**
 * Public worker entrypoint. By default runs a single pass. Pass
 * `indefinite: true` to keep re-fetching the pending queue and
 * processing batches until cancelled or no more work is found for
 * an idle window. Job row's `loops` counter ticks per pass.
 */
export async function runOutlierEnrich(opts: {
  limit?: number;
  threads?: number;
  maxVideos?: number;
  staleDays?: number;
  force?: boolean;
  jobId?: number;
  onProgress?: (p: OutlierEnrichProgress) => void;
  /** Loop until the pending queue is empty for `idleSecondsBeforeStop`
   *  consecutive seconds OR the job row is flipped to 'cancelled'. */
  indefinite?: boolean;
  /** How long to wait when a pass returns 0 channels before doing
   *  one more probe pass. Default 60s — long enough for a fresh
   *  batch of channels to drift into staleness, short enough that a
   *  cancel takes effect quickly. */
  idleSecondsBeforeStop?: number;
}): Promise<OutlierEnrichProgress & { ok: true; cancelled?: boolean; loops: number }> {
  const cumulative = { processed: 0, withStats: 0, errors: 0, calls: 0 };
  let loops = 0;
  let lastTotal = 0;
  const idleSecs = Math.max(10, opts.idleSecondsBeforeStop ?? 60);
  // Track the last "saw work" moment so we can stop when the queue
  // has been empty for a sustained idle window.
  let lastSawWorkAt = Date.now();

  while (true) {
    const pass = await runOutlierEnrichOnce({
      limit: opts.limit,
      threads: opts.threads,
      maxVideos: opts.maxVideos,
      staleDays: opts.staleDays,
      force: opts.force,
      jobId: opts.jobId,
      onProgress: opts.onProgress,
      cumulative,
    });
    loops++;
    cumulative.processed  += pass.processed;
    cumulative.withStats  += pass.withStats;
    cumulative.errors     += pass.errors;
    cumulative.calls      += pass.calls;
    lastTotal = pass.total;
    if (pass.total > 0) lastSawWorkAt = Date.now();
    if (opts.jobId) await persistLoopCount(opts.jobId, loops);

    if (pass.cancelled) {
      if (opts.jobId) await markJobCancelled(
        opts.jobId, lastTotal, cumulative.processed, cumulative.withStats, cumulative.errors, cumulative.calls,
      );
      return { ok: true, total: lastTotal, ...cumulative, cancelled: true, loops };
    }

    if (!opts.indefinite) break;

    // In indef mode: if the pass found nothing AND we've been idle
    // for the configured window, stop. Otherwise wait briefly and
    // probe again — channels can drift into staleness.
    if (pass.total === 0) {
      const idleMs = Date.now() - lastSawWorkAt;
      if (idleMs >= idleSecs * 1000) break;
      // Sleep then probe again. Re-check cancel status via the next
      // pass's isCancelled — a 5s sleep is short enough that a
      // cancel takes effect quickly.
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (opts.jobId) await markJobDone(
    opts.jobId, lastTotal, cumulative.processed, cumulative.withStats, cumulative.errors, cumulative.calls,
  );
  return { ok: true, total: lastTotal, ...cumulative, loops };
}

async function persistLoopCount(jobId: number, loops: number): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE outlier_enrich_jobs SET loops = $1, last_progress_at = NOW() WHERE id = $2`,
    [loops, jobId],
  ).catch(() => {});
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

/**
 * Upsert a batch of recent uploads into niche_spy_videos. Pulled
 * during the Outlier Pipeline so every enriched channel ends up with
 * its own videos in the DB — without this the channel cards on
 * /niche/channels could only render videos that came in via the
 * keyword scrape (most channels had 0–1).
 *
 * Uses ON CONFLICT (url) DO UPDATE so a video that already exists
 * (e.g. originally scraped via a keyword) keeps its keyword tag +
 * embedding fields, but gets fresh view/like/comment counts. New
 * videos land with NULL keyword/score (they're not from a keyword
 * scrape) and get marked as enriched right away.
 *
 * channel_name is read from the channels row so the row matches the
 * grouping key used by /api/niche-spy/channels.
 */
async function upsertRecentVideos(
  pool: import('pg').Pool,
  channelId: string,
  videos: RecentUploadVideo[],
): Promise<void> {
  if (videos.length === 0) return;

  // Pull the channel's display info once so all the rows we insert
  // share the same channel_name + avatar (the channels.list pass that
  // populated niche_spy_channels already has these).
  const chRes = await pool.query<{ channel_name: string | null; channel_avatar: string | null; channel_created_at: Date | null }>(
    `SELECT channel_name, channel_avatar, channel_created_at FROM niche_spy_channels WHERE channel_id = $1 LIMIT 1`,
    [channelId],
  );
  const channelName  = chRes.rows[0]?.channel_name  ?? null;
  const channelAvatar = chRes.rows[0]?.channel_avatar ?? null;
  const channelCreatedAt = chRes.rows[0]?.channel_created_at ?? null;

  // Single multi-row INSERT keeps this to one round trip per channel
  // instead of N. ~10 videos × 12 cols = 120 params, well under
  // pg's 65535 cap.
  const cols = 13;
  const placeholders: string[] = [];
  const params: (string | number | Date | null)[] = [];
  let idx = 0;
  for (const v of videos) {
    const url = `https://youtu.be/${v.videoId}`;
    const postedAt = v.publishedAt ? new Date(v.publishedAt) : null;
    const row = [
      url,                                  // 1 url (unique conflict target)
      v.title,                              // 2 title
      v.thumbnail,                          // 3 thumbnail
      channelId,                            // 4 channel_id
      channelName,                          // 5 channel_name
      channelAvatar,                        // 6 channel_avatar
      channelCreatedAt,                     // 7 channel_created_at
      postedAt,                             // 8 posted_at
      v.viewCount,                          // 9 view_count
      v.likeCount,                          // 10 like_count
      v.commentCount,                       // 11 comment_count
      'outlier-enrich',                     // 12 task_id (provenance)
      new Date(),                           // 13 enriched_at
    ];
    placeholders.push(`(${row.map(() => `$${++idx}`).join(', ')})`);
    params.push(...row);
  }

  // Conflict target = url. On conflict, refresh the volatile fields
  // (views/likes/comments + thumbnail in case it changed) and mark
  // enriched_at, but DON'T overwrite keyword / score / posted_date /
  // top_comment because those came from richer scrape sources.
  await pool.query(
    `INSERT INTO niche_spy_videos
       (url, title, thumbnail, channel_id, channel_name, channel_avatar,
        channel_created_at, posted_at, view_count, like_count, comment_count,
        task_id, enriched_at)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (url) DO UPDATE SET
       view_count    = EXCLUDED.view_count,
       like_count    = EXCLUDED.like_count,
       comment_count = EXCLUDED.comment_count,
       thumbnail     = COALESCE(niche_spy_videos.thumbnail, EXCLUDED.thumbnail),
       channel_id    = COALESCE(niche_spy_videos.channel_id, EXCLUDED.channel_id),
       channel_name  = COALESCE(niche_spy_videos.channel_name, EXCLUDED.channel_name),
       channel_avatar = COALESCE(niche_spy_videos.channel_avatar, EXCLUDED.channel_avatar),
       enriched_at   = NOW()`,
    params,
  );
}
