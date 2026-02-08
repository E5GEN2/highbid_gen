import { NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

export async function POST() {
  try {
    const pool = await getPool();

    // Read YouTube API key from config
    const configResult = await pool.query(
      "SELECT value FROM admin_config WHERE key = 'youtube_api_key'"
    );
    const YT_API_KEY = configResult.rows[0]?.value;
    if (!YT_API_KEY) {
      return NextResponse.json(
        { error: 'YouTube API key not configured — set it in Admin → Config' },
        { status: 400 }
      );
    }

    // Find channels without avatars
    const missingResult = await pool.query(
      'SELECT channel_id FROM shorts_channels WHERE avatar_url IS NULL'
    );
    const channelIds = missingResult.rows.map((r: { channel_id: string }) => r.channel_id);

    if (channelIds.length === 0) {
      return NextResponse.json({ success: true, fetched: 0, message: 'All channels already have avatars' });
    }

    let fetched = 0;

    // YouTube API allows up to 50 IDs per request
    for (let i = 0; i < channelIds.length; i += 50) {
      const batch = channelIds.slice(i, i + 50);
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${batch.join(',')}&key=${YT_API_KEY}`
      );
      if (res.ok) {
        const data = await res.json();
        for (const item of data.items || []) {
          const avatarUrl = item.snippet?.thumbnails?.medium?.url
            || item.snippet?.thumbnails?.default?.url;
          if (avatarUrl) {
            await pool.query(
              'UPDATE shorts_channels SET avatar_url = $1 WHERE channel_id = $2',
              [avatarUrl, item.id]
            );
            fetched++;
          }
        }
      } else {
        const text = await res.text();
        throw new Error(`YouTube API error: ${res.status} ${text}`);
      }
    }

    return NextResponse.json({
      success: true,
      fetched,
      total: channelIds.length,
    });
  } catch (error) {
    console.error('Fetch avatars error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch avatars' },
      { status: 500 }
    );
  }
}
