import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getProxyStats } from '@/lib/xgodo-proxy';
import { ytFetchViaProxy } from '@/lib/yt-proxy-fetch';
import { getYtPairForThread, getYtKeyStatus, banYtKey } from '@/lib/yt-keys';
import { fetchChannelFirstUpload } from '@/lib/yt-channel-age';
import { fetchChannelRecentUploads } from '@/lib/yt-recent-uploads';
import { upsertRecentVideos } from '@/lib/outlier-enrich';

/**
 * YouTube Data API enrichment — fire-and-forget parallel job.
 *
 * Mirrors the embedding pipeline (niche_spy_embedding_jobs): thread-pinned
 * key+proxy pairs, ban-aware rotation, shared batch queue, detailed progress
 * fields on the niche_yt_enrich_jobs row that the admin UI polls.
 */

const DEFAULT_BATCH_SIZE = 50;   // YT videos.list / channels.list cap is 50 IDs
const DEFAULT_DELAY_MS = 500;
const MAX_THREADS = 30;

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
  const indefinite = !!body.indefinite;

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

  // Count how many VIDEOS need video-level (Phase 1 + Phase 2) work
  const videoConds: string[] = [
    '(enriched_at IS NULL OR like_count IS NULL OR like_count = 0 OR subscriber_count IS NULL OR subscriber_count = 0)',
  ];
  const videoParams: (string | number)[] = [];
  let vIdx = 1;
  if (keyword && keyword !== 'all') { videoConds.push(`keyword = $${vIdx++}`); videoParams.push(keyword); }
  videoParams.push(limit);
  const videoCntRes = await pool.query(
    `SELECT COUNT(*) as cnt FROM niche_spy_videos WHERE ${videoConds.join(' AND ')} LIMIT $${vIdx}`,
    videoParams
  );
  const videoCount = Math.min(parseInt(videoCntRes.rows[0].cnt), limit);

  // Count how many CHANNELS need any channel-level work (Phase 2 refresh for
  // missing uploads_playlist_id, missing channel rows, or Phase 3 first-upload
  // walk). Independent of whether their videos need video-level work.
  const chanParams: (string | number)[] = [];
  let cIdx = 1;
  let kwJoin = '';
  if (keyword && keyword !== 'all') {
    kwJoin = `AND v.keyword = $${cIdx++}`;
    chanParams.push(keyword);
  }
  chanParams.push(limit);
  const chanCntRes = await pool.query(
    `SELECT COUNT(DISTINCT v.channel_id) as cnt
     FROM niche_spy_videos v
     LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
     WHERE v.channel_id IS NOT NULL ${kwJoin}
       AND (
         c.channel_id IS NULL
         OR c.uploads_playlist_id IS NULL
         OR (c.first_upload_at IS NULL
             AND (c.video_count IS NULL OR c.video_count <= 200)
             AND (c.last_uploads_fetched_at IS NULL OR c.last_uploads_fetched_at < NOW() - INTERVAL '14 days'))
       )
     LIMIT $${cIdx}`,
    chanParams
  );
  const channelCount = Math.min(parseInt(chanCntRes.rows[0].cnt), limit);

  // Phase 4 candidates: channels with uploads_playlist_id but <4 videos
  // in niche_spy_videos. These don't need video-level enrichment (most
  // already have a row), they need MORE rows. Counted separately so a
  // run that's only filling video gaps still kicks off.
  const vidParams2: (string | number)[] = [];
  let vIdx2 = 1;
  let vidKwJoin2 = '';
  if (keyword && keyword !== 'all') {
    vidKwJoin2 = `JOIN niche_spy_videos vk ON vk.channel_id = c.channel_id AND vk.keyword = $${vIdx2++}`;
    vidParams2.push(keyword);
  }
  vidParams2.push(limit);
  const phase4CntRes = await pool.query(`
    WITH ch_video_counts AS (
      SELECT channel_id, COUNT(*) AS cnt
      FROM niche_spy_videos
      WHERE channel_id IS NOT NULL AND channel_id != ''
      GROUP BY channel_id
    )
    SELECT COUNT(DISTINCT c.channel_id) AS cnt
    FROM niche_spy_channels c
    ${vidKwJoin2}
    LEFT JOIN ch_video_counts cvc ON cvc.channel_id = c.channel_id
    WHERE c.uploads_playlist_id IS NOT NULL
      AND COALESCE(cvc.cnt, 0) < 4
    LIMIT $${vIdx2}
  `, vidParams2);
  const phase4Count = Math.min(parseInt(phase4CntRes.rows[0].cnt), limit);

  const totalNeeded = videoCount + channelCount + phase4Count;
  if (totalNeeded === 0) {
    return NextResponse.json({ ok: true, status: 'done', message: 'Nothing needs enrichment' });
  }

  const totalBatches = Math.ceil(totalNeeded / batchSize);

  // Re-check single-flight AFTER the slow count queries above (~60s on a
  // busy DB): two near-simultaneous POSTs can both pass the early check,
  // then both insert — observed as jobs 66+67 running concurrently.
  const running2 = await pool.query(
    `SELECT id, keyword FROM niche_yt_enrich_jobs WHERE status = 'running' LIMIT 1`
  );
  if (running2.rows.length > 0) {
    return NextResponse.json({
      ok: true, status: 'already-running',
      jobId: running2.rows[0].id,
      runningKeyword: running2.rows[0].keyword,
    });
  }

  const jobRes = await pool.query(
    `INSERT INTO niche_yt_enrich_jobs (status, keyword, threads, total_needed, total_batches, indefinite, error_message)
     VALUES ('running', $1, $2, $3, $4, $5, $6) RETURNING id`,
    [keyword, threads, totalNeeded, totalBatches, indefinite, `threads=${threads} · batch=${batchSize} · starting${indefinite ? ' · indefinite' : ''}`]
  );
  const jobId = jobRes.rows[0].id;

  // Fire-and-forget. In indefinite mode, the wrapper keeps revisiting
  // pending counts and re-running the worker until the queue drains
  // for a sustained idle window or the user cancels. In one-shot mode,
  // it just runs once and exits — same as before.
  runEnrichWithIndef(jobId, keyword, limit, batchSize, threads, delayMs, indefinite).catch(async (err) => {
    await pool.query(
      `UPDATE niche_yt_enrich_jobs SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [(err as Error).message?.substring(0, 500), jobId]
    );
  });

  return NextResponse.json({ ok: true, status: 'started', jobId, totalNeeded, totalBatches, threads, indefinite });
}

/**
 * Outer wrapper. One-shot mode: just calls runEnrichJob once. Indef
 * mode: after each pass, recomputes pending counts and revives the
 * job row for another pass until cancelled or pending=0 for an
 * idle window. Each pass bumps niche_yt_enrich_jobs.loops.
 */
async function runEnrichWithIndef(
  jobId: number,
  keyword: string | null,
  limit: number,
  batchSize: number,
  threads: number,
  delayMs: number,
  indefinite: boolean,
) {
  const pool = await getPool();
  const IDLE_WINDOW_MS = 60_000;
  const PROBE_SLEEP_MS = 10_000;
  // A transient failure (DB blip, YT outage) must not kill the indefinite
  // loop permanently — retry with backoff and only give up after several
  // consecutive failed passes.
  const MAX_CONSEC_FAILURES = 5;
  let consecFailures = 0;
  let lastSawWork = Date.now();

  while (true) {
    try {
      await runEnrichJob(jobId, keyword, limit, batchSize, threads, delayMs);
      if (!indefinite) return;

      // After the pass, the job row is in 'done' / 'partial' / 'cancelled'.
      // Cancellation propagates straight out — no more passes. A pass that
      // ended in 'error' is treated like a thrown pass (retried below).
      const stat = await pool.query<{ status: string; error_message: string | null }>(
        `SELECT status, error_message FROM niche_yt_enrich_jobs WHERE id = $1`, [jobId]
      );
      const s = stat.rows[0]?.status;
      if (s === 'cancelled') return;
      if (s === 'error') throw new Error(stat.rows[0]?.error_message || 'pass ended in error status');
      consecFailures = 0;

      // Probe how much work is left. If nothing for a sustained window,
      // mark fully done and exit.
      const pending = await countPendingForEnrich(keyword, limit);
      if (pending.totalNeeded === 0) {
        if (Date.now() - lastSawWork >= IDLE_WINDOW_MS) {
          await pool.query(
            `UPDATE niche_yt_enrich_jobs SET status = 'done', completed_at = NOW(),
                error_message = COALESCE(error_message, '') || ' · idle window reached'
              WHERE id = $1`,
            [jobId],
          ).catch(() => {});
          return;
        }
        await new Promise(r => setTimeout(r, PROBE_SLEEP_MS));
        continue;
      }
      lastSawWork = Date.now();

      // Revive job row for another pass — bump loops, reset batch
      // counters and totals to reflect the fresh queue.
      const totalBatches = Math.ceil(pending.totalNeeded / batchSize);
      await pool.query(
        `UPDATE niche_yt_enrich_jobs
            SET status = 'running',
                loops = COALESCE(loops, 0) + 1,
                current_batch = 0,
                total_batches = $1,
                total_needed = $2,
                error_message = $3
          WHERE id = $4`,
        [totalBatches, pending.totalNeeded,
          `loop ${(await getLoops(jobId)) + 1} · threads=${threads} · batch=${batchSize}`, jobId],
      );
    } catch (err) {
      if (!indefinite) throw err;
      // A cancel that raced the failure still wins.
      const s = await pool.query<{ status: string }>(
        `SELECT status FROM niche_yt_enrich_jobs WHERE id = $1`, [jobId]
      ).then(r => r.rows[0]?.status).catch(() => null);
      if (s === 'cancelled') return;
      consecFailures++;
      if (consecFailures >= MAX_CONSEC_FAILURES) throw err;
      const note = `transient failure ${consecFailures}/${MAX_CONSEC_FAILURES}, retrying: ${((err as Error).message || 'unknown').substring(0, 300)}`;
      console.error(`[enrich ${jobId}] ${note}`);
      await pool.query(
        `UPDATE niche_yt_enrich_jobs SET status = 'running', error_message = $1 WHERE id = $2`,
        [note, jobId],
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 30_000 * consecFailures));
    }
  }
}

async function getLoops(jobId: number): Promise<number> {
  const pool = await getPool();
  const r = await pool.query<{ loops: number | null }>(
    `SELECT loops FROM niche_yt_enrich_jobs WHERE id = $1`, [jobId],
  );
  return r.rows[0]?.loops ?? 0;
}

/**
 * Re-run the same pre-check counting that the POST handler uses, so
 * the indef-mode wrapper can decide whether another pass is worth
 * doing. Mirrors the conditions at the top of POST exactly.
 */
async function countPendingForEnrich(
  keyword: string | null, limit: number,
): Promise<{ totalNeeded: number; videoCount: number; channelCount: number; phase4Count: number }> {
  const pool = await getPool();
  const videoConds: string[] = [
    '(enriched_at IS NULL OR like_count IS NULL OR like_count = 0 OR subscriber_count IS NULL OR subscriber_count = 0)',
  ];
  const videoParams: (string | number)[] = [];
  let vIdx = 1;
  if (keyword && keyword !== 'all') { videoConds.push(`keyword = $${vIdx++}`); videoParams.push(keyword); }
  videoParams.push(limit);
  const videoCntRes = await pool.query(
    `SELECT COUNT(*) as cnt FROM niche_spy_videos WHERE ${videoConds.join(' AND ')} LIMIT $${vIdx}`,
    videoParams,
  );
  const videoCount = Math.min(parseInt(videoCntRes.rows[0].cnt), limit);

  const chanParams: (string | number)[] = [];
  let cIdx = 1;
  let kwJoin = '';
  if (keyword && keyword !== 'all') {
    kwJoin = `AND v.keyword = $${cIdx++}`;
    chanParams.push(keyword);
  }
  chanParams.push(limit);
  const chanCntRes = await pool.query(
    `SELECT COUNT(DISTINCT v.channel_id) as cnt
     FROM niche_spy_videos v
     LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
     WHERE v.channel_id IS NOT NULL ${kwJoin}
       AND (
         c.channel_id IS NULL
         OR c.uploads_playlist_id IS NULL
         OR (c.first_upload_at IS NULL
             AND (c.video_count IS NULL OR c.video_count <= 200)
             AND (c.last_uploads_fetched_at IS NULL OR c.last_uploads_fetched_at < NOW() - INTERVAL '14 days'))
       )
     LIMIT $${cIdx}`,
    chanParams,
  );
  const channelCount = Math.min(parseInt(chanCntRes.rows[0].cnt), limit);

  // Phase 4: channels with <4 videos. Same logic as POST handler.
  const vidParams2: (string | number)[] = [];
  let vIdx2 = 1;
  let vidKwJoin2 = '';
  if (keyword && keyword !== 'all') {
    vidKwJoin2 = `JOIN niche_spy_videos vk ON vk.channel_id = c.channel_id AND vk.keyword = $${vIdx2++}`;
    vidParams2.push(keyword);
  }
  vidParams2.push(limit);
  const phase4CntRes = await pool.query(`
    WITH ch_video_counts AS (
      SELECT channel_id, COUNT(*) AS cnt
      FROM niche_spy_videos
      WHERE channel_id IS NOT NULL AND channel_id != ''
      GROUP BY channel_id
    )
    SELECT COUNT(DISTINCT c.channel_id) AS cnt
    FROM niche_spy_channels c
    ${vidKwJoin2}
    LEFT JOIN ch_video_counts cvc ON cvc.channel_id = c.channel_id
    WHERE c.uploads_playlist_id IS NOT NULL
      AND COALESCE(cvc.cnt, 0) < 4
    LIMIT $${vIdx2}
  `, vidParams2);
  const phase4Count = Math.min(parseInt(phase4CntRes.rows[0].cnt), limit);

  return { totalNeeded: videoCount + channelCount + phase4Count, videoCount, channelCount, phase4Count };
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
              -- $4/$5/$6 cast to bigint: comparing a bare param to the int literal
              -- 0 makes Postgres infer it as int4, so a video with >2.147B views
              -- overflowed the PARAMETER (not the column) and crash-looped the
              -- enricher for ~3.5 days (2026-07-14). view_count is already bigint.
              view_count = CASE WHEN $4::bigint > 0 THEN $4::bigint ELSE view_count END,
              like_count = CASE WHEN $5::bigint > 0 THEN $5::bigint ELSE like_count END,
              comment_count = CASE WHEN $6::bigint > 0 THEN $6::bigint ELSE comment_count END,
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
          ).catch(err => {
            // Defense-in-depth: a single bad-value video must not throw and crash
            // the whole 200-batch pass (that's what looped for 3.5 days). Skip it.
            console.warn('[yt-enrich] video update failed:', (err as Error).message);
          });
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

  // --- Phase 2: channel metadata refresh ---
  // Targets = channels touched by Phase 1 (new data) + any channel in our
  // videos that's missing uploads_playlist_id (old enrich runs that didn't
  // request contentDetails). Scoped by the keyword filter.
  let enrichedChannels = 0;
  const extraChanParams: (string | number)[] = [];
  let eIdx = 1;
  let extraKwJoin = '';
  if (keyword && keyword !== 'all') {
    extraKwJoin = `JOIN niche_spy_videos v ON v.channel_id = c.channel_id AND v.keyword = $${eIdx++}`;
    extraChanParams.push(keyword);
  }
  extraChanParams.push(limit);
  const missingUploadsRes = await pool.query(
    `SELECT DISTINCT c.channel_id
     FROM niche_spy_channels c
     ${extraKwJoin}
     WHERE c.uploads_playlist_id IS NULL
     LIMIT $${eIdx}`,
    extraChanParams
  );
  const extraIds: string[] = missingUploadsRes.rows.map(r => r.channel_id);
  // Also include channel_ids present on videos but missing from the channels table
  const missingKwJoin = keyword && keyword !== 'all' ? `AND v.keyword = '${keyword.replace(/'/g, "''")}'` : '';
  const orphanRes = await pool.query(
    `SELECT DISTINCT v.channel_id FROM niche_spy_videos v
     LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
     WHERE v.channel_id IS NOT NULL AND c.channel_id IS NULL ${missingKwJoin}
     LIMIT ${limit}`
  );
  for (const r of orphanRes.rows) extraIds.push(r.channel_id);
  for (const id of extraIds) channelIds.set(id, channelIds.get(id) || new Set());

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

            // Mirror to videos too, so existing UIs keep working until they migrate to JOIN.
            // Batched into ONE UPDATE (id = ANY) instead of a per-video loop: a hot channel
            // can have 1,500+ videos, and the old loop held a pool connection for that many
            // sequential round-trips. Under concurrent backfill that starved the pool and was
            // the main driver of niche_spy_channels lock contention. One statement frees the
            // connection far faster — the key win for scaling agent threads.
            const videoIds = channelIds.get(ch.id);
            if (videoIds && videoIds.size > 0) {
              await pool.query(
                `UPDATE niche_spy_videos SET
                  subscriber_count   = CASE WHEN $1::bigint > 0 THEN $1::bigint ELSE subscriber_count END,
                  channel_created_at = COALESCE($2, channel_created_at),
                  channel_avatar     = COALESCE(NULLIF($4, ''), channel_avatar)
                WHERE id = ANY($3::int[])`,
                [subCount, channelCreatedAt, Array.from(videoIds), avatar]
              );
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
  // Runs INDEPENDENTLY of Phase 1/2 — picks channels that need the walk whether
  // or not their videos needed video-level enrichment. Scoped to the keyword
  // filter when provided. Capped at the job's `limit` so we don't drain quota
  // on a single run.
  if (!(await isCancelled())) {
    const ageParams: (string | number)[] = [];
    let aIdx = 1;
    let ageKwJoin = '';
    if (keyword && keyword !== 'all') {
      ageKwJoin = `JOIN niche_spy_videos v ON v.channel_id = c.channel_id AND v.keyword = $${aIdx++}`;
      ageParams.push(keyword);
    }
    ageParams.push(limit);
    const needAgeRes = await pool.query(`
      SELECT DISTINCT c.channel_id, c.channel_created_at, c.uploads_playlist_id, c.video_count
      FROM niche_spy_channels c
      ${ageKwJoin}
      WHERE c.uploads_playlist_id IS NOT NULL
        AND c.first_upload_at IS NULL
        AND (c.video_count IS NULL OR c.video_count > 0)
        AND (c.video_count IS NULL OR c.video_count <= 200)
        AND (c.last_uploads_fetched_at IS NULL OR c.last_uploads_fetched_at < NOW() - INTERVAL '14 days')
      ORDER BY c.video_count ASC NULLS LAST
      LIMIT $${aIdx}
    `, ageParams);
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

  // --- Phase 4: top up channels with <4 videos in our DB ---
  // Without this step the /niche/channels grid renders sparse cards
  // (most channels show 0–1 thumbs) even though they're "fully
  // enriched" by the Phase 1/2/3 metadata pass. We pull 10 most-
  // recent uploads per under-supplied channel via fetchChannelRecent
  // Uploads + upsertRecentVideos (the same helpers the Outlier
  // Pipeline uses), so the card's 4-thumb strip can be drawn from
  // real videos.
  if (!(await isCancelled())) {
    const vidParams: (string | number)[] = [];
    let pIdx = 1;
    let vidKwJoin = '';
    if (keyword && keyword !== 'all') {
      vidKwJoin = `JOIN niche_spy_videos vk ON vk.channel_id = c.channel_id AND vk.keyword = $${pIdx++}`;
      vidParams.push(keyword);
    }
    vidParams.push(limit);
    const needVidsRes = await pool.query(`
      WITH ch_video_counts AS (
        SELECT channel_id, COUNT(*) AS cnt
        FROM niche_spy_videos
        WHERE channel_id IS NOT NULL AND channel_id != ''
        GROUP BY channel_id
      )
      SELECT DISTINCT c.channel_id, c.uploads_playlist_id, COALESCE(cvc.cnt, 0) AS vid_cnt
      FROM niche_spy_channels c
      ${vidKwJoin}
      LEFT JOIN ch_video_counts cvc ON cvc.channel_id = c.channel_id
      WHERE c.uploads_playlist_id IS NOT NULL
        AND COALESCE(cvc.cnt, 0) < 4
      ORDER BY vid_cnt ASC
      LIMIT $${pIdx}
    `, vidParams);
    const vidTargets = needVidsRes.rows as Array<{ channel_id: string; uploads_playlist_id: string; vid_cnt: number }>;

    if (vidTargets.length > 0) {
      await logProgress(`Phase 4 — pulling 10 recent uploads for ${vidTargets.length} channels with <4 videos`);
      let vidIdx = 0;

      async function vidWorker(threadId: number) {
        while (true) {
          if (await isCancelled()) break;
          const myIdx = vidIdx++;
          if (myIdx >= vidTargets.length) break;
          const t = vidTargets[myIdx];
          const pair = await getYtPairForThread(threadId - 1);
          if (!pair) break;
          try {
            const result = await fetchChannelRecentUploads(t.uploads_playlist_id, pair, { maxVideos: 10 });
            if (result.error) {
              const isRateLimited = /429|403|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(result.error);
              if (isRateLimited) banYtKey(pair.key);
              globalErrors++;
            } else if (result.videos.length > 0) {
              await upsertRecentVideos(pool, t.channel_id, result.videos);
              enrichedVideos += result.videos.length;
            }
          } catch (err) {
            console.warn('[yt-enrich] Phase 4 error:', (err as Error).message);
            globalErrors++;
          }
          await new Promise(r => setTimeout(r, Math.max(200, delayMs / 2)));
        }
      }

      const vidWorkers = Array.from({ length: Math.min(threads, vidTargets.length) }, (_, i) => vidWorker(i + 1));
      await Promise.all(vidWorkers);
      await logProgress(`Phase 4 done — pulled videos for ${vidTargets.length} channels`);
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
 *
 * "Need enrichment" counts videos that the enrich job will actually do work on:
 * either missing video-level data (enriched_at / likes / subs) OR belonging to
 * a channel that hasn't had its first_upload_at detected yet and is within the
 * Phase 3 eligibility window.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const keyword = req.nextUrl.searchParams.get('keyword');

  // Optional keyword scope for ALL counts
  const kwParam: string[] = [];
  let kwFilter = '';
  if (keyword && keyword !== 'all') { kwFilter = `AND v.keyword = $1`; kwParam.push(keyword); }

  // Per-data-point breakdown — one count per field we enrich. Each of these
  // corresponds to a single column the admin can look at and say "I know what
  // that means and which Phase fills it in".
  const videoStatsSql = `
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE v.enriched_at IS NULL) AS never_enriched,
      COUNT(*) FILTER (WHERE v.view_count IS NULL OR v.view_count = 0) AS missing_views,
      COUNT(*) FILTER (WHERE v.like_count IS NULL OR v.like_count = 0) AS missing_likes,
      COUNT(*) FILTER (WHERE v.comment_count IS NULL OR v.comment_count = 0) AS missing_comments,
      COUNT(*) FILTER (WHERE v.posted_at IS NULL) AS missing_posted_at,
      COUNT(*) FILTER (WHERE v.thumbnail IS NULL OR v.thumbnail = '') AS missing_thumbnail,
      COUNT(*) FILTER (WHERE v.channel_id IS NULL OR v.channel_id = '') AS missing_channel_id
    FROM niche_spy_videos v
    WHERE 1=1 ${kwFilter}
  `;

  // Channel-level counts — we count DISTINCT channels touching our videos
  // (scoped by keyword when given). A channel is "missing X" if the channel
  // row is absent from niche_spy_channels OR the column is NULL.
  const channelStatsSql = `
    WITH ch AS (
      SELECT DISTINCT v.channel_id AS cid
      FROM niche_spy_videos v
      WHERE v.channel_id IS NOT NULL AND v.channel_id != '' ${kwFilter}
    ),
    -- Per-channel count of how many videos we have stored. Joined
    -- to the stat row so we can flag channels with <4 videos as
    -- "needing more uploads pulled" — that's what gates whether a
    -- channel card on /niche/channels can fill its 4-thumb strip.
    ch_video_counts AS (
      SELECT channel_id, COUNT(*) AS cnt
      FROM niche_spy_videos
      WHERE channel_id IS NOT NULL AND channel_id != ''
      GROUP BY channel_id
    )
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE c.channel_id IS NULL) AS missing_row,
      COUNT(*) FILTER (WHERE c.subscriber_count IS NULL OR c.subscriber_count = 0) AS missing_subs,
      COUNT(*) FILTER (WHERE c.channel_created_at IS NULL) AS missing_created_at,
      COUNT(*) FILTER (WHERE c.uploads_playlist_id IS NULL) AS missing_playlist_id,
      COUNT(*) FILTER (WHERE c.channel_handle IS NULL) AS missing_handle,
      COUNT(*) FILTER (WHERE c.video_count IS NULL) AS missing_video_count,
      COUNT(*) FILTER (WHERE c.first_upload_at IS NULL
                         AND (c.video_count IS NULL OR c.video_count <= 200)
                         AND (c.last_uploads_fetched_at IS NULL OR c.last_uploads_fetched_at < NOW() - INTERVAL '14 days')) AS missing_first_upload,
      COUNT(*) FILTER (WHERE c.first_upload_at IS NULL AND c.video_count > 200) AS too_big_for_walk,
      COUNT(*) FILTER (WHERE c.uploads_playlist_id IS NOT NULL AND COALESCE(cvc.cnt, 0) < 4) AS need_more_videos
    FROM ch
    LEFT JOIN niche_spy_channels c ON c.channel_id = ch.cid
    LEFT JOIN ch_video_counts cvc ON cvc.channel_id = ch.cid
  `;

  const [vStats, cStats, proxyStats, jobRes, keyStatus] = await Promise.all([
    pool.query(videoStatsSql, kwParam),
    pool.query(channelStatsSql, kwParam),
    getProxyStats(),
    pool.query(`SELECT * FROM niche_yt_enrich_jobs ORDER BY started_at DESC LIMIT 1`),
    getYtKeyStatus(),
  ]);

  const v = vStats.rows[0];
  const c = cStats.rows[0];

  return NextResponse.json({
    // New structured shape
    videos: {
      total:            parseInt(v.total),
      neverEnriched:    parseInt(v.never_enriched),
      missingViews:     parseInt(v.missing_views),
      missingLikes:     parseInt(v.missing_likes),
      missingComments:  parseInt(v.missing_comments),
      missingPostedAt:  parseInt(v.missing_posted_at),
      missingThumbnail: parseInt(v.missing_thumbnail),
      missingChannelId: parseInt(v.missing_channel_id),
    },
    channels: {
      total:             parseInt(c.total),
      missingRow:        parseInt(c.missing_row),
      missingSubs:       parseInt(c.missing_subs),
      missingCreatedAt:  parseInt(c.missing_created_at),
      missingPlaylistId: parseInt(c.missing_playlist_id),
      missingHandle:     parseInt(c.missing_handle),
      missingVideoCount: parseInt(c.missing_video_count),
      missingFirstUpload: parseInt(c.missing_first_upload),
      tooBigForWalk:     parseInt(c.too_big_for_walk),
      needMoreVideos:    parseInt(c.need_more_videos),
    },
    // Back-compat for any caller still reading the flat shape
    need_enrichment:  parseInt(v.never_enriched) + parseInt(v.missing_likes) + parseInt(c.missing_subs),
    never_enriched:   parseInt(v.never_enriched),
    missing_likes:    parseInt(v.missing_likes),
    missing_subs:     parseInt(c.missing_subs),
    missing_date:     parseInt(v.missing_posted_at),
    missing_first_upload: parseInt(c.missing_first_upload),
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
