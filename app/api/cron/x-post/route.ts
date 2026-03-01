import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';
import { classifyNiche } from '../../../../lib/niches';
import { getTwitterCredentials, createTwitterClient, postThread } from '../../../../lib/twitter';
import { generateLeaderboardThread, type ThreadChannel } from '../../../../lib/generateThread';

async function getConfig(pool: import('pg').Pool): Promise<Record<string, string>> {
  const result = await pool.query('SELECT key, value FROM admin_config');
  const config: Record<string, string> = {};
  for (const row of result.rows) config[row.key] = row.value;
  return config;
}

async function saveConfig(pool: import('pg').Pool, entries: Record<string, string>) {
  for (const [key, value] of Object.entries(entries)) {
    await pool.query(
      `INSERT INTO admin_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const pool = await getPool();
    const config = await getConfig(pool);

    // Auth: Bearer token must match cron_secret
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cronSecret = config.cron_secret;

    if (!cronSecret || !token || token !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if auto-post is enabled
    if (config.auto_post_enabled !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'disabled' });
    }

    // Interval guard: check if enough hours have passed since last post
    const intervalHours = parseInt(config.auto_post_interval_hours) || 24;
    if (config.last_auto_post_at) {
      const elapsed = Date.now() - new Date(config.last_auto_post_at).getTime();
      if (elapsed < intervalHours * 60 * 60 * 1000) {
        const nextIn = Math.round((intervalHours * 60 * 60 * 1000 - elapsed) / 60000);
        return NextResponse.json({ skipped: true, reason: 'interval_not_reached', nextInMinutes: nextIn });
      }
    }

    // Fetch today's unposted channels
    const channels = await fetchUnpostedChannels(pool);

    if (channels.length < 3) {
      return NextResponse.json({ skipped: true, reason: 'not_enough_channels', found: channels.length });
    }

    // Take top 5 for the thread
    const top5 = channels.slice(0, 5);

    // Generate thread
    const tweets = generateLeaderboardThread(top5);
    if (tweets.length === 0) {
      return NextResponse.json({ skipped: true, reason: 'no_tweets_generated' });
    }

    // Get Twitter credentials
    const creds = await getTwitterCredentials(pool);
    if (!creds) {
      return NextResponse.json({ error: 'Twitter credentials not configured' }, { status: 400 });
    }

    // Post thread
    const client = createTwitterClient(creds);
    const result = await postThread(client, tweets);

    // Mark channels as posted (even on partial success, mark what we posted about)
    if (result.tweetIds.length > 0) {
      const channelIds = top5.map(ch => ch.channel_id);
      const values: string[] = [];
      const params: string[] = [];
      let paramIdx = 1;
      for (const id of channelIds) {
        values.push(`($${paramIdx}, 'auto_thread')`);
        params.push(id);
        paramIdx++;
      }
      await pool.query(
        `INSERT INTO x_posted_channels (channel_id, post_type) VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`,
        params
      );
    }

    // Save last post timestamp and result
    const postResult = {
      posted: result.tweetIds.length,
      total: tweets.length,
      threadUrl: result.threadUrl,
      channelIds: top5.map(ch => ch.channel_id),
      channelNames: top5.map(ch => ch.channel_name),
      error: result.error || null,
    };

    await saveConfig(pool, {
      last_auto_post_at: new Date().toISOString(),
      last_auto_post_result: JSON.stringify(postResult),
    });

    return NextResponse.json({
      success: true,
      ...postResult,
    });
  } catch (error) {
    console.error('[cron/x-post] error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to auto-post' },
      { status: 500 }
    );
  }
}

async function fetchUnpostedChannels(pool: import('pg').Pool): Promise<ThreadChannel[]> {
  const today = new Date().toISOString().split('T')[0];

  const result = await pool.query(`
    SELECT
      c.channel_id, c.channel_name, c.channel_url, c.avatar_url,
      c.subscriber_count, c.total_video_count, c.channel_creation_date,
      c.first_seen_at,
      ca.category AS ai_category, ca.niche AS ai_niche, ca.sub_niche AS ai_sub_niche,
      ca.content_style, ca.is_ai_generated, ca.channel_summary,
      ca.tags AS ai_tags, ca.language AS ai_language,
      json_agg(
        json_build_object(
          'video_id', v.video_id,
          'view_count', v.view_count
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
    WHERE c.first_seen_at::date = $1::date
      AND xp.channel_id IS NULL
      AND c.channel_creation_date > NOW() - INTERVAL '90 days'
      AND c.subscriber_count >= 10000
    GROUP BY c.channel_id, c.channel_name, c.channel_url, c.avatar_url,
             c.subscriber_count, c.total_video_count, c.channel_creation_date,
             c.first_seen_at,
             ca.category, ca.niche, ca.sub_niche, ca.content_style, ca.is_ai_generated,
             ca.channel_summary, ca.tags, ca.language
    ORDER BY SUM(v.view_count) / GREATEST(EXTRACT(EPOCH FROM (NOW() - c.channel_creation_date)) / 86400, 1) DESC NULLS LAST
  `, [today]);

  // Fetch real total view counts from YouTube Data API
  const ytViewCounts: Record<string, number> = {};
  try {
    const ytKeyResult = await pool.query(
      `SELECT value FROM admin_config WHERE key = 'youtube_api_key'`
    );
    const ytApiKey = ytKeyResult.rows[0]?.value || process.env.YOUTUBE_API_KEY;
    if (ytApiKey && result.rows.length > 0) {
      const channelIds = result.rows.map((ch: { channel_id: string }) => ch.channel_id);
      for (let i = 0; i < channelIds.length; i += 50) {
        const batch = channelIds.slice(i, i + 50);
        const ytRes = await fetch(
          `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${batch.join(',')}&key=${ytApiKey}`
        );
        if (ytRes.ok) {
          const ytData = await ytRes.json();
          for (const item of ytData.items || []) {
            ytViewCounts[item.id] = Number(item.statistics?.viewCount) || 0;
          }
        }
      }
    }
  } catch (err) {
    console.error('[cron/x-post] Failed to fetch YouTube view counts:', err);
  }

  // Prioritize EN language channels, then others
  const channels: ThreadChannel[] = result.rows.map((ch) => {
    const titles = (ch.videos || []).map((v: { title?: string }) => v.title || '');
    const niche = classifyNiche(titles, ch.channel_name || '');
    const ageDays = ch.channel_creation_date
      ? Math.max(1, Math.round((Date.now() - new Date(ch.channel_creation_date).getTime()) / 86400000))
      : null;
    const dbViews = (ch.videos || []).reduce((sum: number, v: { view_count: number }) => sum + (Number(v.view_count) || 0), 0);
    const totalViews = ytViewCounts[ch.channel_id] || dbViews;
    return {
      ...ch,
      subscriber_count: ch.subscriber_count ? Number(ch.subscriber_count) : null,
      total_video_count: ch.total_video_count ? Number(ch.total_video_count) : null,
      niche: ch.ai_niche || niche,
      age_days: ageDays,
      total_views: totalViews,
    };
  });

  // Sort: EN first, then others
  const en = channels.filter(ch => ch.ai_language?.toUpperCase() === 'EN');
  const other = channels.filter(ch => ch.ai_language?.toUpperCase() !== 'EN');
  return [...en, ...other];
}
