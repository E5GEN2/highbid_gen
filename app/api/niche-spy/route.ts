import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy
 * Query niche spy videos with filters.
 * Params: keyword, minScore, maxScore, sort (views|score|date), limit, offset
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const sp = req.nextUrl.searchParams;

  const keyword = sp.get('keyword');
  const minScore = parseInt(sp.get('minScore') || '0');
  const maxScore = parseInt(sp.get('maxScore') || '100');
  const sort = sp.get('sort') || 'score';
  const limit = Math.min(parseInt(sp.get('limit') || '60'), 200);
  const offset = parseInt(sp.get('offset') || '0');
  const from = sp.get('from');
  const to = sp.get('to');

  // Build WHERE
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;

  if (keyword && keyword !== 'all') {
    conditions.push(`keyword = $${idx}`);
    params.push(keyword);
    idx++;
  }
  if (from) {
    conditions.push(`posted_at >= $${idx}`);
    params.push(from);
    idx++;
  }
  if (to) {
    conditions.push(`posted_at <= $${idx}`);
    params.push(to);
    idx++;
  }
  if (minScore > 0) {
    conditions.push(`score >= $${idx}`);
    params.push(minScore);
    idx++;
  }
  if (maxScore < 100) {
    conditions.push(`score <= $${idx}`);
    params.push(maxScore);
    idx++;
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Sort
  let orderBy: string;
  switch (sort) {
    case 'views': orderBy = 'view_count DESC NULLS LAST'; break;
    case 'date': orderBy = 'posted_at DESC NULLS LAST'; break;
    case 'oldest': orderBy = 'posted_at ASC NULLS LAST'; break;
    case 'likes': orderBy = 'like_count DESC NULLS LAST'; break;
    default: orderBy = 'score DESC NULLS LAST, view_count DESC NULLS LAST';
  }

  const limitIdx = idx;
  const offsetIdx = idx + 1;
  params.push(limit, offset);

  const [videosRes, countRes, keywordsRes, statsRes] = await Promise.all([
    pool.query(
      `SELECT id, keyword, url, title, view_count, channel_name, posted_date, posted_at,
              score, subscriber_count, like_count, comment_count, top_comment, thumbnail, fetched_at
       FROM niche_spy_videos ${where}
       ORDER BY ${orderBy}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*) as cnt FROM niche_spy_videos ${where}`,
      params.slice(0, -2) // exclude limit/offset
    ),
    pool.query(
      `SELECT keyword, COUNT(*) as cnt FROM niche_spy_videos
       WHERE keyword IS NOT NULL
       GROUP BY keyword ORDER BY cnt DESC`
    ),
    pool.query(
      `SELECT
         COUNT(*) as total_videos,
         COUNT(DISTINCT keyword) as total_keywords,
         COUNT(DISTINCT channel_name) as total_channels,
         ROUND(AVG(score)) as avg_score
       FROM niche_spy_videos`
    ),
  ]);

  return NextResponse.json({
    videos: videosRes.rows,
    total: parseInt(countRes.rows[0].cnt),
    keywords: keywordsRes.rows,
    stats: statsRes.rows[0],
  });
}
