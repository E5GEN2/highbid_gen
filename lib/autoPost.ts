/**
 * Core auto-post logic shared by cron and manual "Post Now".
 * Returns step-by-step logs so the UI can show exactly what happened.
 */
import type { Pool } from 'pg';
import { classifyNiche } from './niches';
import { getTwitterCredentials, createTwitterClient, postThread } from './twitter';
import { generateLeaderboardThread, type ThreadChannel } from './generateThread';

export interface AutoPostLog {
  step: string;
  status: 'ok' | 'skip' | 'error';
  detail: string;
  ts: string;
}

export interface AutoPostResult {
  success: boolean;
  logs: AutoPostLog[];
  posted?: number;
  total?: number;
  threadUrl?: string | null;
  channelIds?: string[];
  channelNames?: string[];
  error?: string;
}

function log(logs: AutoPostLog[], step: string, status: 'ok' | 'skip' | 'error', detail: string) {
  logs.push({ step, status, detail, ts: new Date().toISOString() });
}

async function saveConfig(pool: Pool, entries: Record<string, string>) {
  for (const [key, value] of Object.entries(entries)) {
    await pool.query(
      `INSERT INTO admin_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }
}

/**
 * Execute the auto-post flow. Called directly by both cron and manual endpoints.
 */
export async function executeAutoPost(pool: Pool): Promise<AutoPostResult> {
  const logs: AutoPostLog[] = [];

  try {
    // Step 1: Check Twitter credentials
    log(logs, 'credentials', 'ok', 'Checking Twitter API credentials...');
    const creds = await getTwitterCredentials(pool);
    if (!creds) {
      log(logs, 'credentials', 'error', 'Twitter API credentials not configured. Set all 4 keys in the admin panel.');
      return { success: false, logs, error: 'Twitter credentials not configured' };
    }
    log(logs, 'credentials', 'ok', 'All 4 Twitter API keys found');

    // Step 2: Fetch unposted channels
    log(logs, 'fetch_channels', 'ok', 'Fetching unposted channels...');
    const channels = await fetchUnpostedChannels(pool);
    log(logs, 'fetch_channels', 'ok', `Found ${channels.length} unposted channels`);

    if (channels.length < 3) {
      log(logs, 'fetch_channels', 'skip', `Need at least 3 channels, found ${channels.length}. No unposted channels available.`);
      return { success: false, logs, error: `Not enough unposted channels (${channels.length})` };
    }

    // Step 3: Pick top 5 and generate thread
    const top5 = channels.slice(0, 5);
    log(logs, 'generate', 'ok', `Selected top ${top5.length} channels: ${top5.map(ch => ch.channel_name).join(', ')}`);

    const tweets = generateLeaderboardThread(top5);
    if (tweets.length === 0) {
      log(logs, 'generate', 'error', 'Thread generation returned 0 tweets');
      return { success: false, logs, error: 'No tweets generated' };
    }
    log(logs, 'generate', 'ok', `Generated ${tweets.length} tweets`);

    // Step 4: Post to Twitter
    log(logs, 'post', 'ok', 'Posting thread to X...');
    const client = createTwitterClient(creds);
    const result = await postThread(client, tweets);

    if (result.tweetIds.length === 0) {
      log(logs, 'post', 'error', `Failed to post any tweets: ${result.error || 'Unknown error'}`);
      // Save the failure result too so the UI shows what happened
      await saveConfig(pool, {
        last_auto_post_at: new Date().toISOString(),
        last_auto_post_result: JSON.stringify({
          posted: 0, total: tweets.length, threadUrl: null,
          channelIds: top5.map(ch => ch.channel_id),
          channelNames: top5.map(ch => ch.channel_name),
          error: result.error, logs,
        }),
      });
      return { success: false, logs, error: result.error || 'Failed to post tweets' };
    }

    if (result.error) {
      log(logs, 'post', 'error', `Partial success: ${result.tweetIds.length}/${tweets.length} tweets posted. Error: ${result.error}`);
    } else {
      log(logs, 'post', 'ok', `All ${result.tweetIds.length} tweets posted successfully`);
    }
    log(logs, 'post', 'ok', `Thread URL: ${result.threadUrl}`);

    // Step 5: Mark channels as posted
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
    log(logs, 'mark_posted', 'ok', `Marked ${channelIds.length} channels as posted`);

    // Step 6: Save result
    const postResult = {
      posted: result.tweetIds.length,
      total: tweets.length,
      threadUrl: result.threadUrl,
      channelIds,
      channelNames: top5.map(ch => ch.channel_name),
      error: result.error || null,
      logs,
    };

    await saveConfig(pool, {
      last_auto_post_at: new Date().toISOString(),
      last_auto_post_result: JSON.stringify(postResult),
    });

    log(logs, 'done', 'ok', 'Auto-post complete');

    return {
      success: true,
      logs,
      posted: result.tweetIds.length,
      total: tweets.length,
      threadUrl: result.threadUrl,
      channelIds,
      channelNames: top5.map(ch => ch.channel_name),
      error: result.error,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(logs, 'error', 'error', msg);
    return { success: false, logs, error: msg };
  }
}

async function fetchUnpostedChannels(pool: Pool): Promise<ThreadChannel[]> {
  // Fetch unposted channels from the last 7 days (not just today)
  // so there are always channels available for posting
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
    WHERE xp.channel_id IS NULL
      AND c.first_seen_at > NOW() - INTERVAL '7 days'
      AND c.channel_creation_date > NOW() - INTERVAL '90 days'
      AND c.subscriber_count >= 10000
    GROUP BY c.channel_id, c.channel_name, c.channel_url, c.avatar_url,
             c.subscriber_count, c.total_video_count, c.channel_creation_date,
             c.first_seen_at,
             ca.category, ca.niche, ca.sub_niche, ca.content_style, ca.is_ai_generated,
             ca.channel_summary, ca.tags, ca.language
    ORDER BY SUM(v.view_count) / GREATEST(EXTRACT(EPOCH FROM (NOW() - c.channel_creation_date)) / 86400, 1) DESC NULLS LAST
    LIMIT 20
  `);

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
    console.error('[auto-post] Failed to fetch YouTube view counts:', err);
  }

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
