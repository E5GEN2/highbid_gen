import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getYtPairForThread, banYtKey } from '@/lib/yt-keys';
import { fetchChannelRecentUploads } from '@/lib/yt-recent-uploads';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/admin/outliers/enrich-channels
 *
 * Walks each channel's OWN recent uploads via YouTube Data API and stores
 * unbiased view stats on niche_spy_channels. This fixes the core bias in
 * the peer-outlier score: right now avg_views is computed over whatever
 * videos xgodo happened to scrape, which skews toward viral niche hits.
 *
 * Pulls channels where last_recent_videos_fetched_at is null OR older than
 * staleDays days. Processes in parallel threads pinned to YT key-proxy
 * pairs (same pattern as the bulk enrich route).
 *
 * Body (optional):
 *   { limit?: number, threads?: number, maxVideos?: number, staleDays?: number, force?: boolean }
 *     limit      = max channels to process this call (default 100; capped at 500)
 *     threads    = parallel workers (default 2, capped at number of keys)
 *     maxVideos  = recent uploads to sample per channel (default 30, max 50)
 *     staleDays  = skip channels fetched within this window (default 7)
 *     force      = refetch everything regardless of freshness
 */
export async function POST(req: NextRequest) {
  const pool = await getPool();
  const body = await req.json().catch(() => ({})) as {
    limit?: number; threads?: number; maxVideos?: number; staleDays?: number; force?: boolean;
  };

  const limit     = Math.min(Math.max(parseInt(String(body.limit     ?? 100)), 1), 500);
  const threads   = Math.min(Math.max(parseInt(String(body.threads   ?? 2)),   1), 8);
  const maxVideos = Math.min(Math.max(parseInt(String(body.maxVideos ?? 30)),  5), 50);
  const staleDays = Math.max(parseInt(String(body.staleDays ?? 7)), 0);
  const force     = !!body.force;

  const staleCondition = force
    ? ''
    : `AND (last_recent_videos_fetched_at IS NULL
           OR last_recent_videos_fetched_at < NOW() - INTERVAL '${staleDays} days')`;

  // Pick channels needing refresh. Only channels with an uploads_playlist_id
  // can be walked — that column is populated by the bulk enrich route's
  // Phase 2 (channels.list contentDetails).
  const dueRes = await pool.query<{ channel_id: string; uploads_playlist_id: string }>(
    `SELECT channel_id, uploads_playlist_id
     FROM niche_spy_channels
     WHERE uploads_playlist_id IS NOT NULL
       ${staleCondition}
     ORDER BY last_recent_videos_fetched_at ASC NULLS FIRST
     LIMIT $1`,
    [limit]
  );

  const startedAt = Date.now();
  let processed = 0, withStats = 0, errors = 0;

  // Simple round-robin across parallel threads. Each thread gets its own
  // key-proxy pair so we don't hammer a single key with N concurrent calls.
  async function worker(threadIdx: number, rows: typeof dueRes.rows) {
    for (const row of rows) {
      processed++;
      try {
        const pair = await getYtPairForThread(threadIdx);
        if (!pair) { errors++; continue; }
        const result = await fetchChannelRecentUploads(row.uploads_playlist_id, pair, { maxVideos });
        if (result.error) {
          // 429 / 403 => ban and move on; the next tick will retry via a
          // different pair since `last_recent_videos_fetched_at` isn't bumped.
          const isRateLimited = /429|403|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(result.error);
          if (isRateLimited) banYtKey(pair.key);
          errors++;
          await pool.query(
            `UPDATE niche_spy_channels
             SET error_message = $1
             WHERE channel_id = $2`,
            [result.error, row.channel_id]
          );
          continue;
        }
        await pool.query(
          `UPDATE niche_spy_channels SET
             recent_videos_avg_views      = $1,
             recent_videos_median_views   = $2,
             recent_videos_max_views      = $3,
             recent_videos_count          = $4,
             last_recent_videos_fetched_at = NOW(),
             error_message                 = NULL
           WHERE channel_id = $5`,
          [result.avgViews, result.medianViews, result.maxViews, result.count, row.channel_id]
        );
        if (result.count > 0) withStats++;
      } catch (err) {
        errors++;
        console.warn('[outliers/enrich-channels] worker err:', err instanceof Error ? err.message : err);
      }
    }
  }

  // Split rows across threads evenly. Each thread processes its slice
  // sequentially; threads run in parallel.
  const slices: (typeof dueRes.rows)[] = Array.from({ length: threads }, () => []);
  dueRes.rows.forEach((r, i) => slices[i % threads].push(r));
  await Promise.all(slices.map((rows, i) => worker(i, rows)));

  return NextResponse.json({
    ok: true,
    processed,
    withStats,
    errors,
    durationMs: Date.now() - startedAt,
  });
}

/**
 * GET returns a summary: how many channels have/need enrichment, so the UI
 * can show a progress stat without triggering work.
 */
export async function GET() {
  const pool = await getPool();
  const res = await pool.query<{ total: string; enriched: string; stale: string; pending: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE uploads_playlist_id IS NOT NULL) AS total,
      COUNT(*) FILTER (WHERE recent_videos_count IS NOT NULL AND recent_videos_count > 0) AS enriched,
      COUNT(*) FILTER (WHERE last_recent_videos_fetched_at IS NOT NULL
                        AND last_recent_videos_fetched_at < NOW() - INTERVAL '7 days') AS stale,
      COUNT(*) FILTER (WHERE uploads_playlist_id IS NOT NULL
                        AND last_recent_videos_fetched_at IS NULL) AS pending
    FROM niche_spy_channels
  `);
  const r = res.rows[0];
  return NextResponse.json({
    total:    parseInt(r.total    || '0'),
    enriched: parseInt(r.enriched || '0'),
    stale:    parseInt(r.stale    || '0'),
    pending:  parseInt(r.pending  || '0'),
  });
}
