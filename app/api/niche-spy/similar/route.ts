import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { findSimilar } from '@/lib/vector-db';

/**
 * GET /api/niche-spy/similar?videoId=123&limit=30
 * Find similar videos using pgvector cosine similarity.
 * Lightning fast — uses HNSW/IVFFlat index on the vector DB.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const videoId = req.nextUrl.searchParams.get('videoId');
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '30'), 500);

  const minSimilarity = parseFloat(req.nextUrl.searchParams.get('minSimilarity') || '0');

  if (!videoId) return NextResponse.json({ error: 'videoId required' }, { status: 400 });

  const vid = parseInt(videoId);

  const sourceRes = await pool.query(
    'SELECT id, title, keyword FROM niche_spy_videos WHERE id = $1',
    [vid]
  );
  if (sourceRes.rows.length === 0) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  const source = sourceRes.rows[0];

  // Find similar via pgvector (fast cosine similarity search)
  const similar = await findSimilar(vid, { limit, minSimilarity });

  if (similar.length === 0) {
    return NextResponse.json({
      source: { id: source.id, title: source.title, keyword: source.keyword },
      similar: [],
      message: 'No similar vectors found. Run embedding generation first.',
    });
  }

  // Fetch full video data from main DB for the similar IDs
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
    totalCandidates: similar.length,
  });
}
