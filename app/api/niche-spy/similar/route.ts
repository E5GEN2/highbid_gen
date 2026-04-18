import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { findSimilar, type EmbeddingSource } from '@/lib/vector-db';

/**
 * GET /api/niche-spy/similar?videoId=123&limit=30&source=title_v2|thumbnail_v2|combined
 *
 * source controls which embedding space the similarity search runs against:
 *   - title_v1     → legacy text embedding (gemini-embedding-001)
 *   - title_v2     → new text embedding (gemini-embedding-2-preview)
 *   - thumbnail_v2 → image embedding (gemini-embedding-2-preview)
 *   - combined     → average of title_v2 + thumbnail_v2 scores (per video)
 *
 * When source is omitted, the admin-configured default is used.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const videoId = req.nextUrl.searchParams.get('videoId');
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '30'), 500);
  const minSimilarity = parseFloat(req.nextUrl.searchParams.get('minSimilarity') || '0');
  const sourceParam = req.nextUrl.searchParams.get('source');

  if (!videoId) return NextResponse.json({ error: 'videoId required' }, { status: 400 });
  const vid = parseInt(videoId);

  const sourceReq: 'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined' | null =
    sourceParam === 'title_v1' || sourceParam === 'title_v2' || sourceParam === 'thumbnail_v2' || sourceParam === 'combined'
      ? sourceParam
      : null;

  const sourceRes = await pool.query(
    'SELECT id, title, keyword FROM niche_spy_videos WHERE id = $1',
    [vid]
  );
  if (sourceRes.rows.length === 0) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  const source = sourceRes.rows[0];

  // Run similarity — combined mode merges title_v2 + thumbnail_v2 scores
  let similar: Array<{ videoId: number; similarity: number }>;
  let effectiveSource: string;
  if (sourceReq === 'combined') {
    // Pull a wider set from both spaces so the intersection is meaningful,
    // then average similarities for videos that appear in both.
    const wideLimit = limit * 3;
    const [titleHits, thumbHits] = await Promise.all([
      findSimilar(vid, { limit: wideLimit, minSimilarity: 0, source: 'title_v2' }),
      findSimilar(vid, { limit: wideLimit, minSimilarity: 0, source: 'thumbnail_v2' }),
    ]);
    const titleMap = new Map(titleHits.map(h => [h.videoId, h.similarity]));
    const thumbMap = new Map(thumbHits.map(h => [h.videoId, h.similarity]));
    const allIds = new Set<number>([...titleMap.keys(), ...thumbMap.keys()]);
    similar = [...allIds]
      .map(id => {
        const t = titleMap.get(id);
        const th = thumbMap.get(id);
        // If only one space has the video, use that score (penalize by ~20% so
        // full-match pairs outrank single-match ones).
        const similarity = t !== undefined && th !== undefined
          ? (t + th) / 2
          : t !== undefined ? t * 0.8
          : th !== undefined ? th * 0.8
          : 0;
        return { videoId: id, similarity };
      })
      .filter(h => h.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    effectiveSource = 'combined';
  } else {
    const src: EmbeddingSource | undefined = sourceReq === null ? undefined : sourceReq;
    similar = await findSimilar(vid, { limit, minSimilarity, source: src });
    effectiveSource = src || 'admin-default';
  }

  if (similar.length === 0) {
    return NextResponse.json({
      source: { id: source.id, title: source.title, keyword: source.keyword },
      similar: [],
      similarityBasis: effectiveSource,
      message: `No similar vectors found in the ${effectiveSource} space. The source video may not be embedded there yet.`,
    });
  }

  // Fetch full video data for the matched IDs
  const ids = similar.map(s => s.videoId);
  const simMap = new Map(similar.map(s => [s.videoId, s.similarity]));

  const fullRes = await pool.query(
    `SELECT id, title, url, view_count, channel_name, posted_at, posted_date, score,
            subscriber_count, like_count, comment_count, top_comment, thumbnail,
            keyword, channel_created_at
     FROM niche_spy_videos WHERE id = ANY($1)`,
    [ids]
  );

  const results = fullRes.rows
    .map(row => ({
      id: row.id,
      title: row.title,
      url: row.url,
      viewCount: parseInt(row.view_count) || 0,
      channelName: row.channel_name,
      postedAt: row.posted_at,
      postedDate: row.posted_date,
      score: row.score,
      subscriberCount: parseInt(row.subscriber_count) || 0,
      likeCount: parseInt(row.like_count) || 0,
      commentCount: parseInt(row.comment_count) || 0,
      topComment: row.top_comment,
      thumbnail: row.thumbnail,
      keyword: row.keyword,
      channelCreatedAt: row.channel_created_at,
      similarity: simMap.get(row.id) || 0,
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return NextResponse.json({
    source: { id: source.id, title: source.title, keyword: source.keyword },
    similar: results,
    similarityBasis: effectiveSource,
    totalCandidates: similar.length,
  });
}
