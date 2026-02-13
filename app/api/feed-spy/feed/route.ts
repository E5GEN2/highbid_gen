import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  try {
    const pool = await getPool();
    const searchParams = req.nextUrl.searchParams;
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const offset = parseInt(searchParams.get('offset') || '0');

    // Filter params
    const maxAgeDays = parseInt(searchParams.get('maxAge') || '0');   // 0 = no limit
    const minSubs = parseInt(searchParams.get('minSubs') || '0');
    const maxSubs = parseInt(searchParams.get('maxSubs') || '0');     // 0 = no limit
    const minViews = parseInt(searchParams.get('minViews') || '0');
    const sort = searchParams.get('sort') || 'velocity';              // velocity | views | newest | subs

    // Build WHERE clauses
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;

    if (maxAgeDays > 0) {
      conditions.push(`c.channel_creation_date > NOW() - INTERVAL '${maxAgeDays} days'`);
    }
    if (minSubs > 0) {
      conditions.push(`c.subscriber_count >= $${paramIdx}`);
      params.push(minSubs);
      paramIdx++;
    }
    if (maxSubs > 0) {
      conditions.push(`c.subscriber_count <= $${paramIdx}`);
      params.push(maxSubs);
      paramIdx++;
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    // Build HAVING clause for min views (aggregate filter)
    const havingClause = minViews > 0
      ? `HAVING MAX(v.view_count) >= ${parseInt(String(minViews))}`
      : '';

    // Sort order
    let orderBy: string;
    switch (sort) {
      case 'views':
        orderBy = 'SUM(v.view_count) DESC NULLS LAST';
        break;
      case 'newest':
        orderBy = 'c.channel_creation_date DESC NULLS LAST';
        break;
      case 'subs':
        orderBy = 'c.subscriber_count DESC NULLS LAST';
        break;
      default: // velocity
        orderBy = `SUM(v.view_count) / GREATEST(EXTRACT(EPOCH FROM (NOW() - c.channel_creation_date)) / 86400, 1) DESC NULLS LAST`;
        break;
    }

    const limitIdx = paramIdx;
    const offsetIdx = paramIdx + 1;
    params.push(limit, offset);

    // Count params are the same minus limit/offset
    const countParams = params.slice(0, -2);

    const [result, countResult] = await Promise.all([
      pool.query(`
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
        ${whereClause}
        GROUP BY c.channel_id, c.channel_name, c.channel_url, c.avatar_url,
                 c.subscriber_count, c.total_video_count, c.channel_creation_date,
                 c.first_seen_at, c.sighting_count
        ${havingClause}
        ORDER BY ${orderBy}
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `, params),
      pool.query(`
        SELECT COUNT(*) AS total FROM (
          SELECT c.channel_id
          FROM shorts_channels c
          JOIN (
            SELECT DISTINCT ON (video_id) *
            FROM shorts_videos
            ORDER BY video_id, collected_at DESC
          ) v ON v.channel_id = c.channel_id
          ${whereClause}
          GROUP BY c.channel_id
          ${havingClause}
        ) sub
      `, countParams),
    ]);

    const totalChannels = parseInt(countResult.rows[0].total);

    // If user is logged in, count how many matching channels they haven't seen
    let unseenChannels: number | null = null;
    try {
      const session = await auth();
      if (session?.user?.id) {
        const unseenResult = await pool.query(`
          SELECT COUNT(*) AS unseen FROM (
            SELECT c.channel_id
            FROM shorts_channels c
            JOIN (
              SELECT DISTINCT ON (video_id) *
              FROM shorts_videos
              ORDER BY video_id, collected_at DESC
            ) v ON v.channel_id = c.channel_id
            LEFT JOIN user_seen_channels s ON s.channel_id = c.channel_id AND s.user_id = $${countParams.length + 1}
            ${whereClause ? whereClause + ' AND s.channel_id IS NULL' : 'WHERE s.channel_id IS NULL'}
            GROUP BY c.channel_id
            ${havingClause}
          ) sub
        `, [...countParams, session.user.id]);
        unseenChannels = parseInt(unseenResult.rows[0].unseen);
      }
    } catch {}

    return NextResponse.json({
      success: true,
      channels: result.rows,
      totalChannels,
      unseenChannels,
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
