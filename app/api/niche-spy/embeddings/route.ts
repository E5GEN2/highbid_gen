import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import {
  batchEmbedInputs, batchEmbed, getEmbeddingStats, getKeyStatus, getKeywordCoverage,
  banKey, getLastUsedKey,
  TARGET_CONFIG, type EmbeddingTarget, type EmbedInput,
} from '@/lib/embeddings';
import { getProxyStats, getProxy } from '@/lib/xgodo-proxy';
import { upsertVector } from '@/lib/vector-db';

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_DELAY_MS = 1000;

const VALID_TARGETS: EmbeddingTarget[] = ['title_v1', 'title_v2', 'thumbnail_v2'];
function isValidTarget(t: unknown): t is EmbeddingTarget {
  return typeof t === 'string' && (VALID_TARGETS as string[]).includes(t);
}

/**
 * POST /api/niche-spy/embeddings
 * Start an embedding generation job for a specific target.
 * Body: { keyword?, limit?, batchSize?, delayMs?, threads?, target?: 'title_v1'|'title_v2'|'thumbnail_v2' }
 * Default target is 'title_v1' for backward compatibility.
 */
export async function POST(req: NextRequest) {
  const pool = await getPool();
  const body = await req.json().catch(() => ({}));
  const keyword = body.keyword || null;
  const limit = Math.min(parseInt(body.limit) || 2000, 10000);
  const batchSize = Math.min(parseInt(body.batchSize) || DEFAULT_BATCH_SIZE, 100);
  const delayMs = parseInt(body.delayMs) || DEFAULT_DELAY_MS;
  const threads = Math.min(parseInt(body.threads) || 1, 10);
  const target: EmbeddingTarget = isValidTarget(body.target) ? body.target : 'title_v1';
  const cfg = TARGET_CONFIG[target];

  // Check for a running job (single-flight across all targets). Surface the
  // mismatch clearly so the user knows they can't start another target yet.
  const running = await pool.query(
    `SELECT id, keyword, target FROM niche_spy_embedding_jobs WHERE status = 'running' LIMIT 1`
  );
  if (running.rows.length > 0) {
    const runningTarget = running.rows[0].target || 'unknown';
    if (runningTarget !== target) {
      return NextResponse.json({
        ok: false,
        status: 'another-target-running',
        runningTarget,
        requestedTarget: target,
        jobId: running.rows[0].id,
        message: `Another embedding job (${runningTarget}) is already running. Cancel it first or wait for it to finish.`,
      }, { status: 409 });
    }
    return NextResponse.json({ ok: true, status: 'already-running', jobId: running.rows[0].id, target: runningTarget });
  }

  // Count how many still need the target embedding. Thumbnails also require a
  // URL/thumbnail to fetch, so we filter accordingly.
  const conditions: string[] = [`${cfg.column} IS NULL`];
  if (target === 'thumbnail_v2') {
    conditions.push(`((thumbnail IS NOT NULL AND thumbnail != '') OR (url IS NOT NULL AND url != ''))`);
  } else {
    conditions.push(`title IS NOT NULL AND title != ''`);
  }
  const params: (string | number)[] = [];
  let idx = 1;
  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $${idx++}`);
    params.push(keyword);
  }
  params.push(limit);
  const countRes = await pool.query(
    `SELECT COUNT(*) as cnt FROM niche_spy_videos WHERE ${conditions.join(' AND ')} LIMIT $${idx}`,
    params
  );
  const totalNeeded = Math.min(parseInt(countRes.rows[0].cnt), limit);

  if (totalNeeded === 0) {
    return NextResponse.json({ ok: true, status: 'done', message: `All videos already have ${target} embedding`, target });
  }

  const totalBatches = Math.ceil(totalNeeded / batchSize);
  const jobRes = await pool.query(
    `INSERT INTO niche_spy_embedding_jobs (status, keyword, total_needed, total_batches, target, error_message)
     VALUES ('running', $1, $2, $3, $4, $5) RETURNING id`,
    [keyword, totalNeeded, totalBatches, target, `target=${target}`]
  );
  const jobId = jobRes.rows[0].id;

  runEmbeddingJob(jobId, keyword, limit, batchSize, delayMs, threads, target).catch(async (err) => {
    await pool.query(
      `UPDATE niche_spy_embedding_jobs SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [(err as Error).message?.substring(0, 500), jobId]
    );
  });

  return NextResponse.json({ ok: true, status: 'started', jobId, totalNeeded, totalBatches, target });
}

/** Resolve a thumbnail URL from a row (prefer stored thumbnail; fallback to yt hqdefault). */
function thumbnailUrlFor(row: { thumbnail: string | null; url: string | null }): string | null {
  if (row.thumbnail && row.thumbnail.trim().length > 0) return row.thumbnail;
  const m = row.url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
  return null;
}

/** Download an image and return { mimeType, base64 }. Null on failure. */
async function fetchImageBase64(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const mimeType = res.headers.get('content-type')?.split(';')[0].trim() || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    return { mimeType, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

async function runEmbeddingJob(
  jobId: number,
  keyword: string | null,
  limit: number,
  batchSize: number = DEFAULT_BATCH_SIZE,
  delayMs: number = DEFAULT_DELAY_MS,
  threads: number = 1,
  target: EmbeddingTarget = 'title_v1',
) {
  const pool = await getPool();
  const cfg = TARGET_CONFIG[target];

  const conditions: string[] = [`${cfg.column} IS NULL`];
  if (target === 'thumbnail_v2') {
    conditions.push(`((thumbnail IS NOT NULL AND thumbnail != '') OR (url IS NOT NULL AND url != ''))`);
  } else {
    conditions.push(`title IS NOT NULL AND title != ''`);
  }
  const params: (string | number)[] = [];
  let idx = 1;
  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $${idx++}`);
    params.push(keyword);
  }
  params.push(limit);

  // Priority keyword ordering (same policy as before)
  const priorityRes = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_priority_keywords'");
  const priorityKeywords = (priorityRes.rows[0]?.value || '').split('\n').map((k: string) => k.trim()).filter(Boolean);
  let orderClause = 'score DESC NULLS LAST';
  if (priorityKeywords.length > 0) {
    const cases = priorityKeywords.map((kw: string, i: number) => `WHEN keyword = '${kw.replace(/'/g, "''")}' THEN ${i}`).join(' ');
    orderClause = `CASE ${cases} ELSE 999 END, score DESC NULLS LAST`;
  }

  // Fetch the rows to embed
  const fields = target === 'thumbnail_v2' ? 'id, title, keyword, thumbnail, url' : 'id, title, keyword';
  const videosRes = await pool.query(
    `SELECT ${fields} FROM niche_spy_videos WHERE ${conditions.join(' AND ')} ORDER BY ${orderClause} LIMIT $${idx}`,
    params
  );
  const videos = videosRes.rows as Array<{ id: number; title: string; keyword: string | null; thumbnail?: string | null; url?: string | null }>;
  const totalBatches = Math.ceil(videos.length / batchSize);
  let globalProcessed = 0;
  let globalErrors = 0;
  let batchesDone = 0;

  const batches: Array<{ batchNum: number; items: typeof videos }> = [];
  for (let i = 0; i < videos.length; i += batchSize) {
    batches.push({ batchNum: batches.length + 1, items: videos.slice(i, i + batchSize) });
  }
  let batchIdx = 0;

  // Async cancellation check — only bail out on EXPLICIT terminal statuses.
  // A DB hiccup / null row / network blip should NOT kill the worker.
  async function isCancelled(): Promise<boolean> {
    try {
      const r = await pool.query(`SELECT status FROM niche_spy_embedding_jobs WHERE id = $1`, [jobId]);
      const s = r.rows[0]?.status;
      return s === 'cancelled' || s === 'error';
    } catch (err) {
      console.warn(`[embedding] cancellation check failed, continuing:`, (err as Error).message);
      return false;
    }
  }

  async function worker(threadId: number) {
    console.log(`[embedding] T${threadId} starting — target=${target}, ${batches.length} batches`);
    while (true) {
      if (await isCancelled()) {
        console.log(`[embedding] T${threadId} aborting — job ${jobId} cancelled`);
        break;
      }

      const myIdx = batchIdx++;
      if (myIdx >= batches.length) break;
      const { batchNum, items } = batches[myIdx];

      // Build inputs for this batch — for thumbnails we need to fetch + base64
      let inputs: EmbedInput[] = [];
      let droppedInBatch = 0;
      const batchStart = Date.now();
      if (target === 'thumbnail_v2') {
        // Fetch thumbnails in parallel
        const pairs = await Promise.all(items.map(async (v) => {
          const url = thumbnailUrlFor({ thumbnail: v.thumbnail ?? null, url: v.url ?? null });
          if (!url) return { video: v, input: null as EmbedInput | null };
          const img = await fetchImageBase64(url);
          if (!img) return { video: v, input: null };
          return { video: v, input: { type: 'image', mimeType: img.mimeType, data: img.data } as EmbedInput };
        }));
        // Drop items where the image couldn't be fetched — we record them as errors
        const kept = pairs.filter(p => p.input !== null);
        droppedInBatch = pairs.length - kept.length;
        globalErrors += droppedInBatch;
        // Replace items with the kept subset (aligned with inputs)
        items.length = 0;
        for (const { video } of kept) items.push(video);
        inputs = kept.map(p => p.input!) as EmbedInput[];
        console.log(`[embedding] T${threadId} batch ${batchNum}: fetched ${kept.length}/${pairs.length} thumbnails in ${Date.now() - batchStart}ms`);
      } else {
        inputs = items.map(v => ({ type: 'text', text: v.title }));
      }

      if (inputs.length === 0) {
        batchesDone++;
        await pool.query(
          `UPDATE niche_spy_embedding_jobs SET current_batch = $1, total_batches = $2, processed = $3, errors = $4, error_message = $5 WHERE id = $6`,
          [batchesDone, totalBatches, globalProcessed, globalErrors, `T${threadId} batch ${batchNum}: 0 items (all thumbnails missing)`, jobId]
        );
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      let success = false;
      for (let attempt = 0; attempt < 3 && !success; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
        // (No cancellation check inside the retry loop — the outer while-loop
        // check runs once per batch and that's enough. Checking here caused
        // races where the DB lookup threw/returned stale data and we silently
        // broke the retry without processing or recording an error.)
        try {
          const embedStart = Date.now();
          console.log(`[embedding] T${threadId} batch ${batchNum} attempt ${attempt + 1}: calling model=${cfg.model} with ${inputs.length} inputs`);
          const embeddings = await batchEmbedInputs(inputs, cfg.model, threadId - 1);
          const embedElapsed = Date.now() - embedStart;
          const lens = embeddings.map(e => e?.length || 0);
          console.log(`[embedding] T${threadId} batch ${batchNum}: got ${embeddings.length} embeddings in ${embedElapsed}ms, lengths=[${lens.join(',')}]`);

          // Google sometimes returns 200 with short / empty / zero-length
          // embeddings for content it couldn't process. Treat any of those as
          // an error so we retry rather than silently skipping.
          if (embeddings.length < inputs.length) {
            throw new Error(`Short response: got ${embeddings.length} embeddings for ${inputs.length} inputs`);
          }
          const badIdx = embeddings.findIndex(e => !e || e.length === 0);
          if (badIdx !== -1) {
            throw new Error(`Empty embedding at index ${badIdx} (lengths=[${lens.join(',')}])`);
          }

          for (let j = 0; j < items.length; j++) {
            if (embeddings[j] && embeddings[j].length > 0) {
              const arrayLiteral = `{${embeddings[j].join(',')}}`;
              await pool.query(
                `UPDATE niche_spy_videos SET ${cfg.column} = $1::real[], ${cfg.stampColumn} = NOW() WHERE id = $2`,
                [arrayLiteral, items[j].id]
              );
              // Mirror into the matching pgvector table so findSimilar can use it
              await upsertVector(
                items[j].id,
                items[j].keyword || '',
                items[j].title || '',
                embeddings[j],
                target,
              ).catch((e) => console.warn(`[embedding] upsertVector failed for id=${items[j].id}:`, (e as Error).message));
              globalProcessed++;
            }
          }
          success = true;
        } catch (err) {
          const errMsg = (err as Error).message || '';
          const isGoogleRateLimit = errMsg.includes('API 429') || errMsg.includes('"code": 429') || errMsg.includes('RESOURCE_EXHAUSTED');
          const isGoogleAuthDenied = errMsg.includes('API 403') && errMsg.includes('denied access');
          const isProxyError = errMsg.includes('curl exit') || errMsg.includes('Connection refused') || errMsg.includes('Tunnel') || errMsg.includes('socket');

          if (isGoogleRateLimit || isGoogleAuthDenied) {
            const usedKey = getLastUsedKey();
            banKey(usedKey);
            console.log(`[embedding] T${threadId} batch ${batchNum} attempt ${attempt + 1}: rate-limited/auth-denied, banned key`);
          } else if (isProxyError) {
            console.log(`[embedding] T${threadId} batch ${batchNum} attempt ${attempt + 1}: proxy error: ${errMsg.substring(0, 120)}`);
          } else {
            console.log(`[embedding] T${threadId} batch ${batchNum} attempt ${attempt + 1} error: ${errMsg.substring(0, 200)}`);
          }

          // Always log the final failure to the DB — regardless of error category.
          // Previous versions `continue`d past this on rate-limit/proxy errors so a
          // batch that hit 429 on all 3 attempts would silently "succeed" with 0
          // writes and 0 errors. That's the worst possible outcome — fail loudly.
          if (attempt === 2) {
            globalErrors++;
            const label = isGoogleRateLimit ? 'ALL KEYS RATE-LIMITED' :
                          isGoogleAuthDenied ? 'AUTH DENIED (key banned)' :
                          isProxyError       ? 'PROXY ERROR'            : 'ERROR';
            await pool.query(
              `UPDATE niche_spy_embedding_jobs SET error_message = $1 WHERE id = $2`,
              [`T${threadId} batch ${batchNum}: ${label} — ${errMsg.substring(0, 200)}`, jobId]
            );
          }
        }
      }

      batchesDone++;
      await pool.query(
        `UPDATE niche_spy_embedding_jobs SET current_batch = $1, total_batches = $2, processed = $3, errors = $4, error_message = $5 WHERE id = $6`,
        [batchesDone, totalBatches, globalProcessed, globalErrors, `target=${target} · ${threads} threads · batch ${batchesDone}/${totalBatches}`, jobId]
      );
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`[embedding] Starting ${threads} threads for ${batches.length} batches (target=${target})`);
  const workers = Array.from({ length: Math.min(threads, batches.length) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  // Only flip to done/partial if the job wasn't cancelled mid-flight.
  // 'done' requires at least one successful write; otherwise it's partial so
  // the UI highlights that nothing actually got embedded.
  await pool.query(
    `UPDATE niche_spy_embedding_jobs
        SET status = CASE WHEN status = 'cancelled' THEN 'cancelled'
                          WHEN $1 > 0 OR $2 = 0 THEN 'partial'
                          ELSE 'done' END,
            processed = $2, errors = $1, completed_at = NOW(), error_message = $3
      WHERE id = $4`,
    [globalErrors, globalProcessed, `target=${target} · ${globalProcessed} embedded, ${globalErrors} errors, ${threads} threads`, jobId]
  );
}

/**
 * GET /api/niche-spy/embeddings
 * Returns stats across all 3 embedding targets + per-keyword coverage + job progress.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const keyword = req.nextUrl.searchParams.get('keyword');

  const [stats, keyStatus, proxyStats, coverage] = await Promise.all([
    getEmbeddingStats(),
    getKeyStatus(),
    getProxyStats(),
    getKeywordCoverage(30),
  ]);
  const currentProxy = await getProxy();

  const jobRes = await pool.query(
    `SELECT * FROM niche_spy_embedding_jobs ORDER BY started_at DESC LIMIT 1`
  );
  const job = jobRes.rows[0] || null;

  let keywordStats = null;
  if (keyword && keyword !== 'all') {
    const kwRes = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE title_embedding IS NOT NULL)        AS e_title_v1,
        COUNT(*) FILTER (WHERE title_embedding_v2 IS NOT NULL)     AS e_title_v2,
        COUNT(*) FILTER (WHERE thumbnail_embedding_v2 IS NOT NULL) AS e_thumb_v2
      FROM niche_spy_videos WHERE keyword = $1
    `, [keyword]);
    keywordStats = kwRes.rows[0];
  }

  // Current admin_config for similarity source
  const simRes = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_similarity_source'");
  const similaritySource = simRes.rows[0]?.value || 'title_v1';

  return NextResponse.json({
    ...stats,
    similaritySource,
    job,
    keywordStats,
    keys: keyStatus,
    proxy: {
      ...proxyStats,
      current: currentProxy ? { deviceId: currentProxy.deviceId.substring(0, 8), networkType: currentProxy.networkType } : null,
    },
    keywordCoverage: coverage,
  });
}

/** Cancel the currently running embedding job. */
export async function DELETE() {
  const pool = await getPool();
  await pool.query(
    `UPDATE niche_spy_embedding_jobs SET status = 'cancelled', completed_at = NOW() WHERE status = 'running'`
  );
  return NextResponse.json({ ok: true });
}

export const maxDuration = 600;

// Keep the legacy batchEmbed import so admin pages that still import it compile.
// (not actually used in this file beyond types — imported via the embeddings lib)
void batchEmbed;
