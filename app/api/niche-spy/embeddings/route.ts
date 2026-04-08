import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { batchEmbed, getEmbeddingStats } from '@/lib/embeddings';

const BATCH_SIZE = 20; // Small batches — mobile proxy drops large responses
const DELAY_BETWEEN_BATCHES_MS = 1500;

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
  const totalBatches = Math.ceil(totalNeeded / BATCH_SIZE);
  const jobRes = await pool.query(
    `INSERT INTO niche_spy_embedding_jobs (status, keyword, total_needed, total_batches) VALUES ('running', $1, $2, $3) RETURNING id`,
    [keyword, totalNeeded, totalBatches]
  );
  const jobId = jobRes.rows[0].id;

  // Fire and forget — run in background
  runEmbeddingJob(jobId, keyword, limit).catch(async (err) => {
    await pool.query(
      `UPDATE niche_spy_embedding_jobs SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [(err as Error).message?.substring(0, 500), jobId]
    );
  });

  return NextResponse.json({ ok: true, status: 'started', jobId, totalNeeded, totalBatches });
}

async function runEmbeddingJob(jobId: number, keyword: string | null, limit: number) {
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

  const videosRes = await pool.query(
    `SELECT id, title FROM niche_spy_videos WHERE ${conditions.join(' AND ')} ORDER BY score DESC NULLS LAST LIMIT $${idx}`,
    params
  );

  const videos = videosRes.rows;
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < videos.length; i += BATCH_SIZE) {
    const batch = videos.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    // Update progress in DB
    await pool.query(
      `UPDATE niche_spy_embedding_jobs SET current_batch = $1, processed = $2, errors = $3 WHERE id = $4`,
      [batchNum, processed, errors, jobId]
    );

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
    } catch (err) {
      const errMsg = (err as Error).message || '';
      errors++;

      // On rate limit, wait longer then retry
      if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RATE_LIMIT')) {
        await pool.query(
          `UPDATE niche_spy_embedding_jobs SET error_message = $1 WHERE id = $2`,
          [`Rate limited at batch ${batchNum}, waiting 30s...`, jobId]
        );
        await new Promise(r => setTimeout(r, 30000)); // Wait 30s on rate limit
        i -= BATCH_SIZE; // Retry this batch
        errors--; // Don't count as error if we retry
        continue;
      }

      await pool.query(
        `UPDATE niche_spy_embedding_jobs SET error_message = $1 WHERE id = $2`,
        [errMsg.substring(0, 500), jobId]
      );
    }

    // Delay between batches to respect rate limits
    if (i + BATCH_SIZE < videos.length) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
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

  const stats = await getEmbeddingStats();

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

  return NextResponse.json({ ...stats, job, keywordStats });
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
