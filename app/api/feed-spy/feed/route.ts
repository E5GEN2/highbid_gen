import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

export async function GET(req: NextRequest) {
  try {
    const pool = await getPool();
    const searchParams = req.nextUrl.searchParams;
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const offset = parseInt(searchParams.get('offset') || '0');

    const result = await pool.query(`
      SELECT
        c.channel_id, c.channel_name, c.channel_url, c.avatar_url,
        c.subscriber_count, c.total_video_count, c.channel_creation_date,
        c.first_seen_at, c.sighting_count,
        json_agg(
          json_build_object(
            'video_id', v.video_id,
            'title', v.title,
            'duration_seconds', v.duration_seconds,
            'view_count', v.view_count,
            'like_count', v.like_count,
            'comment_count', v.comment_count,
            'upload_date', v.upload_date
          )
          ORDER BY v.view_count DESC NULLS LAST
        ) AS videos
      FROM shorts_channels c
      JOIN (
        SELECT DISTINCT ON (video_id) *
        FROM shorts_videos
        ORDER BY video_id, collected_at DESC
      ) v ON v.channel_id = c.channel_id
      GROUP BY c.channel_id, c.channel_name, c.channel_url, c.avatar_url,
               c.subscriber_count, c.total_video_count, c.channel_creation_date,
               c.first_seen_at, c.sighting_count
      ORDER BY SUM(v.view_count) DESC NULLS LAST
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    return NextResponse.json({
      success: true,
      channels: result.rows,
      hasMore: result.rows.length === limit,
    });
  } catch (error) {
    console.error('Feed query error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Query failed' },
      { status: 500 }
    );
  }
}
