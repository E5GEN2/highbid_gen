import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';
import { classifyNiche } from '../../../../lib/niches';

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get('admin_token')?.value;
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    return decoded.startsWith('admin:') && decoded.endsWith(':rofe_admin_secret');
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const pool = await getPool();
    const searchParams = req.nextUrl.searchParams;
    const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
    const maxAgeDays = parseInt(searchParams.get('maxAge') || '90');
    const minSubs = parseInt(searchParams.get('minSubs') || '10000');
    const maxSubs = parseInt(searchParams.get('maxSubs') || '0');
    const minViews = parseInt(searchParams.get('minViews') || '0');
    const includePosted = searchParams.get('includePosted') === 'true';

    // Build WHERE conditions
    const conditions: string[] = ['c.first_seen_at::date = $1::date'];
    const params: (string | number)[] = [date];
    let paramIdx = 2;

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

    // Exclude already-posted channels by default
    if (!includePosted) {
      conditions.push('xp.channel_id IS NULL');
    }

    const havingClause = minViews > 0
      ? `HAVING MAX(v.view_count) >= ${parseInt(String(minViews))}`
      : '';

    const whereClause = conditions.join(' AND ');

    // Query channels first seen on the given date, with their latest video data
    const result = await pool.query(`
      SELECT
        c.channel_id, c.channel_name, c.channel_url, c.avatar_url,
        c.subscriber_count, c.total_video_count, c.channel_creation_date,
        c.first_seen_at, c.sighting_count,
        xp.posted_at, xp.post_type,
        CASE WHEN xp.channel_id IS NOT NULL THEN true ELSE false END AS is_posted,
        ca.niche AS ai_niche, ca.sub_niche AS ai_sub_niche,
        ca.content_style, ca.channel_summary,
        ca.tags AS ai_tags, ca.status AS analysis_status,
        ca.error_message AS analysis_error,
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
      LEFT JOIN x_posted_channels xp ON xp.channel_id = c.channel_id
      LEFT JOIN channel_analysis ca ON ca.channel_id = c.channel_id
      WHERE ${whereClause}
      GROUP BY c.channel_id, c.channel_name, c.channel_url, c.avatar_url,
               c.subscriber_count, c.total_video_count, c.channel_creation_date,
               c.first_seen_at, c.sighting_count, xp.channel_id, xp.posted_at, xp.post_type,
               ca.niche, ca.sub_niche, ca.content_style,
               ca.channel_summary, ca.tags, ca.status, ca.error_message
      ${havingClause}
      ORDER BY SUM(v.view_count) / GREATEST(EXTRACT(EPOCH FROM (NOW() - c.channel_creation_date)) / 86400, 1) DESC NULLS LAST
    `, params);

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
        is_posted: ch.is_posted,
        posted_at: ch.posted_at || null,
        post_type: ch.post_type || null,
        niche: ch.ai_niche || niche,
        ai_niche: ch.ai_niche || null,
        ai_sub_niche: ch.ai_sub_niche || null,
        content_style: ch.content_style || null,
        channel_summary: ch.channel_summary || null,
        ai_tags: ch.ai_tags || null,
        analysis_status: ch.analysis_status || null,
        analysis_error: ch.analysis_error || null,
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

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const pool = await getPool();
    const { channelIds, postType } = await req.json();

    if (!Array.isArray(channelIds) || channelIds.length === 0) {
      return NextResponse.json({ error: 'channelIds array required' }, { status: 400 });
    }

    // Build a multi-row INSERT with ON CONFLICT DO NOTHING
    const values: string[] = [];
    const params: string[] = [];
    let paramIdx = 1;
    for (const id of channelIds) {
      values.push(`($${paramIdx}, $${paramIdx + 1})`);
      params.push(id, postType || 'unknown');
      paramIdx += 2;
    }

    const result = await pool.query(
      `INSERT INTO x_posted_channels (channel_id, post_type) VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`,
      params
    );

    return NextResponse.json({ success: true, marked: result.rowCount || 0 });
  } catch (error) {
    console.error('X-posts POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to mark channels' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const pool = await getPool();
    const { channelId } = await req.json();

    if (!channelId || typeof channelId !== 'string') {
      return NextResponse.json({ error: 'channelId string required' }, { status: 400 });
    }

    await pool.query('DELETE FROM x_posted_channels WHERE channel_id = $1', [channelId]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('X-posts DELETE error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to unmark channel' },
      { status: 500 }
    );
  }
}
