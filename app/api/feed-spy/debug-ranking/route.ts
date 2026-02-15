import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

export async function GET(req: NextRequest) {
  try {
    const pool = await getPool();
    const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '30'), 100);

    const result = await pool.query(`
      SELECT
        c.channel_id,
        c.channel_name,
        c.subscriber_count,
        c.first_seen_at,
        c.channel_creation_date,
        EXTRACT(EPOCH FROM (NOW() - c.channel_creation_date)) / 86400 AS age_days,
        EXTRACT(EPOCH FROM (NOW() - c.first_seen_at)) / 3600 AS hours_since_discovered,
        SUM(v.view_count) AS total_video_views,
        SUM(v.view_count) / GREATEST(EXTRACT(EPOCH FROM (NOW() - c.channel_creation_date)) / 86400, 1) AS velocity,
        GREATEST(1.0 - EXTRACT(EPOCH FROM (NOW() - c.first_seen_at)) / (3 * 86400), 0) AS freshness_factor,
        GREATEST(1.0 - EXTRACT(EPOCH FROM (NOW() - c.first_seen_at)) / (3 * 86400), 0) * 10000000 AS freshness_bonus,
        ABS(hashtext(c.channel_id || CURRENT_DATE::text)) / 2147483647.0 AS daily_hash,
        0.5 + 0.5 * ABS(hashtext(c.channel_id || CURRENT_DATE::text)) / 2147483647.0 AS daily_multiplier,
        (SUM(v.view_count) / GREATEST(EXTRACT(EPOCH FROM (NOW() - c.channel_creation_date)) / 86400, 1))
          * (0.5 + 0.5 * ABS(hashtext(c.channel_id || CURRENT_DATE::text)) / 2147483647.0)
          + GREATEST(1.0 - EXTRACT(EPOCH FROM (NOW() - c.first_seen_at)) / (3 * 86400), 0) * 10000000
          AS final_score
      FROM shorts_channels c
      JOIN (
        SELECT DISTINCT ON (video_id) *
        FROM shorts_videos
        ORDER BY video_id, collected_at DESC
      ) v ON v.channel_id = c.channel_id
      GROUP BY c.channel_id, c.channel_name, c.subscriber_count,
               c.first_seen_at, c.channel_creation_date
      ORDER BY (
        (SUM(v.view_count) / GREATEST(EXTRACT(EPOCH FROM (NOW() - c.channel_creation_date)) / 86400, 1))
        * (0.5 + 0.5 * ABS(hashtext(c.channel_id || CURRENT_DATE::text)) / 2147483647.0)
        + GREATEST(1.0 - EXTRACT(EPOCH FROM (NOW() - c.first_seen_at)) / (3 * 86400), 0) * 10000000
      ) DESC NULLS LAST
      LIMIT $1
    `, [limit]);

    const channels = result.rows.map((r) => ({
      channel_id: r.channel_id,
      channel_name: r.channel_name,
      subscriber_count: Number(r.subscriber_count),
      first_seen_at: r.first_seen_at,
      channel_creation_date: r.channel_creation_date,
      age_days: Math.round(Number(r.age_days)),
      hours_since_discovered: Math.round(Number(r.hours_since_discovered) * 10) / 10,
      total_video_views: Number(r.total_video_views),
      velocity: Math.round(Number(r.velocity)),
      freshness_factor: Math.round(Number(r.freshness_factor) * 1000) / 1000,
      freshness_bonus: Math.round(Number(r.freshness_bonus)),
      daily_multiplier: Math.round(Number(r.daily_multiplier) * 1000) / 1000,
      final_score: Math.round(Number(r.final_score)),
    }));

    // Also show channels discovered today
    const todayResult = await pool.query(`
      SELECT channel_id, channel_name, first_seen_at, subscriber_count
      FROM shorts_channels
      WHERE first_seen_at > NOW() - INTERVAL '24 hours'
      ORDER BY first_seen_at DESC
    `);

    return NextResponse.json({
      ranking: channels,
      discovered_today: todayResult.rows.map(r => ({
        channel_id: r.channel_id,
        channel_name: r.channel_name,
        first_seen_at: r.first_seen_at,
        subscriber_count: Number(r.subscriber_count),
      })),
      discovered_today_count: todayResult.rows.length,
      now: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Debug ranking error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Query failed' },
      { status: 500 }
    );
  }
}
