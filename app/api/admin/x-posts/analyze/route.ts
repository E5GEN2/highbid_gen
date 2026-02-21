import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../../lib/db';
import { analyzeChannel, DEFAULT_ANALYSIS_PROMPT } from '../../../../../lib/gemini';

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

async function getConfigKey(pool: import('pg').Pool, key: string, envFallback?: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT value FROM admin_config WHERE key = $1`,
    [key]
  );
  return result.rows[0]?.value || (envFallback ? process.env[envFallback] : null) || null;
}

async function getApiKey(pool: import('pg').Pool): Promise<string | null> {
  return getConfigKey(pool, 'papai_api_key', 'PAPAI_API_KEY');
}

async function getYouTubeApiKey(pool: import('pg').Pool): Promise<string | null> {
  return getConfigKey(pool, 'youtube_api_key', 'YOUTUBE_API_KEY');
}

async function detectLanguage(videoId: string, ytApiKey: string): Promise<string | null> {
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${ytApiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const snippet = data.items?.[0]?.snippet;
    return snippet?.defaultAudioLanguage || snippet?.defaultLanguage || null;
  } catch {
    return null;
  }
}

// GET: Poll analysis progress, or fetch config when no channelIds
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const pool = await getPool();
    const channelIdsParam = req.nextUrl.searchParams.get('channelIds') || '';
    const channelIds = channelIdsParam.split(',').filter(Boolean);

    // No channelIds = return config info
    if (channelIds.length === 0) {
      const apiKey = await getApiKey(pool);
      const ytApiKey = await getYouTubeApiKey(pool);
      const customPrompt = await getConfigKey(pool, 'analysis_prompt');
      return NextResponse.json({
        hasApiKey: !!apiKey,
        apiKeyPreview: apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : null,
        hasYouTubeApiKey: !!ytApiKey,
        youtubeApiKeyPreview: ytApiKey ? `${ytApiKey.slice(0, 8)}...${ytApiKey.slice(-4)}` : null,
        analysisPrompt: customPrompt || DEFAULT_ANALYSIS_PROMPT,
        defaultPrompt: DEFAULT_ANALYSIS_PROMPT,
      });
    }

    // Fetch all analysis rows for these channels
    const placeholders = channelIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(
      `SELECT channel_id, status, niche, sub_niche, content_style,
              channel_summary, tags, language, error_message, analyzed_at
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
    const body = await req.json();

    // Save API keys if provided
    if (body.apiKey && typeof body.apiKey === 'string') {
      await pool.query(
        `INSERT INTO admin_config (key, value, updated_at)
         VALUES ('papai_api_key', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [body.apiKey.trim()]
      );
    }
    if (body.youtubeApiKey && typeof body.youtubeApiKey === 'string') {
      await pool.query(
        `INSERT INTO admin_config (key, value, updated_at)
         VALUES ('youtube_api_key', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [body.youtubeApiKey.trim()]
      );
    }
    // Save analysis prompt if provided
    if (body.analysisPrompt && typeof body.analysisPrompt === 'string') {
      await pool.query(
        `INSERT INTO admin_config (key, value, updated_at)
         VALUES ('analysis_prompt', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [body.analysisPrompt.trim()]
      );
    }
    // If no channelIds, just saving config
    if (!body.channelIds && (body.apiKey || body.youtubeApiKey || body.analysisPrompt)) {
      return NextResponse.json({ success: true, saved: true });
    }

    const { channelIds, rerunFailed, onlyNew, concurrency: rawConcurrency } = body;
    const concurrency = Math.max(1, Math.min(10, parseInt(rawConcurrency) || 3));

    if (!Array.isArray(channelIds) || channelIds.length === 0) {
      return NextResponse.json({ error: 'channelIds array required' }, { status: 400 });
    }

    const apiKey = await getApiKey(pool);
    if (!apiKey) {
      return NextResponse.json({ error: 'API key not configured. Enter your PapaiAPI key above.' }, { status: 400 });
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
        // Reset failed + stuck analyzing (>5min) rows, and create rows for channels with no analysis yet
        await pool.query(
          `INSERT INTO channel_analysis (channel_id, status)
           VALUES ($1, 'pending')
           ON CONFLICT (channel_id) DO UPDATE SET
             status = CASE
               WHEN channel_analysis.status IN ('failed') THEN 'pending'
               WHEN channel_analysis.status = 'analyzing' AND channel_analysis.updated_at < NOW() - INTERVAL '5 minutes' THEN 'pending'
               ELSE channel_analysis.status
             END,
             error_message = CASE
               WHEN channel_analysis.status IN ('failed') THEN NULL
               WHEN channel_analysis.status = 'analyzing' AND channel_analysis.updated_at < NOW() - INTERVAL '5 minutes' THEN NULL
               ELSE channel_analysis.error_message
             END,
             updated_at = NOW()`,
          [channelId]
        );
      } else if (onlyNew) {
        // Only insert rows for channels that have no analysis yet — don't touch existing
        await pool.query(
          `INSERT INTO channel_analysis (channel_id, status)
           VALUES ($1, 'pending')
           ON CONFLICT (channel_id) DO NOTHING`,
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

    const ytApiKey = await getYouTubeApiKey(pool);
    const customPrompt = await getConfigKey(pool, 'analysis_prompt');

    // Process a single channel
    async function processChannel(channelId: string): Promise<'done' | 'failed' | 'skipped'> {
      const ch = channelMap.get(channelId);
      if (!ch) return 'skipped';

      const statusCheck = await pool.query(
        'SELECT status FROM channel_analysis WHERE channel_id = $1',
        [channelId]
      );
      const currentStatus = statusCheck.rows[0]?.status;
      if (currentStatus === 'done' && rerunFailed) return 'done';
      if (currentStatus !== 'pending') return currentStatus === 'done' ? 'done' : currentStatus === 'failed' ? 'failed' : 'skipped';

      await pool.query(
        `UPDATE channel_analysis SET status = 'analyzing', updated_at = NOW() WHERE channel_id = $1`,
        [channelId]
      );

      try {
        const result = await analyzeChannel(
          ch.videos || [],
          apiKey,
          customPrompt || undefined
        );

        // Detect language from top video via YouTube Data API
        let language: string | null = null;
        if (ytApiKey) {
          const topVideo = [...(ch.videos || [])].sort((a: { view_count: number }, b: { view_count: number }) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0))[0];
          if (topVideo) {
            language = await detectLanguage(topVideo.video_id, ytApiKey);
          }
        }

        await pool.query(
          `UPDATE channel_analysis SET
            status = 'done', category = $2, niche = $3, sub_niche = $4, content_style = $5,
            channel_summary = $6, tags = $7, raw_response = $8, language = $9,
            error_message = NULL, analyzed_at = NOW(), updated_at = NOW()
           WHERE channel_id = $1`,
          [channelId, result.category, result.niche, result.sub_niche, result.content_style,
           result.channel_summary, result.tags, JSON.stringify(result), language]
        );
        return 'done';
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await pool.query(
          `UPDATE channel_analysis SET status = 'failed', error_message = $2, updated_at = NOW()
           WHERE channel_id = $1`,
          [channelId, errorMsg]
        );
        console.error(`Analysis failed for ${ch.channel_name}:`, errorMsg);
        return 'failed';
      }
    }

    // Process in parallel batches
    let doneCount = 0;
    let failedCount = 0;

    for (let i = 0; i < channelIds.length; i += concurrency) {
      const batch = channelIds.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(processChannel));
      for (const r of results) {
        if (r === 'done') doneCount++;
        else if (r === 'failed') failedCount++;
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
