import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

async function getConfig(pool: import('pg').Pool): Promise<Record<string, string>> {
  const result = await pool.query('SELECT key, value FROM admin_config');
  const config: Record<string, string> = {};
  for (const row of result.rows) config[row.key] = row.value;
  return config;
}

function parseDuration(iso: string): number {
  // PT1M30S → 90, PT45S → 45, PT1H2M3S → 3723
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || '0') * 3600) +
         (parseInt(match[2] || '0') * 60) +
         (parseInt(match[3] || '0'));
}

export async function GET(req: NextRequest) {
  try {
    const channelId = req.nextUrl.searchParams.get('channelId');
    if (!channelId) {
      return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
    }

    const pool = await getPool();

    // Check cache: if we have 10+ videos for this channel fetched within last 24h, return cached
    const cached = await pool.query(
      `SELECT COUNT(*) as cnt FROM shorts_videos
       WHERE channel_id = $1 AND collection_id = 'yt-api-fetch'
       AND collected_at > NOW() - INTERVAL '24 hours'`,
      [channelId]
    );
    const cachedCount = parseInt(cached.rows[0].cnt);

    if (cachedCount >= 10) {
      // Return cached videos
      const cachedVideos = await pool.query(
        `SELECT DISTINCT ON (video_id) video_id, title, duration_seconds, view_count, like_count, comment_count, upload_date
         FROM shorts_videos WHERE channel_id = $1
         ORDER BY video_id, collected_at DESC`,
        [channelId]
      );
      return NextResponse.json({ success: true, videos: cachedVideos.rows, cached: true });
    }

    // Get YouTube API key
    const config = await getConfig(pool);
    const apiKey = config.youtube_api_key;
    if (!apiKey) {
      return NextResponse.json({ error: 'YouTube API key not configured' }, { status: 500 });
    }

    // Convert UC... channel ID to UU... uploads playlist
    const uploadsPlaylistId = channelId.startsWith('UC')
      ? 'UU' + channelId.slice(2)
      : channelId;

    // Fetch all playlist items (paginate)
    const allVideoIds: string[] = [];
    const videoSnippets: Record<string, { title: string; uploadDate: string }> = {};
    let nextPageToken: string | undefined;

    do {
      const plUrl = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
      plUrl.searchParams.set('part', 'snippet');
      plUrl.searchParams.set('playlistId', uploadsPlaylistId);
      plUrl.searchParams.set('maxResults', '50');
      plUrl.searchParams.set('key', apiKey);
      if (nextPageToken) plUrl.searchParams.set('pageToken', nextPageToken);

      const plRes = await fetch(plUrl.toString());
      if (!plRes.ok) {
        const text = await plRes.text();
        console.error('YouTube playlistItems error:', plRes.status, text);
        break;
      }

      const plData = await plRes.json();
      for (const item of plData.items || []) {
        const vid = item.snippet?.resourceId?.videoId;
        if (vid) {
          allVideoIds.push(vid);
          videoSnippets[vid] = {
            title: item.snippet.title || '',
            uploadDate: item.snippet.publishedAt || '',
          };
        }
      }

      nextPageToken = plData.nextPageToken;
    } while (nextPageToken);

    if (allVideoIds.length === 0) {
      return NextResponse.json({ success: true, videos: [], message: 'No videos found' });
    }

    // Fetch video details in batches of 50 (duration, stats)
    interface VideoDetail {
      video_id: string;
      title: string;
      duration_seconds: number;
      upload_date: string;
      view_count: number | null;
      like_count: number | null;
      comment_count: number | null;
    }
    const shorts: VideoDetail[] = [];

    for (let i = 0; i < allVideoIds.length; i += 50) {
      const batch = allVideoIds.slice(i, i + 50);
      const vUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
      vUrl.searchParams.set('part', 'contentDetails,statistics');
      vUrl.searchParams.set('id', batch.join(','));
      vUrl.searchParams.set('key', apiKey);

      const vRes = await fetch(vUrl.toString());
      if (!vRes.ok) {
        console.error('YouTube videos error:', vRes.status, await vRes.text());
        continue;
      }

      const vData = await vRes.json();
      for (const item of vData.items || []) {
        const durationSec = parseDuration(item.contentDetails?.duration || '');
        if (durationSec > 60) continue; // Skip non-shorts

        const snippet = videoSnippets[item.id] || { title: '', uploadDate: '' };
        shorts.push({
          video_id: item.id,
          title: snippet.title || '',
          duration_seconds: durationSec,
          upload_date: snippet.uploadDate || '',
          view_count: item.statistics?.viewCount ? parseInt(item.statistics.viewCount) : null,
          like_count: item.statistics?.likeCount ? parseInt(item.statistics.likeCount) : null,
          comment_count: item.statistics?.commentCount ? parseInt(item.statistics.commentCount) : null,
        });
      }
    }

    // Upsert into shorts_videos
    for (const v of shorts) {
      // Check if this video already exists for this channel
      const existing = await pool.query(
        `SELECT id FROM shorts_videos WHERE video_id = $1 AND collection_id = 'yt-api-fetch'`,
        [v.video_id]
      );

      if (existing.rows.length > 0) {
        // Update stats
        await pool.query(
          `UPDATE shorts_videos SET view_count = $1, like_count = $2, comment_count = $3, collected_at = NOW()
           WHERE video_id = $4 AND collection_id = 'yt-api-fetch'`,
          [v.view_count, v.like_count, v.comment_count, v.video_id]
        );
      } else {
        await pool.query(
          `INSERT INTO shorts_videos (video_id, video_url, title, duration_seconds, upload_date, channel_id, view_count, like_count, comment_count, collected_at, collection_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), 'yt-api-fetch')`,
          [
            v.video_id,
            `https://www.youtube.com/shorts/${v.video_id}`,
            v.title,
            v.duration_seconds,
            v.upload_date,
            channelId,
            v.view_count,
            v.like_count,
            v.comment_count,
          ]
        );
      }
    }

    // Return all videos for this channel (including previously fetched ones)
    const allVideos = await pool.query(
      `SELECT DISTINCT ON (video_id) video_id, title, duration_seconds, view_count, like_count, comment_count, upload_date
       FROM shorts_videos WHERE channel_id = $1
       ORDER BY video_id, collected_at DESC`,
      [channelId]
    );

    return NextResponse.json({ success: true, videos: allVideos.rows, cached: false, fetched: shorts.length });
  } catch (error) {
    console.error('Channel videos fetch error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Fetch failed' },
      { status: 500 }
    );
  }
}
