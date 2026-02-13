import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';
import { classifyNiche } from '../../../../lib/niches';

export async function GET(req: NextRequest) {
  // Auth check
  const token = req.cookies.get('admin_token')?.value;
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    if (!decoded.startsWith('admin:') || !decoded.endsWith(':rofe_admin_secret')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const pool = await getPool();
    const dateParam = req.nextUrl.searchParams.get('date');
    const date = dateParam || new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Query channels first seen on the given date, with their latest video data
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
      WHERE c.first_seen_at::date = $1::date
      GROUP BY c.channel_id, c.channel_name, c.channel_url, c.avatar_url,
               c.subscriber_count, c.total_video_count, c.channel_creation_date,
               c.first_seen_at, c.sighting_count
      ORDER BY SUM(v.view_count) / GREATEST(EXTRACT(EPOCH FROM (NOW() - c.channel_creation_date)) / 86400, 1) DESC NULLS LAST
    `, [date]);

    // Classify niches and compute stats
    const channels = result.rows.map((ch) => {
      const titles = (ch.videos || []).map((v: { title: string }) => v.title || '');
      const niche = classifyNiche(titles, ch.channel_name || '');
      const ageDays = ch.channel_creation_date
        ? Math.max(1, Math.round((Date.now() - new Date(ch.channel_creation_date).getTime()) / 86400000))
        : null;
      const totalViews = (ch.videos || []).reduce((sum: number, v: { view_count: number }) => sum + (Number(v.view_count) || 0), 0);
      return {
        ...ch,
        subscriber_count: ch.subscriber_count ? Number(ch.subscriber_count) : null,
        total_video_count: ch.total_video_count ? Number(ch.total_video_count) : null,
        niche,
        age_days: ageDays,
        total_views: totalViews,
        velocity: ageDays ? Math.round(totalViews / ageDays) : 0,
      };
    });

    // Aggregate stats
    const totalViews = channels.reduce((sum, ch) => sum + ch.total_views, 0);
    const avgAgeDays = channels.length > 0
      ? Math.round(channels.reduce((sum, ch) => sum + (ch.age_days || 0), 0) / channels.length)
      : 0;

    // Top niche
    const nicheCounts: Record<string, number> = {};
    for (const ch of channels) {
      nicheCounts[ch.niche] = (nicheCounts[ch.niche] || 0) + 1;
    }
    const topNiche = Object.entries(nicheCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'General';

    return NextResponse.json({
      channels,
      stats: {
        totalChannels: channels.length,
        totalViews,
        avgAgeDays,
        topNiche,
      },
    });
  } catch (error) {
    console.error('X-posts API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Query failed' },
      { status: 500 }
    );
  }
}
