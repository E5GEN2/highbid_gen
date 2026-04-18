import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getProxyStats } from '@/lib/xgodo-proxy';
import { ytFetchViaProxy } from '@/lib/yt-proxy-fetch';
import { getYtPairForThread, getYtKeyStatus, banYtKey } from '@/lib/yt-keys';
import { fetchChannelFirstUpload } from '@/lib/yt-channel-age';

/**
 * YouTube Data API enrichment — fire-and-forget parallel job.
 *
 * Mirrors the embedding pipeline (niche_spy_embedding_jobs): thread-pinned
 * key+proxy pairs, ban-aware rotation, shared batch queue, detailed progress
 * fields on the niche_yt_enrich_jobs row that the admin UI polls.
 */

const DEFAULT_BATCH_SIZE = 50;   // YT videos.list / channels.list cap is 50 IDs
const DEFAULT_DELAY_MS = 500;
const MAX_THREADS = 10;

/**
 * POST /api/niche-spy/enrich
 * Body: { keyword?, limit?, batchSize?, threads?, delayMs? }
 * Starts a background job and returns immediately with the jobId.
 */
export async function POST(req: NextRequest) {
  const pool = await getPool();
  const body = await req.json().catch(() => ({}));
  const keyword: string | null = body.keyword || null;
  const limit = Math.min(parseInt(body.limit) || 2000, 10000);
  const batchSize = Math.min(Math.max(parseInt(body.batchSize) || DEFAULT_BATCH_SIZE, 1), 50);
  const threads = Math.min(Math.max(parseInt(body.threads) || 1, 1), MAX_THREADS);
  const delayMs = parseInt(body.delayMs) || DEFAULT_DELAY_MS;

  // Need at least one YT API key configured
  const multiKeyRes = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_yt_api_keys'");
  const singleKeyRes = await pool.query("SELECT value FROM admin_config WHERE key = 'youtube_api_key'");
  const ytApiKeys = (multiKeyRes.rows[0]?.value || '')
    .split('\n').map((k: string) => k.trim()).filter((k: string) => k.length > 10);
  if (ytApiKeys.length === 0 && singleKeyRes.rows[0]?.value) ytApiKeys.push(singleKeyRes.rows[0].value);
  if (ytApiKeys.length === 0) {
    return NextResponse.json({ error: 'No YouTube API keys configured. Add them in Admin > Niche Explorer.' }, { status: 500 });
  }

  // Single-flight: refuse if another enrich job is already running
  const running = await pool.query(
    `SELECT id, keyword FROM niche_yt_enrich_jobs WHERE status = 'running' LIMIT 1`
  );
  if (running.rows.length > 0) {
    return NextResponse.json({
      ok: true, status: 'already-running',
      jobId: running.rows[0].id,
      runningKeyword: running.rows[0].keyword,
    });
  }

  // Count how many rows will actually be enriched so totals are real on job start
  const conditions: string[] = [
    '(enriched_at IS NULL OR like_count IS NULL OR like_count = 0 OR subscriber_count IS NULL OR subscriber_count = 0)',
  ];
  const params: (string | number)[] = [];
  let idx = 1;
  if (keyword && keyword !== 'all') { conditions.push(`keyword = $${idx++}`); params.push(keyword); }
  params.push(limit);
  const cntRes = await pool.query(
    `SELECT COUNT(*) as cnt FROM niche_spy_videos WHERE ${conditions.join(' AND ')} LIMIT $${idx}`,
    params
  );
  const totalNeeded = Math.min(parseInt(cntRes.rows[0].cnt), limit);
  if (totalNeeded === 0) {
    return NextResponse.json({ ok: true, status: 'done', message: 'No videos need enrichment' });
  }

  const totalBatches = Math.ceil(totalNeeded / batchSize);
  const jobRes = await pool.query(
    `INSERT INTO niche_yt_enrich_jobs (status, keyword, threads, total_needed, total_batches, error_message)
     VALUES ('running', $1, $2, $3, $4, $5) RETURNING id`,
    [keyword, threads, totalNeeded, totalBatches, `threads=${threads} · batch=${batchSize} · starting`]
  );
  const jobId = jobRes.rows[0].id;

  // Fire-and-forget — run the job in the background
  runEnrichJob(jobId, keyword, limit, batchSize, threads, delayMs).catch(async (err) => {
    await pool.query(
      `UPDATE niche_yt_enrich_jobs SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [(err as Error).message?.substring(0, 500), jobId]
    );
  });

  return NextResponse.json({ ok: true, status: 'started', jobId, totalNeeded, totalBatches, threads });
}

async function runEnrichJob(
  jobId: number,
  keyword: string | null,
  limit: number,
  batchSize: number,
  threads: number,
  delayMs: number,
) {
  const pool = await getPool();

  // Load the rows that need enrichment, ordered by score
  const conditions: string[] = [
    '(enriched_at IS NULL OR like_count IS NULL OR like_count = 0 OR subscriber_count IS NULL OR subscriber_count = 0)',
  ];
  const params: (string | number)[] = [];
  let idx = 1;
  if (keyword && keyword !== 'all') { conditions.push(`keyword = $${idx++}`); params.push(keyword); }
  params.push(limit);
  const videosRes = await pool.query(
    `SELECT id, url, channel_name FROM niche_spy_videos
     WHERE ${conditions.join(' AND ')} ORDER BY score DESC NULLS LAST LIMIT $${idx}`,
    params
  );

  // Extract YT IDs
  const videoMap = new Map<string, { dbId: number; url: string; channelName: string }>();
  for (const row of videosRes.rows) {
    const match = row.url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (match) videoMap.set(match[1], { dbId: row.id, url: row.url, channelName: row.channel_name });
  }

  const allIds = Array.from(videoMap.keys());
  const totalBatches = Math.ceil(allIds.length / batchSize);

  // Pack into a shared batch queue
  const batches: Array<{ batchNum: number; ids: string[] }> = [];
  for (let i = 0; i < allIds.length; i += batchSize) {
    batches.push({ batchNum: batches.length + 1, ids: allIds.slice(i, i + batchSize) });
  }
  let batchIdx = 0;   // shared counter, JS is single-threaded so ++ is atomic

  // Accumulators — updated atomically since we're single-threaded
  let globalProcessed = 0;
  let globalErrors = 0;
  let enrichedVideos = 0;
  let batchesDone = 0;

  // channelId → Set<dbId> — collected from video responses; used to fill subs
  const channelIds = new Map<string, Set<number>>();

  async function isCancelled(): Promise<boolean> {
    try {
      const r = await pool.query(`SELECT status FROM niche_yt_enrich_jobs WHERE id = $1`, [jobId]);
      const s = r.rows[0]?.status;
      return s === 'cancelled' || s === 'error';
    } catch { return false; }
  }

  async function logProgress(msg: string) {
    await pool.query(
      `UPDATE niche_yt_enrich_jobs
          SET current_batch = $1, total_batches = $2, processed = $3, errors = $4,
              enriched_videos = $5, error_message = $6
        WHERE id = $7`,
      [batchesDone, totalBatches, globalProcessed, globalErrors, enrichedVideos, msg, jobId]
    ).catch(() => {});
  }

  /** One video-list worker: pulls batches from the shared queue, hits YT videos.list. */
  async function videoWorker(threadId: number) {
    console.log(`[yt-enrich] T${threadId} starting — ${batches.length} video batches`);
    while (true) {
      if (await isCancelled()) { console.log(`[yt-enrich] T${threadId} aborting — cancelled`); break; }
      const myIdx = batchIdx++;
      if (myIdx >= batches.length) break;
      const { batchNum, ids } = batches[myIdx];

      let success = false;
      for (let attempt = 0; attempt < 3 && !success; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
        const pair = await getYtPairForThread(threadId - 1);
        if (!pair) { globalErrors++; break; }

        const ytUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids.join(',')}&key=${pair.key}`;
        const t0 = Date.now();
        const res = await ytFetchViaProxy(ytUrl, pair);
        const elapsed = Date.now() - t0;

        if (!res.ok) {
          const errMsg = (res.error || '').substring(0, 160);
          console.log(`[yt-enrich] T${threadId} batch ${batchNum} attempt ${attempt + 1}: YT ${res.status} ${errMsg}`);
          // Handle rate-limit & quota categories same way as embedding side
          const is429 = res.status === 429 || /quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(errMsg);
          const is403 = res.status === 403;
          const isProxy = res.status === 0 || /curl exit|Connection refused|Tunnel|socket/i.test(errMsg);
          if (is429 || is403) banYtKey(pair.key);
          if (attempt === 2) {
            globalErrors++;
            const label = is429 ? 'RATE-LIMITED' : is403 ? 'AUTH DENIED' : isProxy ? 'PROXY ERROR' : 'ERROR';
            await logProgress(`T${threadId} video batch ${batchNum}: ${label} — YT ${res.status} ${errMsg}`);
          }
          continue;
        }

        interface YtVideoItem {
          id: string;
          snippet?: { title?: string; channelTitle?: string; publishedAt?: string; channelId?: string;
            thumbnails?: { high?: { url?: string }; medium?: { url?: string } } };
          statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
        }
        const ytData = res.data as { items?: YtVideoItem[] } | null;
        const items = ytData?.items || [];
        let wroteInBatch = 0;
        for (const item of items) {
          const dbEntry = videoMap.get(item.id);
          if (!dbEntry) continue;
          const snippet = item.snippet || {};
          const stats = item.statistics || {};
          const publishedAt = snippet.publishedAt ? new Date(snippet.publishedAt) : null;
          const channelId = snippet.channelId;
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
              parseInt(stats.viewCount || '0') || 0,
              parseInt(stats.likeCount || '0') || 0,
              parseInt(stats.commentCount || '0') || 0,
              snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || '',
              dbEntry.dbId,
              channelId || null,
            ]
          );
          enrichedVideos++;
          wroteInBatch++;
        }
        globalProcessed += ids.length;
        success = true;
        console.log(`[yt-enrich] T${threadId} batch ${batchNum}: ${wroteInBatch}/${ids.length} items written in ${elapsed}ms`);
      }

      batchesDone++;
      await logProgress(`T${threadId} · ${threads} threads · video batch ${batchesDone}/${totalBatches}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Launch video workers
  console.log(`[yt-enrich] job=${jobId} starting ${threads} video workers for ${batches.length} batches`);
  const videoWorkers = Array.from({ length: Math.min(threads, batches.length) }, (_, i) => videoWorker(i + 1));
  await Promise.all(videoWorkers);

  // --- Phase 2: channel subscriber lookup (same pattern) ---
  let enrichedChannels = 0;
  const uniqueChannelIds = Array.from(channelIds.keys());
  if (uniqueChannelIds.length > 0 && !(await isCancelled())) {
    const chBatches: Array<{ batchNum: number; ids: string[] }> = [];
    for (let i = 0; i < uniqueChannelIds.length; i += batchSize) {
      chBatches.push({ batchNum: chBatches.length + 1, ids: uniqueChannelIds.slice(i, i + batchSize) });
    }
    let chBatchIdx = 0;
    const totalChBatches = chBatches.length;

    async function channelWorker(threadId: number) {
      while (true) {
        if (await isCancelled()) break;
        const myIdx = chBatchIdx++;
        if (myIdx >= chBatches.length) break;
        const { batchNum, ids } = chBatches[myIdx];

        let success = false;
        for (let attempt = 0; attempt < 3 && !success; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
          const pair = await getYtPairForThread(threadId - 1);
          if (!pair) { globalErrors++; break; }

          // Ask YT for contentDetails too — we need uploads playlist id for Phase 3
          const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&id=${ids.join(',')}&key=${pair.key}`;
          const res = await ytFetchViaProxy(chUrl, pair);
          if (!res.ok) {
            const errMsg = (res.error || '').substring(0, 160);
            const is429 = res.status === 429 || /quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(errMsg);
            const is403 = res.status === 403;
            if (is429 || is403) banYtKey(pair.key);
            if (attempt === 2) {
              globalErrors++;
              await logProgress(`T${threadId} channel batch ${batchNum}: YT ${res.status} ${errMsg}`);
            }
            continue;
          }

          interface YtChannelItem {
            id: string;
            snippet?: { title?: string; publishedAt?: string; customUrl?: string;
              thumbnails?: { default?: { url?: string }; medium?: { url?: string } } };
            statistics?: { subscriberCount?: string; videoCount?: string };
            contentDetails?: { relatedPlaylists?: { uploads?: string } };
          }
          const chData = res.data as { items?: YtChannelItem[] } | null;
          for (const ch of chData?.items || []) {
            const subCount = parseInt(ch.statistics?.subscriberCount || '0') || 0;
            const videoCount = parseInt(ch.statistics?.videoCount || '0') || 0;
            const channelCreatedAt = ch.snippet?.publishedAt ? new Date(ch.snippet.publishedAt) : null;
            const avatar = ch.snippet?.thumbnails?.default?.url || ch.snippet?.thumbnails?.medium?.url || '';
            const channelName = ch.snippet?.title || null;
            const handle = ch.snippet?.customUrl || null;
            const uploadsId = ch.contentDetails?.relatedPlaylists?.uploads || null;

            // Upsert into the channels table — single source of truth for channel metadata
            await pool.query(`
              INSERT INTO niche_spy_channels
                (channel_id, channel_name, channel_handle, channel_avatar,
                 subscriber_count, channel_created_at, video_count, uploads_playlist_id,
                 last_channel_fetched_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
              ON CONFLICT (channel_id) DO UPDATE SET
                channel_name   = COALESCE(NULLIF(EXCLUDED.channel_name, ''),   niche_spy_channels.channel_name),
                channel_handle = COALESCE(NULLIF(EXCLUDED.channel_handle, ''), niche_spy_channels.channel_handle),
                channel_avatar = COALESCE(NULLIF(EXCLUDED.channel_avatar, ''), niche_spy_channels.channel_avatar),
                subscriber_count   = CASE WHEN EXCLUDED.subscriber_count > 0 THEN EXCLUDED.subscriber_count ELSE niche_spy_channels.subscriber_count END,
                channel_created_at = COALESCE(EXCLUDED.channel_created_at,    niche_spy_channels.channel_created_at),
                video_count        = CASE WHEN EXCLUDED.video_count > 0 THEN EXCLUDED.video_count ELSE niche_spy_channels.video_count END,
                uploads_playlist_id = COALESCE(EXCLUDED.uploads_playlist_id,  niche_spy_channels.uploads_playlist_id),
                last_channel_fetched_at = NOW()
            `, [ch.id, channelName, handle, avatar, subCount, channelCreatedAt, videoCount, uploadsId]).catch(err => {
              console.warn('[yt-enrich] channel upsert failed:', (err as Error).message);
            });

            // Mirror to videos too, so existing UIs keep working until they migrate to JOIN
            const videoIds = channelIds.get(ch.id);
            if (videoIds) {
              for (const dbId of videoIds) {
                await pool.query(
                  `UPDATE niche_spy_videos SET
                    subscriber_count   = CASE WHEN $1 > 0 THEN $1 ELSE subscriber_count END,
                    channel_created_at = COALESCE($2, channel_created_at),
                    channel_avatar     = COALESCE(NULLIF($4, ''), channel_avatar)
                  WHERE id = $3`,
                  [subCount, channelCreatedAt, dbId, avatar]
                );
              }
            }
            if (subCount > 0 || channelCreatedAt) enrichedChannels++;
          }
          success = true;
        }

        await pool.query(
          `UPDATE niche_yt_enrich_jobs SET enriched_channels = $1, error_message = $2 WHERE id = $3`,
          [enrichedChannels, `T${threadId} · channel batch ${batchNum}/${totalChBatches}`, jobId]
        ).catch(() => {});
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    console.log(`[yt-enrich] job=${jobId} starting ${threads} channel workers for ${chBatches.length} batches`);
    const chWorkers = Array.from({ length: Math.min(threads, chBatches.length) }, (_, i) => channelWorker(i + 1));
    await Promise.all(chWorkers);
  }

  // --- Phase 3: uploads-playlist walk for channels missing first_upload_at ---
  // Picks any channels in our niche_spy_channels table that touched this job AND
  // have no first_upload_at yet. Walks their uploads playlists in parallel to find
  // the real first-upload date. Quota cost is ~ceil(videoCount/50) per channel;
  // channels with >200 uploads are skipped (almost always legitimate).
  if (!(await isCancelled())) {
    const needAgeRes = await pool.query(`
      SELECT channel_id, channel_created_at, uploads_playlist_id, video_count
      FROM niche_spy_channels
      WHERE channel_id = ANY($1::text[])
        AND first_upload_at IS NULL
        AND uploads_playlist_id IS NOT NULL
        AND (video_count IS NULL OR video_count > 0)
        AND (last_uploads_fetched_at IS NULL OR last_uploads_fetched_at < NOW() - INTERVAL '14 days')
      ORDER BY video_count ASC NULLS LAST
    `, [Array.from(channelIds.keys())]);
    const ageTargets = needAgeRes.rows as Array<{
      channel_id: string; channel_created_at: string | null;
      uploads_playlist_id: string; video_count: number | null;
    }>;

    if (ageTargets.length > 0) {
      await logProgress(`Phase 3 — checking first-upload for ${ageTargets.length} channels`);
      let ageIdx = 0;

      async function ageWorker(threadId: number) {
        while (true) {
          if (await isCancelled()) break;
          const myIdx = ageIdx++;
          if (myIdx >= ageTargets.length) break;
          const t = ageTargets[myIdx];
          const pair = await getYtPairForThread(threadId - 1);
          if (!pair) break;
          try {
            const r = await fetchChannelFirstUpload(
              t.channel_created_at,
              t.uploads_playlist_id,
              t.video_count || 0,
              pair,
              { skipOverVideoCount: 200 },
            );
            await pool.query(`
              UPDATE niche_spy_channels SET
                first_upload_at  = COALESCE($1, first_upload_at),
                latest_upload_at = COALESCE($2, latest_upload_at),
                dormancy_days    = COALESCE($3, dormancy_days),
                last_uploads_fetched_at = NOW(),
                error_message    = $4
              WHERE channel_id = $5
            `, [r.firstUploadAt, r.latestUploadAt, r.dormancyDays, r.error || null, t.channel_id]);
            if (r.error) globalErrors++;
          } catch (err) {
            console.warn('[yt-enrich] Phase 3 error:', (err as Error).message);
            globalErrors++;
          }
          // Give other work a chance + stay under rate limits
          await new Promise(r => setTimeout(r, Math.max(200, delayMs / 2)));
        }
      }

      const ageWorkers = Array.from({ length: Math.min(threads, ageTargets.length) }, (_, i) => ageWorker(i + 1));
      await Promise.all(ageWorkers);
      await logProgress(`Phase 3 done — checked ${ageTargets.length} channels`);
    }
  }

  // Final status
  await pool.query(
    `UPDATE niche_yt_enrich_jobs
        SET status = CASE WHEN status = 'cancelled' THEN 'cancelled'
                          WHEN $1 > 0 THEN 'partial'
                          ELSE 'done' END,
            processed = $2, errors = $1,
            enriched_videos = $3, enriched_channels = $4,
            completed_at = NOW(),
            error_message = $5
      WHERE id = $6`,
    [globalErrors, globalProcessed, enrichedVideos, enrichedChannels,
     `Done: ${enrichedVideos} videos, ${enrichedChannels} channels, ${globalErrors} errors, ${threads} threads`, jobId]
  );
}

/**
 * GET /api/niche-spy/enrich?keyword=X
 * Returns counts + current job progress + key + proxy status.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const keyword = req.nextUrl.searchParams.get('keyword');

  const conditions = [
    '(enriched_at IS NULL OR like_count IS NULL OR like_count = 0 OR subscriber_count IS NULL OR subscriber_count = 0)',
  ];
  const params: string[] = [];
  if (keyword && keyword !== 'all') { conditions.push(`keyword = $1`); params.push(keyword); }

  const [statsRes, proxyStats, jobRes, keyStatus] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) as need_enrichment,
              COUNT(*) FILTER (WHERE enriched_at IS NULL) as never_enriched,
              COUNT(*) FILTER (WHERE like_count IS NULL OR like_count = 0) as missing_likes,
              COUNT(*) FILTER (WHERE subscriber_count IS NULL OR subscriber_count = 0) as missing_subs,
              COUNT(*) FILTER (WHERE posted_at IS NULL) as missing_date
       FROM niche_spy_videos WHERE ${conditions.join(' AND ')}`,
      params
    ),
    getProxyStats(),
    pool.query(`SELECT * FROM niche_yt_enrich_jobs ORDER BY started_at DESC LIMIT 1`),
    getYtKeyStatus(),
  ]);

  return NextResponse.json({
    ...statsRes.rows[0],
    proxyStats,
    job: jobRes.rows[0] || null,
    keys: keyStatus,
  });
}

/** DELETE — cancel the currently running enrich job. */
export async function DELETE() {
  const pool = await getPool();
  await pool.query(
    `UPDATE niche_yt_enrich_jobs SET status = 'cancelled', completed_at = NOW() WHERE status = 'running'`
  );
  return NextResponse.json({ ok: true });
}

export const maxDuration = 120;
