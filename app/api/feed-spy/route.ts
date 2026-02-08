import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../lib/db';

export async function GET(req: NextRequest) {
  try {
    const pool = await getPool();
    const searchParams = req.nextUrl.searchParams;
    const sortBy = searchParams.get('sort') || 'view_count';
    const order = searchParams.get('order') || 'DESC';
    const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500);
    const offset = parseInt(searchParams.get('offset') || '0');
    const minViews = searchParams.get('minViews') || '0';
    const maxChannelAgeDays = searchParams.get('maxChannelAge'); // filter new channels

    const allowedSorts: Record<string, string> = {
      view_count: 'v.view_count',
      like_count: 'v.like_count',
      comment_count: 'v.comment_count',
      duration_seconds: 'v.duration_seconds',
      collected_at: 'v.collected_at',
      channel_age: 'c.channel_creation_date',
    };
    const sortCol = allowedSorts[sortBy] || 'v.view_count';
    const sortOrder = order === 'ASC' ? 'ASC' : 'DESC';
    const nullsPos = sortOrder === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';

    let whereClause = 'WHERE 1=1';
    const params: (string | number)[] = [];
    let paramIdx = 1;

    if (parseInt(minViews) > 0) {
      whereClause += ` AND v.view_count >= $${paramIdx}`;
      params.push(parseInt(minViews));
      paramIdx++;
    }

    if (maxChannelAgeDays) {
      whereClause += ` AND c.channel_creation_date >= NOW() - INTERVAL '${parseInt(maxChannelAgeDays)} days'`;
    }

    // Get videos with channel info — deduplicated by video_id (latest sighting)
    const videosResult = await pool.query(`
      SELECT DISTINCT ON (v.video_id)
        v.video_id, v.video_url, v.title, v.duration_seconds, v.upload_date,
        v.view_count, v.like_count, v.comment_count, v.collected_at,
        c.channel_id, c.channel_name, c.channel_url, c.channel_creation_date, c.sighting_count, c.avatar_url
      FROM shorts_videos v
      JOIN shorts_channels c ON v.channel_id = c.channel_id
      ${whereClause}
      ORDER BY v.video_id, v.collected_at DESC
    `, params);

    // Sort in JS since DISTINCT ON requires matching ORDER BY prefix
    const videos = videosResult.rows;
    videos.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const colMap: Record<string, string> = {
        'v.view_count': 'view_count',
        'v.like_count': 'like_count',
        'v.comment_count': 'comment_count',
        'v.duration_seconds': 'duration_seconds',
        'v.collected_at': 'collected_at',
        'c.channel_creation_date': 'channel_creation_date',
      };
      const key = colMap[sortCol] || 'view_count';
      const aVal = a[key] ?? (sortOrder === 'DESC' ? -Infinity : Infinity);
      const bVal = b[key] ?? (sortOrder === 'DESC' ? -Infinity : Infinity);
      if (sortOrder === 'DESC') return (bVal as number) > (aVal as number) ? 1 : -1;
      return (aVal as number) > (bVal as number) ? 1 : -1;
    });

    const paged = videos.slice(offset, offset + limit);

    // Stats
    const statsResult = await pool.query(`
      SELECT
        COUNT(DISTINCT v.video_id) as total_videos,
        COUNT(DISTINCT v.channel_id) as total_channels,
        COUNT(*) as total_sightings,
        (SELECT COUNT(*) FROM shorts_collections) as total_collections
      FROM shorts_videos v
    `);

    // Rising stars settings
    const rsMaxChannels = Math.min(parseInt(searchParams.get('rsMaxChannels') || '12'), 50);
    const rsMaxAgeDays = parseInt(searchParams.get('rsMaxAge') || '180');
    const rsMinViews = parseInt(searchParams.get('rsMinViews') || '0');

    let rsHaving = '';
    if (rsMinViews > 0) {
      rsHaving = `HAVING SUM(v.view_count) >= ${rsMinViews}`;
    }

    const risingResult = await pool.query(`
      SELECT
        c.channel_id, c.channel_name, c.channel_url, c.channel_creation_date, c.sighting_count, c.avatar_url,
        c.first_seen_at, c.last_seen_at,
        MAX(v.view_count) as max_views,
        COUNT(DISTINCT v.video_id) as video_count,
        SUM(v.view_count) as total_views
      FROM shorts_channels c
      JOIN shorts_videos v ON c.channel_id = v.channel_id
      WHERE c.channel_creation_date >= NOW() - INTERVAL '${rsMaxAgeDays} days'
        AND v.view_count IS NOT NULL
      GROUP BY c.channel_id, c.channel_name, c.channel_url, c.channel_creation_date, c.sighting_count, c.avatar_url, c.first_seen_at, c.last_seen_at
      ${rsHaving}
      ORDER BY total_views DESC
      LIMIT ${rsMaxChannels}
    `);

    return NextResponse.json({
      success: true,
      videos: paged,
      total: videos.length,
      stats: statsResult.rows[0],
      risingStars: risingResult.rows,
    });
  } catch (error) {
    console.error('Feed spy query error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Query failed' },
      { status: 500 }
    );
  }
}
