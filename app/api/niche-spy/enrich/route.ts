import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getProxy, getProxyStats } from '@/lib/xgodo-proxy';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * POST /api/niche-spy/enrich
 * Fill missing data for niche spy videos using YouTube Data API v3 via proxy.
 * Body: { keyword?, limit?, forceRefresh? }
 *
 * Finds videos with missing data (no likes, no subs, no exact date) and
 * enriches them via YT Data API batched by 50 video IDs per call.
 */
export async function POST(req: NextRequest) {
  const pool = await getPool();
  const body = await req.json().catch(() => ({}));
  const keyword = body.keyword;
  const limit = Math.min(parseInt(body.limit) || 200, 500);
  const forceRefresh = body.forceRefresh || false;

  // Get YouTube API key from admin config
  const keyRes = await pool.query("SELECT value FROM admin_config WHERE key = 'youtube_api_key'");
  const ytApiKey = keyRes.rows[0]?.value;
  if (!ytApiKey) {
    return NextResponse.json({ error: 'youtube_api_key not configured in admin' }, { status: 500 });
  }

  // Get a proxy
  const proxy = await getProxy();
  const proxyStats = await getProxyStats();

  // Find videos needing enrichment
  const conditions = [
    '(like_count IS NULL OR like_count = 0 OR subscriber_count IS NULL OR subscriber_count = 0 OR posted_at IS NULL)',
  ];
  const params: (string | number)[] = [];
  let idx = 1;

  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $${idx}`);
    params.push(keyword);
    idx++;
  }
  if (!forceRefresh) {
    conditions.push(`(enriched_at IS NULL OR enriched_at < NOW() - INTERVAL '7 days')`);
  }

  params.push(limit);
  const limitIdx = idx;

  const videosRes = await pool.query(
    `SELECT id, url, title, view_count, like_count, comment_count, subscriber_count, channel_name, posted_at
     FROM niche_spy_videos
     WHERE ${conditions.join(' AND ')}
     ORDER BY score DESC NULLS LAST
     LIMIT $${limitIdx}`,
    params
  );

  if (videosRes.rows.length === 0) {
    return NextResponse.json({
      status: 'done',
      message: 'No videos need enrichment',
      enriched: 0,
      proxyStats,
    });
  }

  // Extract video IDs from URLs
  const videoMap = new Map<string, { dbId: number; url: string }>();
  for (const row of videosRes.rows) {
    const match = row.url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (match) {
      videoMap.set(match[1], { dbId: row.id, url: row.url });
    }
  }

  if (videoMap.size === 0) {
    return NextResponse.json({ status: 'done', message: 'No valid video IDs found', enriched: 0 });
  }

  // Batch fetch from YT Data API (50 IDs per call)
  const allIds = Array.from(videoMap.keys());
  let enriched = 0;
  let errors = 0;
  const batchResults: Array<{ batch: number; fetched: number; enriched: number; error?: string }> = [];

  for (let i = 0; i < allIds.length; i += 50) {
    const batchIds = allIds.slice(i, i + 50);
    const batchNum = Math.floor(i / 50) + 1;

    try {
      const ytUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
      ytUrl.searchParams.set('part', 'snippet,statistics');
      ytUrl.searchParams.set('id', batchIds.join(','));
      ytUrl.searchParams.set('key', ytApiKey);

      // Use proxy if available
      const fetchOptions: RequestInit = { signal: AbortSignal.timeout(30000) };
      if (proxy) {
        const agent = new HttpsProxyAgent(proxy.url);
        (fetchOptions as Record<string, unknown>).agent = agent;
      }

      const ytRes = await fetch(ytUrl.toString(), fetchOptions);

      if (!ytRes.ok) {
        const errText = await ytRes.text();
        batchResults.push({ batch: batchNum, fetched: 0, enriched: 0, error: `YT API ${ytRes.status}: ${errText.substring(0, 100)}` });
        errors++;
        continue;
      }

      const ytData = await ytRes.json();
      const items = ytData.items || [];
      let batchEnriched = 0;

      for (const item of items) {
        const videoId = item.id;
        const dbEntry = videoMap.get(videoId);
        if (!dbEntry) continue;

        const snippet = item.snippet || {};
        const stats = item.statistics || {};

        // Parse exact publish date
        const publishedAt = snippet.publishedAt ? new Date(snippet.publishedAt) : null;

        // Build update
        const updates: string[] = [];
        const updateParams: (string | number | Date | null)[] = [];
        let pIdx = 1;

        // Always update enriched_at
        updates.push(`enriched_at = NOW()`);

        // Fill missing title
        if (snippet.title) {
          updates.push(`title = COALESCE(NULLIF(title, ''), $${pIdx})`);
          updateParams.push(snippet.title);
          pIdx++;
        }

        // Fill missing channel
        if (snippet.channelTitle) {
          updates.push(`channel_name = COALESCE(NULLIF(channel_name, ''), $${pIdx})`);
          updateParams.push(snippet.channelTitle);
          pIdx++;
        }

        // Exact publish date — always overwrite since it's more accurate
        if (publishedAt) {
          updates.push(`posted_at = $${pIdx}`);
          updateParams.push(publishedAt);
          pIdx++;
        }

        // Views — take the larger value
        if (stats.viewCount) {
          updates.push(`view_count = GREATEST(view_count, $${pIdx})`);
          updateParams.push(parseInt(stats.viewCount) || 0);
          pIdx++;
        }

        // Likes
        if (stats.likeCount) {
          updates.push(`like_count = GREATEST(like_count, $${pIdx})`);
          updateParams.push(parseInt(stats.likeCount) || 0);
          pIdx++;
        }

        // Comments
        if (stats.commentCount) {
          updates.push(`comment_count = GREATEST(comment_count, $${pIdx})`);
          updateParams.push(parseInt(stats.commentCount) || 0);
          pIdx++;
        }

        // Thumbnail
        const thumb = snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || '';
        if (thumb) {
          updates.push(`thumbnail = COALESCE(NULLIF(thumbnail, ''), $${pIdx})`);
          updateParams.push(thumb);
          pIdx++;
        }

        updateParams.push(dbEntry.dbId);
        await pool.query(
          `UPDATE niche_spy_videos SET ${updates.join(', ')} WHERE id = $${pIdx}`,
          updateParams
        );
        batchEnriched++;
        enriched++;
      }

      batchResults.push({ batch: batchNum, fetched: items.length, enriched: batchEnriched });
    } catch (err) {
      batchResults.push({ batch: batchNum, fetched: 0, enriched: 0, error: (err as Error).message?.substring(0, 100) });
      errors++;
    }
  }

  return NextResponse.json({
    status: 'done',
    videosChecked: videoMap.size,
    enriched,
    errors,
    batches: batchResults,
    proxy: proxy ? { deviceId: proxy.deviceId, networkType: proxy.networkType } : null,
    proxyStats,
  });
}

/**
 * GET /api/niche-spy/enrich
 * Check how many videos need enrichment.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const keyword = req.nextUrl.searchParams.get('keyword');

  const conditions = [
    '(like_count IS NULL OR like_count = 0 OR subscriber_count IS NULL OR subscriber_count = 0 OR posted_at IS NULL)',
  ];
  const params: string[] = [];
  let idx = 1;

  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $${idx}`);
    params.push(keyword);
    idx++;
  }

  const res = await pool.query(
    `SELECT COUNT(*) as need_enrichment,
            COUNT(*) FILTER (WHERE like_count IS NULL OR like_count = 0) as missing_likes,
            COUNT(*) FILTER (WHERE subscriber_count IS NULL OR subscriber_count = 0) as missing_subs,
            COUNT(*) FILTER (WHERE posted_at IS NULL) as missing_date,
            COUNT(*) FILTER (WHERE enriched_at IS NOT NULL) as already_enriched
     FROM niche_spy_videos WHERE ${conditions.join(' AND ')}`,
    params
  );

  const proxyStats = await getProxyStats();

  return NextResponse.json({
    ...res.rows[0],
    proxyStats,
  });
}

export const maxDuration = 120;
