import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { batchEmbed, getEmbeddingStats, getKeyStatus, banKey, getLastUsedKey } from '@/lib/embeddings';
import { getProxyStats, getProxy } from '@/lib/xgodo-proxy';

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_DELAY_MS = 1000;

/**
 * POST /api/niche-spy/embeddings
 * Start embedding generation job. Fire-and-forget with DB progress.
 * Body: { keyword?, limit? }
 */
export async function POST(req: NextRequest) {
  const pool = await getPool();
  const body = await req.json().catch(() => ({}));
  const keyword = body.keyword || null;
  const limit = Math.min(parseInt(body.limit) || 2000, 10000);
  const batchSize = Math.min(parseInt(body.batchSize) || DEFAULT_BATCH_SIZE, 100);
  const delayMs = parseInt(body.delayMs) || DEFAULT_DELAY_MS;

  // Check if a job is already running
  const running = await pool.query(
    `SELECT id FROM niche_spy_embedding_jobs WHERE status = 'running' LIMIT 1`
  );
  if (running.rows.length > 0) {
    return NextResponse.json({ ok: true, status: 'already-running', jobId: running.rows[0].id });
  }

  // Count how many need embedding
  const conditions = ["title IS NOT NULL", "title != ''", "title_embedding IS NULL"];
  const params: (string | number)[] = [];
  let idx = 1;
  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $${idx}`);
    params.push(keyword);
    idx++;
  }
  params.push(limit);
  const countRes = await pool.query(
    `SELECT COUNT(*) as cnt FROM niche_spy_videos WHERE ${conditions.join(' AND ')} LIMIT $${idx}`,
    params
  );
  const totalNeeded = Math.min(parseInt(countRes.rows[0].cnt), limit);

  if (totalNeeded === 0) {
    return NextResponse.json({ ok: true, status: 'done', message: 'All videos already embedded', ...await getEmbeddingStats() });
  }

  // Create job record
  const totalBatches = Math.ceil(totalNeeded / batchSize);
  const jobRes = await pool.query(
    `INSERT INTO niche_spy_embedding_jobs (status, keyword, total_needed, total_batches) VALUES ('running', $1, $2, $3) RETURNING id`,
    [keyword, totalNeeded, totalBatches]
  );
  const jobId = jobRes.rows[0].id;

  // Fire and forget — run in background
  runEmbeddingJob(jobId, keyword, limit, batchSize, delayMs).catch(async (err) => {
    await pool.query(
      `UPDATE niche_spy_embedding_jobs SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [(err as Error).message?.substring(0, 500), jobId]
    );
  });

  return NextResponse.json({ ok: true, status: 'started', jobId, totalNeeded, totalBatches });
}

async function runEmbeddingJob(jobId: number, keyword: string | null, limit: number, batchSize: number = DEFAULT_BATCH_SIZE, delayMs: number = DEFAULT_DELAY_MS) {
  const pool = await getPool();

  const conditions = ["title IS NOT NULL", "title != ''", "title_embedding IS NULL"];
  const params: (string | number)[] = [];
  let idx = 1;
  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $${idx}`);
    params.push(keyword);
    idx++;
  }
  params.push(limit);

  // Get priority keywords from config
  const priorityRes = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_priority_keywords'");
  const priorityKeywords = (priorityRes.rows[0]?.value || '').split('\n').map((k: string) => k.trim()).filter(Boolean);

  // Order: priority keywords first (by their order), then rest by score
  let orderClause = 'score DESC NULLS LAST';
  if (priorityKeywords.length > 0) {
    // CASE WHEN keyword IN (...) THEN position ELSE 999 END, score DESC
    const cases = priorityKeywords.map((kw: string, i: number) => `WHEN keyword = '${kw.replace(/'/g, "''")}' THEN ${i}`).join(' ');
    orderClause = `CASE ${cases} ELSE 999 END, score DESC NULLS LAST`;
  }

  const videosRes = await pool.query(
    `SELECT id, title, keyword FROM niche_spy_videos WHERE ${conditions.join(' AND ')} ORDER BY ${orderClause} LIMIT $${idx}`,
    params
  );

  const videos = videosRes.rows;
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < videos.length; i += batchSize) {
    const batch = videos.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    // Update progress in DB — include which key+proxy will be used
    const nextKey = await import('@/lib/embeddings').then(m => m.getKeyStatus());
    const nextProxy = await import('@/lib/xgodo-proxy').then(m => m.getProxy());
    const activeKey = nextKey.find(k => !k.banned)?.key || 'all banned';
    await pool.query(
      `UPDATE niche_spy_embedding_jobs SET current_batch = $1, processed = $2, errors = $3, error_message = $4 WHERE id = $5`,
      [batchNum, processed, errors, `key=${activeKey} proxy=${nextProxy?.deviceId?.substring(0, 8) || 'none'}`, jobId]
    );

    try {
      // Retry up to 3 times per batch
      let success = false;
      for (let attempt = 0; attempt < 3 && !success; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 3000 * attempt));
        try {
          const texts = batch.map(v => v.title);
          const embeddings = await batchEmbed(texts);
          for (let j = 0; j < batch.length; j++) {
            if (embeddings[j] && embeddings[j].length > 0) {
              const arrayLiteral = `{${embeddings[j].join(',')}}`;
              await pool.query(
                `UPDATE niche_spy_videos SET title_embedding = $1::real[], embedded_at = NOW() WHERE id = $2`,
                [arrayLiteral, batch[j].id]
              );
              processed++;
            }
          }
          success = true;
        } catch (retryErr) {
          if (attempt < 2) continue; // retry
          throw retryErr; // give up after 3 attempts
        }
      }
    } catch (err) {
      const errMsg = (err as Error).message || '';
      errors++;

      // Only ban key on ACTUAL Google API rate limit/auth errors, NOT proxy failures
      const isGoogleRateLimit = errMsg.includes('API 429') || errMsg.includes('"code": 429') || errMsg.includes('RESOURCE_EXHAUSTED');
      const isGoogleAuthDenied = errMsg.includes('API 403') && errMsg.includes('denied access');
      const isProxyError = errMsg.includes('curl exit') || errMsg.includes('Connection refused') || errMsg.includes('Tunnel') || errMsg.includes('socket');

      if (isGoogleRateLimit) {
        const usedKey = getLastUsedKey();
        banKey(usedKey);
        await pool.query(
          `UPDATE niche_spy_embedding_jobs SET error_message = $1 WHERE id = $2`,
          [`Rate limited — banned key ${usedKey.substring(0,10)}..., switching to next`, jobId]
        );
        await new Promise(r => setTimeout(r, 2000));
        i -= batchSize;
        errors--;
        continue;
      }

      if (isGoogleAuthDenied) {
        const usedKey = getLastUsedKey();
        banKey(usedKey);
        await pool.query(
          `UPDATE niche_spy_embedding_jobs SET error_message = $1 WHERE id = $2`,
          [`Key denied (403) — banned ${usedKey.substring(0,10)}..., switching`, jobId]
        );
        await new Promise(r => setTimeout(r, 1000));
        i -= batchSize;
        errors--;
        continue;
      }

      if (isProxyError) {
        // Proxy failure — retry with different proxy, don't ban key
        await pool.query(
          `UPDATE niche_spy_embedding_jobs SET error_message = $1 WHERE id = $2`,
          [`Proxy error, retrying... ${errMsg.substring(0, 80)}`, jobId]
        );
        await new Promise(r => setTimeout(r, 2000));
        i -= batchSize;
        errors--;
        continue;
      }

      await pool.query(
        `UPDATE niche_spy_embedding_jobs SET error_message = $1 WHERE id = $2`,
        [errMsg.substring(0, 500), jobId]
      );
    }

    // Delay between batches to respect rate limits
    if (i + batchSize < videos.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Job complete
  await pool.query(
    `UPDATE niche_spy_embedding_jobs SET status = $1, processed = $2, errors = $3, completed_at = NOW() WHERE id = $4`,
    [errors > 0 ? 'partial' : 'done', processed, errors, jobId]
  );
}

/**
 * GET /api/niche-spy/embeddings
 * Get stats + current job progress.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const keyword = req.nextUrl.searchParams.get('keyword');

  const [stats, keyStatus, proxyStats] = await Promise.all([
    getEmbeddingStats(),
    getKeyStatus(),
    getProxyStats(),
  ]);
  const currentProxy = await getProxy();

  // Get current/latest job
  const jobRes = await pool.query(
    `SELECT * FROM niche_spy_embedding_jobs ORDER BY started_at DESC LIMIT 1`
  );
  const job = jobRes.rows[0] || null;

  // Per-keyword stats if requested
  let keywordStats = null;
  if (keyword && keyword !== 'all') {
    const kwRes = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE title_embedding IS NOT NULL) as embedded,
        COUNT(*) FILTER (WHERE title_embedding IS NULL AND title IS NOT NULL AND title != '') as not_embedded
      FROM niche_spy_videos WHERE keyword = $1
    `, [keyword]);
    keywordStats = kwRes.rows[0];
  }

  // Per-keyword embedding coverage (top 20 by video count)
  const kwCoverage = await pool.query(`
    SELECT keyword,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE title_embedding IS NOT NULL) as embedded,
      ROUND(COUNT(*) FILTER (WHERE title_embedding IS NOT NULL)::numeric / GREATEST(COUNT(*), 1) * 100) as pct
    FROM niche_spy_videos
    WHERE keyword IS NOT NULL
    GROUP BY keyword
    ORDER BY total DESC
    LIMIT 30
  `);

  return NextResponse.json({
    ...stats, job, keywordStats,
    keys: keyStatus,
    proxy: {
      ...proxyStats,
      current: currentProxy ? { deviceId: currentProxy.deviceId.substring(0, 8), networkType: currentProxy.networkType } : null,
    },
    keywordCoverage: kwCoverage.rows.map(r => ({
      keyword: r.keyword,
      total: parseInt(r.total),
      embedded: parseInt(r.embedded),
      pct: parseInt(r.pct),
    })),
  });
}

/**
 * DELETE /api/niche-spy/embeddings
 * Cancel running embedding job.
 */
export async function DELETE() {
  const pool = await getPool();
  await pool.query(
    `UPDATE niche_spy_embedding_jobs SET status = 'cancelled', completed_at = NOW() WHERE status = 'running'`
  );
  return NextResponse.json({ ok: true });
}

export const maxDuration = 600;
