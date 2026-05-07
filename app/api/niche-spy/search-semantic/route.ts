import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { batchEmbedInputs, TARGET_CONFIG, type EmbeddingTarget } from '@/lib/embeddings';
import { findSimilarByVector, type EmbeddingSource } from '@/lib/vector-db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * POST /api/niche-spy/search-semantic
 *
 * Semantic-search videos by an arbitrary text query. The query gets
 * embedded once via gemini-embedding-2-preview (text-only input,
 * lands in the same 3072D space as combined_v2 video embeddings),
 * then cosine-searched across the full library.
 *
 * Queries are cached in the search_queries table — same query string
 * (case/space-normalised) reuses the cached vector instead of paying
 * the ~1s Gemini round trip again.
 *
 * Body: { query: string, limit?: number, minSimilarity?: number,
 *         source?: 'combined_v2' | 'title_v2' | 'thumbnail_v2' }
 *   query           — the text to search by (required, 2-300 chars)
 *   limit           — max results (default 60, cap 200)
 *   minSimilarity   — drop matches below this cosine similarity (default 0)
 *   source          — embedding space (default combined_v2)
 *
 * Returns: { query, source, hitFromCache, count, results: [...] }
 *   results carries the same shape as /api/niche-spy/similar so the
 *   existing similar-page grid component can render it as-is.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    query?: string;
    limit?: number;
    minSimilarity?: number;
    source?: EmbeddingSource;
  };

  const raw = (body.query || '').trim();
  if (!raw) return NextResponse.json({ error: 'query required' }, { status: 400 });
  if (raw.length > 300) return NextResponse.json({ error: 'query too long (max 300 chars)' }, { status: 400 });
  // Normalise for cache hits — collapse whitespace + lowercase. The
  // semantic embedding is robust to case and spacing so we don't need
  // to preserve exact casing for accurate results.
  const normalised = raw.toLowerCase().replace(/\s+/g, ' ');

  const limit = Math.min(Math.max(parseInt(String(body.limit ?? 60)) || 60, 1), 200);
  const minSimilarity = Math.max(0, Math.min(1, body.minSimilarity ?? 0));
  const source: EmbeddingSource = (body.source && ['title_v1', 'title_v2', 'thumbnail_v2', 'combined_v2'].includes(body.source))
    ? body.source : 'combined_v2';

  const pool = await getPool();

  // 1) Cache lookup — same normalised query + same source means the
  //    embedding is reusable. Bumps hit_count + last_seen_at.
  let embedding: number[] | null = null;
  let hitFromCache = false;
  const cached = await pool.query<{ id: number; embedding: number[] | null; source: string }>(
    `SELECT id, embedding, source FROM search_queries WHERE query = $1`,
    [normalised],
  );
  if (cached.rows.length > 0 && cached.rows[0].embedding && cached.rows[0].source === source) {
    embedding = cached.rows[0].embedding;
    hitFromCache = true;
    await pool.query(
      `UPDATE search_queries SET hit_count = hit_count + 1, last_seen_at = NOW() WHERE id = $1`,
      [cached.rows[0].id],
    );
  }

  // 2) Cache miss — embed via Gemini through the existing key+proxy
  //    rotation. The same embedding model the videos were generated
  //    with, called text-only.
  if (!embedding) {
    try {
      const target: EmbeddingTarget = source === 'title_v1' ? 'title_v1' : source;
      const cfg = TARGET_CONFIG[target];
      const embeddings = await batchEmbedInputs([{ type: 'text', text: raw }], cfg.model);
      if (embeddings.length === 0 || !embeddings[0] || embeddings[0].length === 0) {
        return NextResponse.json({ error: 'embedding returned empty vector' }, { status: 500 });
      }
      embedding = embeddings[0];
      // Upsert: same query string might race with another concurrent
      // request, so handle the conflict by reading the existing row.
      await pool.query(
        `INSERT INTO search_queries (query, embedding, source)
         VALUES ($1, $2::real[], $3)
         ON CONFLICT (query) DO UPDATE
            SET embedding = EXCLUDED.embedding,
                source = EXCLUDED.source,
                hit_count = search_queries.hit_count + 1,
                last_seen_at = NOW()`,
        [normalised, `{${embedding.join(',')}}`, source],
      );
    } catch (err) {
      return NextResponse.json({
        error: `embedding failed: ${(err as Error).message?.slice(0, 200) || 'unknown'}`,
      }, { status: 500 });
    }
  }

  // 3) Cosine search against the chosen pgvector table — no keyword
  //    scope (semantic search spans the library).
  const matches = await findSimilarByVector(embedding!, { limit, minSimilarity, source });
  if (matches.length === 0) {
    return NextResponse.json({
      query: raw, source, hitFromCache, count: 0, results: [],
      message: `No matches above ${minSimilarity} similarity in ${source} space.`,
    });
  }

  // 4) Hydrate full video data — same JOIN shape as /api/niche-spy/similar
  //    so the frontend can reuse the existing grid component.
  const ids = matches.map(m => m.videoId);
  const simMap = new Map(matches.map(m => [m.videoId, m.similarity]));
  const fullRes = await pool.query(
    `SELECT v.id, v.title, v.url, v.view_count, v.channel_name, v.posted_at, v.posted_date, v.score,
            v.subscriber_count, v.like_count, v.comment_count, v.top_comment, v.thumbnail,
            v.keyword, v.channel_created_at,
            c.first_upload_at, c.dormancy_days
       FROM niche_spy_videos v
       LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
      WHERE v.id = ANY($1::int[])`,
    [ids],
  );

  const results = fullRes.rows
    .map((row: Record<string, unknown>) => ({
      id: row.id as number,
      title: row.title as string,
      url: row.url as string,
      keyword: row.keyword as string,
      viewCount: Number(row.view_count) || 0,
      channelName: row.channel_name as string,
      postedAt: row.posted_at as string | null,
      postedDate: row.posted_date as string | null,
      score: Number(row.score) || 0,
      subscriberCount: Number(row.subscriber_count) || 0,
      likeCount: Number(row.like_count) || 0,
      commentCount: Number(row.comment_count) || 0,
      topComment: row.top_comment as string | null,
      thumbnail: row.thumbnail as string | null,
      channelCreatedAt: row.channel_created_at as string | null,
      firstUploadAt: row.first_upload_at as string | null,
      dormancyDays: row.dormancy_days as number | null,
      similarity: simMap.get(row.id as number) ?? 0,
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return NextResponse.json({
    query: raw,
    source,
    hitFromCache,
    count: results.length,
    results,
  });
}
