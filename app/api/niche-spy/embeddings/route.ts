import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { batchEmbed, getEmbeddingStats } from '@/lib/embeddings';

/**
 * POST /api/niche-spy/embeddings
 * Generate title embeddings for videos that don't have them yet.
 * Body: { keyword?, limit?, batchSize? }
 * No auth required (debug/CLI endpoint).
 *
 * Processes in batches of 100 (Google API limit), stores in DB.
 * Returns progress report.
 */
export async function POST(req: NextRequest) {
  const pool = await getPool();
  const body = await req.json().catch(() => ({}));
  const keyword = body.keyword;
  const limit = Math.min(parseInt(body.limit) || 500, 5000);
  const batchSize = Math.min(parseInt(body.batchSize) || 100, 100);

  // Find videos needing embeddings
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
    `SELECT id, title, keyword FROM niche_spy_videos
     WHERE ${conditions.join(' AND ')}
     ORDER BY score DESC NULLS LAST
     LIMIT $${idx}`,
    params
  );

  if (videosRes.rows.length === 0) {
    const stats = await getEmbeddingStats();
    return NextResponse.json({ status: 'done', message: 'All videos already have embeddings', processed: 0, ...stats });
  }

  const videos = videosRes.rows;
  const totalToProcess = videos.length;
  let processed = 0;
  let errors = 0;
  const batchResults: Array<{ batch: number; processed: number; error?: string }> = [];

  // Process in batches
  for (let i = 0; i < videos.length; i += batchSize) {
    const batch = videos.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(videos.length / batchSize);

    try {
      const texts = batch.map(v => v.title);
      const embeddings = await batchEmbed(texts);

      // Store embeddings
      for (let j = 0; j < batch.length; j++) {
        if (embeddings[j] && embeddings[j].length > 0) {
          // Store as REAL[] using PostgreSQL array literal
          const arrayLiteral = `{${embeddings[j].join(',')}}`;
          await pool.query(
            `UPDATE niche_spy_videos SET title_embedding = $1::real[], embedded_at = NOW() WHERE id = $2`,
            [arrayLiteral, batch[j].id]
          );
          processed++;
        }
      }

      batchResults.push({ batch: batchNum, processed: batch.length });
    } catch (err) {
      const errMsg = (err as Error).message?.substring(0, 150);
      batchResults.push({ batch: batchNum, processed: 0, error: errMsg });
      errors++;

      // If quota exceeded, stop
      if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RATE_LIMIT')) {
        batchResults.push({ batch: batchNum + 1, processed: 0, error: 'Rate limited — stopping. Try again later or add more API keys.' });
        break;
      }
    }
  }

  const stats = await getEmbeddingStats();

  return NextResponse.json({
    status: errors > 0 ? 'partial' : 'done',
    totalToProcess,
    processed,
    errors,
    batches: batchResults,
    ...stats,
  });
}

/**
 * GET /api/niche-spy/embeddings
 * Get embedding stats + check how many videos need processing.
 */
export async function GET(req: NextRequest) {
  const keyword = req.nextUrl.searchParams.get('keyword');
  const pool = await getPool();

  const conditions = ["title IS NOT NULL", "title != ''"];
  const params: string[] = [];
  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $1`);
    params.push(keyword);
  }

  const res = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE title_embedding IS NOT NULL) as embedded,
      COUNT(*) FILTER (WHERE title_embedding IS NULL) as not_embedded
    FROM niche_spy_videos WHERE ${conditions.join(' AND ')}
  `, params);

  const stats = await getEmbeddingStats();

  return NextResponse.json({
    keyword: keyword || 'all',
    ...res.rows[0],
    ...stats,
  });
}

export const maxDuration = 300;
