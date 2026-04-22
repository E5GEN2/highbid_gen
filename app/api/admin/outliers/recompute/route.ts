import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/admin/outliers/recompute
 *
 * Recomputes the peer-outlier score for every enriched channel in
 * niche_spy_channels. Intended to be run nightly by a cron (or manually
 * triggered from the admin UI for testing).
 *
 * Algorithm (mirrors Nexlev's approach, per their niche-finder docs):
 *
 *   1. Bucket every channel by subscriber count into 6 log-ish tiers:
 *        0-1k, 1k-10k, 10k-50k, 50k-250k, 250k-1M, 1M+
 *      These are finer-grained than log-10 because a 15k and an 80k sub
 *      channel have very different economics.
 *
 *   2. For each channel, compute its *own* avg view count across its
 *      scraped videos (must have >=5 videos scraped for a stable average).
 *
 *   3. For each bucket, compute the median of (step 2) across all channels
 *      in that bucket. This gives us "what does a typical channel at this
 *      size get per video?"
 *
 *   4. peer_outlier_score = channel.avg_views / bucket.median_avg_views
 *      A score of 5.0 = "this channel pulls 5x the views of a median
 *      channel at its subscriber tier" -> classic breakout signal.
 *
 * Everything runs in a single CTE-based UPDATE so it's atomic and the
 * whole table is consistent when we SELECT from the outliers page.
 */
async function recompute() {
  const pool = await getPool();
  const startedAt = Date.now();

  // Single statement: compute bucket medians and write back the score.
  //
  // The avg_views we use for scoring comes from one of two sources, in order
  // of preference:
  //   1. c.recent_videos_avg_views — unbiased sample pulled via
  //      playlistItems.list over the channel's last 30 uploads, populated by
  //      /api/admin/outliers/enrich-channels. This is the correct metric;
  //      it reflects the channel's actual typical performance.
  //   2. AVG(v.view_count) over niche_spy_videos — biased toward whatever
  //      xgodo scraped (usually viral niche hits), but it's what we have
  //      until enrichment catches up.
  //
  // Using COALESCE means enriched channels get an accurate score
  // immediately; unenriched channels get a rough score that will tighten
  // up once enrichment is run.
  const result = await pool.query(`
    WITH channel_stats AS (
      SELECT
        c.channel_id,
        c.subscriber_count,
        COALESCE(
          NULLIF(c.recent_videos_avg_views, 0)::float,
          AVG(v.view_count)::float
        ) AS avg_views,
        (c.recent_videos_avg_views IS NOT NULL
         AND c.recent_videos_avg_views > 0) AS is_unbiased,
        CASE
          WHEN c.subscriber_count IS NULL             THEN NULL
          WHEN c.subscriber_count < 1000              THEN '0-1k'
          WHEN c.subscriber_count < 10000             THEN '1k-10k'
          WHEN c.subscriber_count < 50000             THEN '10k-50k'
          WHEN c.subscriber_count < 250000            THEN '50k-250k'
          WHEN c.subscriber_count < 1000000           THEN '250k-1M'
          ELSE                                             '1M+'
        END AS bucket
      FROM niche_spy_channels c
      JOIN niche_spy_videos v ON v.channel_id = c.channel_id
      WHERE c.subscriber_count IS NOT NULL
      GROUP BY c.channel_id, c.subscriber_count, c.recent_videos_avg_views
      HAVING (c.recent_videos_avg_views IS NOT NULL AND c.recent_videos_avg_views > 0)
          OR (COUNT(v.id) >= 5 AND AVG(v.view_count) > 0)
    ),
    bucket_medians AS (
      SELECT
        bucket,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY avg_views) AS median_avg_views,
        COUNT(*) AS bucket_size
      FROM channel_stats
      GROUP BY bucket
    ),
    scored AS (
      SELECT
        cs.channel_id,
        cs.bucket,
        CASE
          WHEN bm.median_avg_views > 0 AND bm.bucket_size >= 3
          THEN cs.avg_views / bm.median_avg_views
          ELSE NULL
        END AS score
      FROM channel_stats cs
      LEFT JOIN bucket_medians bm ON bm.bucket = cs.bucket
    )
    UPDATE niche_spy_channels c
    SET peer_outlier_score      = s.score,
        peer_outlier_bucket     = s.bucket,
        peer_outlier_updated_at = NOW()
    FROM scored s
    WHERE c.channel_id = s.channel_id
    RETURNING c.channel_id
  `);

  // Per-bucket sample summary for the admin UI — helpful to see whether a
  // bucket has enough channels to produce meaningful medians.
  const bucketStats = await pool.query<{ bucket: string; n: number; median_score: number | null; max_score: number | null }>(`
    SELECT
      peer_outlier_bucket AS bucket,
      COUNT(*)::int AS n,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY peer_outlier_score) AS median_score,
      MAX(peer_outlier_score) AS max_score
    FROM niche_spy_channels
    WHERE peer_outlier_score IS NOT NULL
    GROUP BY peer_outlier_bucket
    ORDER BY
      CASE peer_outlier_bucket
        WHEN '0-1k' THEN 1 WHEN '1k-10k' THEN 2 WHEN '10k-50k' THEN 3
        WHEN '50k-250k' THEN 4 WHEN '250k-1M' THEN 5 WHEN '1M+' THEN 6
        ELSE 99 END
  `);

  return {
    ok: true,
    channelsScored: result.rowCount || 0,
    durationMs: Date.now() - startedAt,
    buckets: bucketStats.rows.map(r => ({
      bucket: r.bucket,
      n: r.n,
      medianScore: r.median_score,
      maxScore: r.max_score,
    })),
  };
}

export async function POST() {
  try {
    const result = await recompute();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}

// GET works too — lets you trigger it from a browser / cron with a simple curl.
export async function GET() {
  try {
    const result = await recompute();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
