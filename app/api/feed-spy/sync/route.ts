import { NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

const XGODO_BASE = 'https://xgodo.com/api/v2';

interface VideoData {
  video_id: string;
  video_url: string;
  title: string | null;
  duration_seconds: number;
  upload_date: string | null;
  channel_id: string;
  channel_name: string;
  channel_url: string;
  channel_creation_date: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  collected_at: string;
  collection_order: number;
}

async function getConfig(pool: import('pg').Pool): Promise<Record<string, string>> {
  const result = await pool.query('SELECT key, value FROM admin_config');
  const config: Record<string, string> = {};
  for (const row of result.rows) config[row.key] = row.value;
  return config;
}

async function xgodoFetch(token: string, endpoint: string, body: object, method = 'POST') {

  const res = await fetch(`${XGODO_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`xgodo ${endpoint} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function parseISODate(s: string | null): string | null {
  if (!s) return null;
  // Fix truncated microseconds and ensure valid ISO
  const cleaned = s.replace('Z', '+00:00').replace(/\.(\d+)/, (_, d) => '.' + d.padEnd(6, '0'));
  try {
    const d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

export async function POST() {
  try {
    const pool = await getPool();

    // Read config from DB (fall back to env vars)
    const config = await getConfig(pool);
    const XGODO_TOKEN = config.xgodo_api_token || process.env.XGODO_API_TOKEN;
    const JOB_ID = config.xgodo_shorts_spy_job_id || process.env.XGODO_SHORTS_SPY_JOB_ID;
    if (!XGODO_TOKEN) throw new Error('xgodo API token not configured — set it in Admin → Config');
    if (!JOB_ID) throw new Error('xgodo job ID not configured — set it in Admin → Config');

    // 1. Fetch pending (=completed) tasks from xgodo
    const xgodoResult = await xgodoFetch(XGODO_TOKEN, '/jobs/applicants', {
      job_id: JOB_ID,
      status: 'pending',
      page: 1,
      limit: 50,
    });

    const tasks = xgodoResult.job_tasks || [];
    if (tasks.length === 0) {
      return NextResponse.json({ success: true, message: 'No new tasks to sync', synced: 0 });
    }

    let totalVideosSynced = 0;
    let tasksSynced = 0;
    const confirmedTaskIds: string[] = [];

    for (const task of tasks) {
      const taskId = task._id || task.job_task_id;

      // Skip if already collected
      const existing = await pool.query(
        'SELECT id FROM shorts_collections WHERE xgodo_task_id = $1',
        [taskId]
      );
      if (existing.rows.length > 0) continue;

      // Parse job_proof
      let videos: VideoData[] = [];
      try {
        const proof = JSON.parse(task.job_proof || '{}');
        videos = proof.collection_result?.videos || [];
      } catch {
        console.error('Failed to parse job_proof for task:', taskId);
        continue;
      }

      if (videos.length === 0) continue;

      const collectionId = `col_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

      // 2. Insert channels (upsert)
      for (const video of videos) {
        if (!video.channel_id) continue;

        await pool.query(`
          INSERT INTO shorts_channels (channel_id, channel_name, channel_url, channel_creation_date, last_seen_at, sighting_count)
          VALUES ($1, $2, $3, $4, NOW(), 1)
          ON CONFLICT (channel_id) DO UPDATE SET
            channel_name = COALESCE(EXCLUDED.channel_name, shorts_channels.channel_name),
            channel_url = COALESCE(EXCLUDED.channel_url, shorts_channels.channel_url),
            channel_creation_date = COALESCE(EXCLUDED.channel_creation_date, shorts_channels.channel_creation_date),
            last_seen_at = NOW(),
            sighting_count = shorts_channels.sighting_count + 1
        `, [
          video.channel_id,
          video.channel_name,
          video.channel_url,
          parseISODate(video.channel_creation_date),
        ]);
      }

      // 3. Insert video sightings
      for (const video of videos) {
        if (!video.video_id || !video.channel_id) continue;

        await pool.query(`
          INSERT INTO shorts_videos (video_id, video_url, title, duration_seconds, upload_date, channel_id, view_count, like_count, comment_count, collected_at, collection_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          video.video_id,
          video.video_url,
          video.title,
          video.duration_seconds,
          video.upload_date,
          video.channel_id,
          video.view_count,
          video.like_count,
          video.comment_count,
          parseISODate(video.collected_at),
          collectionId,
        ]);
      }

      // 4. Record collection
      await pool.query(`
        INSERT INTO shorts_collections (id, xgodo_task_id, video_count, collected_at)
        VALUES ($1, $2, $3, NOW())
      `, [collectionId, taskId, videos.length]);

      confirmedTaskIds.push(taskId);
      totalVideosSynced += videos.length;
      tasksSynced++;
    }

    // 5. Fetch missing channel avatars via YouTube Data API
    const YT_API_KEY = config.youtube_api_key;
    if (YT_API_KEY) {
      try {
        // Find channels without avatars
        const missingAvatars = await pool.query(
          `SELECT channel_id FROM shorts_channels WHERE avatar_url IS NULL`
        );
        const channelIds = missingAvatars.rows.map((r: { channel_id: string }) => r.channel_id);

        // YouTube API allows up to 50 IDs per request
        for (let i = 0; i < channelIds.length; i += 50) {
          const batch = channelIds.slice(i, i + 50);
          const ytRes = await fetch(
            `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${batch.join(',')}&key=${YT_API_KEY}`
          );
          if (ytRes.ok) {
            const ytData = await ytRes.json();
            for (const item of ytData.items || []) {
              const avatarUrl = item.snippet?.thumbnails?.medium?.url
                || item.snippet?.thumbnails?.default?.url;
              if (avatarUrl) {
                await pool.query(
                  'UPDATE shorts_channels SET avatar_url = $1 WHERE channel_id = $2',
                  [avatarUrl, item.id]
                );
              }
            }
          }
        }
      } catch (err) {
        console.error('Failed to fetch YouTube avatars:', err);
        // Non-critical — continue without avatars
      }
    }

    // 6. Mark tasks as confirmed on xgodo
    if (confirmedTaskIds.length > 0) {
      try {
        await xgodoFetch(XGODO_TOKEN, '/jobs/applicants', {
          job_id: JOB_ID,
          JobTasks_Ids: confirmedTaskIds,
          status: 'confirmed',
        }, 'PUT');

        // Update confirmed_at in our DB
        for (const taskId of confirmedTaskIds) {
          await pool.query(
            'UPDATE shorts_collections SET confirmed_at = NOW() WHERE xgodo_task_id = $1',
            [taskId]
          );
        }
      } catch (err) {
        console.error('Failed to confirm tasks on xgodo:', err);
        // Data is still saved locally, just not confirmed on xgodo
      }
    }

    return NextResponse.json({
      success: true,
      synced: tasksSynced,
      videos: totalVideosSynced,
      confirmed: confirmedTaskIds.length,
    });
  } catch (error) {
    console.error('Feed spy sync error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    );
  }
}
