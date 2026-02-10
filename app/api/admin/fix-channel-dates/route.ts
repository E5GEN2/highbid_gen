import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export async function POST() {
  // Get YouTube API key from admin_config
  const configRes = await pool.query(
    "SELECT value FROM admin_config WHERE key = 'youtube_api_key'"
  );
  const YT_API_KEY = configRes.rows[0]?.value;
  if (!YT_API_KEY) {
    return NextResponse.json({ error: 'YouTube API key not configured' }, { status: 500 });
  }

  // Get all channel IDs
  const channelsRes = await pool.query('SELECT channel_id FROM shorts_channels');
  const channelIds = channelsRes.rows.map((r: { channel_id: string }) => r.channel_id);

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < channelIds.length; i += 50) {
    const batch = channelIds.slice(i, i + 50);
    try {
      const ytRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${batch.join(',')}&key=${YT_API_KEY}`
      );
      if (!ytRes.ok) {
        console.error(`YouTube API error: ${ytRes.status}`);
        failed += batch.length;
        continue;
      }
      const ytData = await ytRes.json();
      for (const item of ytData.items || []) {
        const publishedAt = item.snippet?.publishedAt;
        if (publishedAt) {
          await pool.query(
            'UPDATE shorts_channels SET channel_creation_date = $1 WHERE channel_id = $2',
            [publishedAt, item.id]
          );
          updated++;
        }
      }
    } catch (err) {
      console.error('Batch failed:', err);
      failed += batch.length;
    }
  }

  return NextResponse.json({
    total: channelIds.length,
    updated,
    failed,
  });
}
