import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/similar?videoId=123&limit=20
 * Find videos with most similar title embeddings within the same keyword.
 * Uses cosine similarity on the 3072-dim embeddings.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const videoId = req.nextUrl.searchParams.get('videoId');
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '20'), 50);

  if (!videoId) {
    return NextResponse.json({ error: 'videoId required' }, { status: 400 });
  }

  // Get the source video's embedding and keyword
  const sourceRes = await pool.query(
    `SELECT id, title, keyword, title_embedding FROM niche_spy_videos WHERE id = $1`,
    [parseInt(videoId)]
  );

  if (sourceRes.rows.length === 0) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const source = sourceRes.rows[0];
  if (!source.title_embedding) {
    return NextResponse.json({ error: 'Video has no embedding. Run enrichment first.' }, { status: 400 });
  }

  // Find similar videos in the same keyword using cosine similarity
  // PostgreSQL doesn't have native vector ops, so we compute in SQL using array math
  // cosine_similarity = dot(a,b) / (|a| * |b|)
  // For normalized vectors, just dot product suffices. But our embeddings aren't normalized,
  // so we use the full formula.
  //
  // However, computing cosine similarity on 3072-dim arrays in SQL is slow.
  // Instead, fetch all embeddings for this keyword and compute in JS.

  const candidatesRes = await pool.query(
    `SELECT id, title, url, view_count, channel_name, posted_at, posted_date, score,
            subscriber_count, like_count, comment_count, top_comment, thumbnail,
            keyword, channel_created_at, title_embedding
     FROM niche_spy_videos
     WHERE keyword = $1 AND title_embedding IS NOT NULL AND id != $2
     ORDER BY score DESC NULLS LAST`,
    [source.keyword, source.id]
  );

  if (candidatesRes.rows.length === 0) {
    return NextResponse.json({ source: { id: source.id, title: source.title, keyword: source.keyword }, similar: [], message: 'No embedded videos in this niche' });
  }

  // Compute cosine similarity
  const sourceEmb: number[] = source.title_embedding;
  const sourceMag = Math.sqrt(sourceEmb.reduce((s, v) => s + v * v, 0));

  const scored = candidatesRes.rows.map(row => {
    const emb: number[] = row.title_embedding;
    let dot = 0;
    let mag = 0;
    for (let i = 0; i < emb.length; i++) {
      dot += sourceEmb[i] * emb[i];
      mag += emb[i] * emb[i];
    }
    mag = Math.sqrt(mag);
    const similarity = sourceMag > 0 && mag > 0 ? dot / (sourceMag * mag) : 0;

    return {
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
      similarity: Math.round(similarity * 10000) / 10000,
    };
  });

  // Sort by similarity descending, take top N
  scored.sort((a, b) => b.similarity - a.similarity);
  const similar = scored.slice(0, limit);

  return NextResponse.json({
    source: { id: source.id, title: source.title, keyword: source.keyword },
    similar,
    totalCandidates: candidatesRes.rows.length,
  });
}
