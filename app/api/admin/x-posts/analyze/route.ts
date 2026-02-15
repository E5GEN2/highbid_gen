import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../../lib/db';
import { analyzeChannel } from '../../../../../lib/gemini';

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

// GET: Poll analysis progress for given channel IDs
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const pool = await getPool();
    const channelIdsParam = req.nextUrl.searchParams.get('channelIds') || '';
    const channelIds = channelIdsParam.split(',').filter(Boolean);

    if (channelIds.length === 0) {
      return NextResponse.json({ error: 'channelIds required' }, { status: 400 });
    }

    // Fetch all analysis rows for these channels
    const placeholders = channelIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(
      `SELECT channel_id, status, niche, sub_niche, content_style, is_ai_generated,
              channel_summary, tags, error_message, analyzed_at
       FROM channel_analysis
       WHERE channel_id IN (${placeholders})`,
      channelIds
    );

    const analyses: Record<string, typeof result.rows[0]> = {};
    let done = 0, failed = 0, analyzing = 0, pending = 0;

    for (const row of result.rows) {
      analyses[row.channel_id] = row;
      if (row.status === 'done') done++;
      else if (row.status === 'failed') failed++;
      else if (row.status === 'analyzing') analyzing++;
      else pending++;
    }

    // Channels without a row are considered not started
    const notStarted = channelIds.length - result.rows.length;
    pending += notStarted;

    const total = channelIds.length;
    const isComplete = done + failed === total;

    return NextResponse.json({
      analyses,
      progress: { total, done, failed, analyzing, pending },
      isComplete,
    });
  } catch (error) {
    console.error('Analyze GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Query failed' },
      { status: 500 }
    );
  }
}

// POST: Start or rerun analysis
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const pool = await getPool();
    const { channelIds, rerunFailed } = await req.json();

    if (!Array.isArray(channelIds) || channelIds.length === 0) {
      return NextResponse.json({ error: 'channelIds array required' }, { status: 400 });
    }

    const apiKey = process.env.PAPAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'PAPAI_API_KEY not configured' }, { status: 500 });
    }

    // Fetch channel data + top 3 videos for each channel
    const placeholders = channelIds.map((_, i) => `$${i + 1}`).join(',');
    const channelResult = await pool.query(
      `SELECT c.channel_id, c.channel_name, c.channel_url,
              json_agg(
                json_build_object(
                  'video_id', v.video_id,
                  'title', v.title,
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
       WHERE c.channel_id IN (${placeholders})
       GROUP BY c.channel_id, c.channel_name, c.channel_url`,
      channelIds
    );

    const channelMap = new Map<string, typeof channelResult.rows[0]>();
    for (const row of channelResult.rows) {
      channelMap.set(row.channel_id, row);
    }

    // Upsert pending rows
    for (const channelId of channelIds) {
      if (!channelMap.has(channelId)) continue;

      if (rerunFailed) {
        // Only reset failed rows
        await pool.query(
          `UPDATE channel_analysis SET status = 'pending', error_message = NULL, updated_at = NOW()
           WHERE channel_id = $1 AND status = 'failed'`,
          [channelId]
        );
      } else {
        await pool.query(
          `INSERT INTO channel_analysis (channel_id, status)
           VALUES ($1, 'pending')
           ON CONFLICT (channel_id) DO UPDATE SET status = 'pending', error_message = NULL, updated_at = NOW()`,
          [channelId]
        );
      }
    }

    // Process channels sequentially
    let doneCount = 0;
    let failedCount = 0;

    for (const channelId of channelIds) {
      const ch = channelMap.get(channelId);
      if (!ch) continue;

      // Check current status — skip if already done (for rerunFailed mode)
      const statusCheck = await pool.query(
        'SELECT status FROM channel_analysis WHERE channel_id = $1',
        [channelId]
      );
      const currentStatus = statusCheck.rows[0]?.status;
      if (currentStatus === 'done' && rerunFailed) {
        doneCount++;
        continue;
      }
      if (currentStatus !== 'pending') {
        if (currentStatus === 'done') doneCount++;
        if (currentStatus === 'failed') failedCount++;
        continue;
      }

      // Mark as analyzing
      await pool.query(
        `UPDATE channel_analysis SET status = 'analyzing', updated_at = NOW() WHERE channel_id = $1`,
        [channelId]
      );

      try {
        const result = await analyzeChannel(
          ch.channel_name,
          ch.channel_url,
          ch.videos || [],
          apiKey
        );

        await pool.query(
          `UPDATE channel_analysis SET
            status = 'done',
            niche = $2,
            sub_niche = $3,
            content_style = $4,
            is_ai_generated = $5,
            channel_summary = $6,
            tags = $7,
            raw_response = $8,
            error_message = NULL,
            analyzed_at = NOW(),
            updated_at = NOW()
           WHERE channel_id = $1`,
          [
            channelId,
            result.niche,
            result.sub_niche,
            result.content_style,
            result.is_ai_generated,
            result.channel_summary,
            result.tags,
            JSON.stringify(result),
          ]
        );
        doneCount++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await pool.query(
          `UPDATE channel_analysis SET status = 'failed', error_message = $2, updated_at = NOW()
           WHERE channel_id = $1`,
          [channelId, errorMsg]
        );
        failedCount++;
        console.error(`Analysis failed for ${ch.channel_name}:`, errorMsg);
      }
    }

    return NextResponse.json({
      success: true,
      processed: channelIds.length,
      done: doneCount,
      failed: failedCount,
    });
  } catch (error) {
    console.error('Analyze POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Analysis failed' },
      { status: 500 }
    );
  }
}
