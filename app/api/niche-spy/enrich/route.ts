import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getProxy, getProxyStats } from '@/lib/xgodo-proxy';

/**
 * POST /api/niche-spy/enrich
 * Fill missing data using YouTube Data API v3 via proxy.
 * Returns SSE stream with progress.
 * Body: { keyword?, limit? }
 */
export async function POST(req: NextRequest) {
  const pool = await getPool();
  const body = await req.json().catch(() => ({}));
  const keyword = body.keyword;
  const limit = Math.min(parseInt(body.limit) || 200, 500);

  // Get YouTube API keys — try niche_yt_api_keys first, fallback to youtube_api_key
  const multiKeyRes = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_yt_api_keys'");
  const singleKeyRes = await pool.query("SELECT value FROM admin_config WHERE key = 'youtube_api_key'");
  const ytApiKeys = (multiKeyRes.rows[0]?.value || '').split('\n').map((k: string) => k.trim()).filter((k: string) => k.length > 10);
  if (ytApiKeys.length === 0 && singleKeyRes.rows[0]?.value) ytApiKeys.push(singleKeyRes.rows[0].value);
  if (ytApiKeys.length === 0) {
    return NextResponse.json({ error: 'No YouTube API keys configured. Add them in Admin > Niche Explorer.' }, { status: 500 });
  }
  let ytKeyIdx = 0;
  const getYtKey = () => { const k = ytApiKeys[ytKeyIdx % ytApiKeys.length]; ytKeyIdx++; return k; };

  const proxy = await getProxy();
  const proxyStats = await getProxyStats();

  // Find videos needing enrichment:
  // - missing subs/likes/comments/date
  // - OR never enriched (relative dates only, no exact publishedAt)
  const conditions = [
    '(enriched_at IS NULL OR like_count IS NULL OR like_count = 0 OR subscriber_count IS NULL OR subscriber_count = 0)',
  ];
  const params: (string | number)[] = [];
  let idx = 1;

  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $${idx}`);
    params.push(keyword);
    idx++;
  }

  params.push(limit);

  const videosRes = await pool.query(
    `SELECT id, url, channel_name FROM niche_spy_videos
     WHERE ${conditions.join(' AND ')} ORDER BY score DESC NULLS LAST LIMIT $${idx}`,
    params
  );

  if (videosRes.rows.length === 0) {
    return NextResponse.json({ status: 'done', message: 'No videos need enrichment', enriched: 0, proxyStats });
  }

  // SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: Record<string, unknown>) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { closed = true; }
      };

      try {
        // Extract video IDs
        const videoMap = new Map<string, { dbId: number; url: string; channelName: string }>();
        for (const row of videosRes.rows) {
          const match = row.url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
          if (match) videoMap.set(match[1], { dbId: row.id, url: row.url, channelName: row.channel_name });
        }

        const allIds = Array.from(videoMap.keys());
        send({ step: 'start', total: allIds.length, proxy: proxy?.deviceId || 'none' });

        // Step 1: Fetch video details (views, likes, comments, exact date, channelId)
        let enrichedVideos = 0;
        let errors = 0;
        const channelIds = new Map<string, Set<number>>(); // channelId → Set of DB video IDs

        for (let i = 0; i < allIds.length; i += 50) {
          const batch = allIds.slice(i, i + 50);
          const batchNum = Math.floor(i / 50) + 1;
          const totalBatches = Math.ceil(allIds.length / 50);

          send({ step: 'videos', batch: batchNum, total: totalBatches, percent: Math.round((i / allIds.length) * 60) });

          try {
            const ytUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${batch.join(',')}&key=${getYtKey()}`;
            const ytRes = await fetch(ytUrl, { signal: AbortSignal.timeout(30000) });

            if (!ytRes.ok) {
              const errText = await ytRes.text();
              send({ step: 'videos', error: `YT API ${ytRes.status}: ${errText.substring(0, 80)}` });
              errors++;
              continue;
            }

            const ytData = await ytRes.json();
            for (const item of ytData.items || []) {
              const dbEntry = videoMap.get(item.id);
              if (!dbEntry) continue;

              const snippet = item.snippet || {};
              const stats = item.statistics || {};
              const publishedAt = snippet.publishedAt ? new Date(snippet.publishedAt) : null;
              const channelId = snippet.channelId;

              // Track channelId → video DB IDs for subscriber lookup
              if (channelId) {
                if (!channelIds.has(channelId)) channelIds.set(channelId, new Set());
                channelIds.get(channelId)!.add(dbEntry.dbId);
              }

              await pool.query(
                `UPDATE niche_spy_videos SET
                  enriched_at = NOW(),
                  title = COALESCE(NULLIF(title, ''), $1),
                  channel_name = COALESCE(NULLIF(channel_name, ''), $2),
                  posted_at = COALESCE($3, posted_at),
                  view_count = CASE WHEN $4 > 0 THEN $4 ELSE view_count END,
                  like_count = CASE WHEN $5 > 0 THEN $5 ELSE like_count END,
                  comment_count = CASE WHEN $6 > 0 THEN $6 ELSE comment_count END,
                  thumbnail = COALESCE(NULLIF(thumbnail, ''), $7),
                  channel_id = COALESCE(channel_id, $9)
                WHERE id = $8`,
                [
                  snippet.title || '',
                  snippet.channelTitle || '',
                  publishedAt,
                  parseInt(stats.viewCount) || 0,
                  parseInt(stats.likeCount) || 0,
                  parseInt(stats.commentCount) || 0,
                  snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || '',
                  dbEntry.dbId,
                  channelId || null,
                ]
              );
              enrichedVideos++;
            }
          } catch (err) {
            send({ step: 'videos', error: (err as Error).message?.substring(0, 80) });
            errors++;
          }
        }

        send({ step: 'videos', done: true, enriched: enrichedVideos, errors });

        // Step 2: Fetch channel subscriber counts
        const uniqueChannelIds = Array.from(channelIds.keys());
        let enrichedChannels = 0;

        if (uniqueChannelIds.length > 0) {
          send({ step: 'channels', total: uniqueChannelIds.length, percent: 60 });

          for (let i = 0; i < uniqueChannelIds.length; i += 50) {
            const batch = uniqueChannelIds.slice(i, i + 50);
            const batchNum = Math.floor(i / 50) + 1;
            const totalBatches = Math.ceil(uniqueChannelIds.length / 50);

            send({ step: 'channels', batch: batchNum, total: totalBatches, percent: 60 + Math.round((i / uniqueChannelIds.length) * 40) });

            try {
              const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${batch.join(',')}&key=${getYtKey()}`;
              const chRes = await fetch(chUrl, { signal: AbortSignal.timeout(30000) });

              if (!chRes.ok) {
                send({ step: 'channels', error: `YT API ${chRes.status}` });
                continue;
              }

              const chData = await chRes.json();
              for (const ch of chData.items || []) {
                const subCount = parseInt(ch.statistics?.subscriberCount) || 0;
                const channelCreatedAt = ch.snippet?.publishedAt ? new Date(ch.snippet.publishedAt) : null;
                const avatar = ch.snippet?.thumbnails?.default?.url || ch.snippet?.thumbnails?.medium?.url || '';

                const videoIds = channelIds.get(ch.id);
                if (!videoIds) continue;

                for (const dbId of videoIds) {
                  await pool.query(
                    `UPDATE niche_spy_videos SET
                      subscriber_count = CASE WHEN $1 > 0 THEN $1 ELSE subscriber_count END,
                      channel_created_at = COALESCE($2, channel_created_at),
                      channel_avatar = COALESCE(NULLIF($4, ''), channel_avatar)
                    WHERE id = $3`,
                    [subCount, channelCreatedAt, dbId, avatar]
                  );
                }
                if (subCount > 0 || channelCreatedAt) enrichedChannels++;
              }
            } catch (err) {
              send({ step: 'channels', error: (err as Error).message?.substring(0, 80) });
            }
          }

          send({ step: 'channels', done: true, enriched: enrichedChannels });
        }

        send({
          step: 'complete',
          enrichedVideos,
          enrichedChannels,
          errors,
          proxy: proxy?.deviceId || 'none',
          proxyStats,
        });
      } catch (err) {
        send({ step: 'error', error: (err as Error).message });
      } finally {
        if (!closed) try { controller.close(); } catch { /* */ }
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}

/**
 * GET /api/niche-spy/enrich?keyword=X
 * Check how many videos need enrichment.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const keyword = req.nextUrl.searchParams.get('keyword');

  const conditions = [
    '(enriched_at IS NULL OR like_count IS NULL OR like_count = 0 OR subscriber_count IS NULL OR subscriber_count = 0)',
  ];
  const params: string[] = [];
  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $1`);
    params.push(keyword);
  }

  const res = await pool.query(
    `SELECT COUNT(*) as need_enrichment,
            COUNT(*) FILTER (WHERE enriched_at IS NULL) as never_enriched,
            COUNT(*) FILTER (WHERE like_count IS NULL OR like_count = 0) as missing_likes,
            COUNT(*) FILTER (WHERE subscriber_count IS NULL OR subscriber_count = 0) as missing_subs,
            COUNT(*) FILTER (WHERE posted_at IS NULL) as missing_date
     FROM niche_spy_videos WHERE ${conditions.join(' AND ')}`,
    params
  );

  const proxyStats = await getProxyStats();
  return NextResponse.json({ ...res.rows[0], proxyStats });
}

export const maxDuration = 120;
