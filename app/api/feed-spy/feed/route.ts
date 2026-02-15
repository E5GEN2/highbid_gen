import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

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
    const userId = searchParams.get('userId');

    // For logged-in users, add LEFT JOIN + filter to exclude already-seen channels
    let seenJoin = '';
    if (userId) {
      conditions.push(`seen.channel_id IS NULL`);
      seenJoin = `LEFT JOIN user_seen_channels seen ON seen.channel_id = c.channel_id AND seen.user_id = $${paramIdx}`;
      params.push(userId);
      paramIdx++;
    }

    const whereClauseFinal = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

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
        // Blended ranking: velocity + freshness bonus.
        //
        // Problem: a 90-day channel with 19M views (211K/day velocity) permanently
        // outranks everything. Users see the same channels every visit = stale feed.
        //
        // Fix: add a large freshness bonus that decays from 10M to 0 over 3 days
        // since first_seen_at. This guarantees any channel discovered in the last
        // ~24-48h ranks above even the highest-velocity channels, then gradually
        // settles to its natural velocity position. Within the same freshness tier,
        // velocity still determines ordering.
        orderBy = `(
          SUM(v.view_count) / GREATEST(EXTRACT(EPOCH FROM (NOW() - c.channel_creation_date)) / 86400, 1)
          + GREATEST(1.0 - EXTRACT(EPOCH FROM (NOW() - c.first_seen_at)) / (3 * 86400), 0) * 10000000
        ) DESC NULLS LAST`;
        break;
    }

    const limitIdx = paramIdx;
    const offsetIdx = paramIdx + 1;
    params.push(limit, offset);

    // Count params are the same minus limit/offset
    const countParams = params.slice(0, -2);

    const [result, countResult, totalResult] = await Promise.all([
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
        ${seenJoin}
        ${whereClauseFinal}
        GROUP BY c.channel_id, c.channel_name, c.channel_url, c.avatar_url,
                 c.subscriber_count, c.total_video_count, c.channel_creation_date,
                 c.first_seen_at, c.sighting_count
        ${havingClause}
        ORDER BY ${orderBy}
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `, params),
      // Count of unseen channels (same filters including seen exclusion)
      pool.query(`
        SELECT COUNT(*) AS total FROM (
          SELECT c.channel_id
          FROM shorts_channels c
          JOIN (
            SELECT DISTINCT ON (video_id) *
            FROM shorts_videos
            ORDER BY video_id, collected_at DESC
          ) v ON v.channel_id = c.channel_id
          ${seenJoin}
          ${whereClauseFinal}
          GROUP BY c.channel_id
          ${havingClause}
        ) sub
      `, countParams),
      // Total channels matching filters (regardless of seen status)
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
      `, (() => {
        // totalResult uses original whereClause (no seen filter, no userId param)
        // Build params: only the filter params (minSubs, maxSubs) without userId and limit/offset
        const totalParams: (string | number)[] = [];
        if (minSubs > 0) totalParams.push(minSubs);
        if (maxSubs > 0) totalParams.push(maxSubs);
        return totalParams;
      })()),
    ]);

    const unseenChannels = userId ? parseInt(countResult.rows[0].total) : null;
    const totalChannels = parseInt(totalResult.rows[0].total);

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
