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
  const q = sp.get('q')?.trim() || '';   // free-text search across title + channel

  // Build WHERE conditions in two forms — one unqualified (for count/keywords/stats
  // queries that hit only the videos table), one prefixed with v. for the joined
  // videos+channels query (needed because channel_name / subscriber_count /
  // channel_created_at / channel_avatar exist in both tables).
  const bareConditions: string[] = [];
  const joinConditions: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;
  const pushCond = (bare: string, joined: string) => {
    bareConditions.push(bare);
    joinConditions.push(joined);
  };

  if (keyword && keyword !== 'all') {
    pushCond(`keyword = $${idx}`, `v.keyword = $${idx}`);
    params.push(keyword); idx++;
  }
  if (from) {
    pushCond(`posted_at >= $${idx}`, `v.posted_at >= $${idx}`);
    params.push(from); idx++;
  }
  if (to) {
    pushCond(`posted_at <= $${idx}`, `v.posted_at <= $${idx}`);
    params.push(to); idx++;
  }
  if (minScore > 0) {
    pushCond(`score >= $${idx}`, `v.score >= $${idx}`);
    params.push(minScore); idx++;
  }
  if (maxScore < 100) {
    pushCond(`score <= $${idx}`, `v.score <= $${idx}`);
    params.push(maxScore); idx++;
  }
  if (q) {
    pushCond(
      `(title ILIKE $${idx} OR channel_name ILIKE $${idx})`,
      `(v.title ILIKE $${idx} OR v.channel_name ILIKE $${idx})`,
    );
    params.push(`%${q}%`); idx++;
  }

  const bareWhere = bareConditions.length > 0 ? 'WHERE ' + bareConditions.join(' AND ') : '';
  const joinWhere = joinConditions.length > 0 ? 'WHERE ' + joinConditions.join(' AND ') : '';

  // Sort — joined query references v., bare queries (if any used sort, none do) wouldn't
  let joinOrderBy: string;
  switch (sort) {
    case 'views':  joinOrderBy = 'v.view_count DESC NULLS LAST'; break;
    case 'date':   joinOrderBy = 'v.posted_at DESC NULLS LAST'; break;
    case 'oldest': joinOrderBy = 'v.posted_at ASC NULLS LAST'; break;
    case 'likes':  joinOrderBy = 'v.like_count DESC NULLS LAST'; break;
    default:       joinOrderBy = 'v.score DESC NULLS LAST, v.view_count DESC NULLS LAST';
  }

  const limitIdx = idx;
  const offsetIdx = idx + 1;
  params.push(limit, offset);

  const [videosRes, countRes, keywordsRes, statsRes] = await Promise.all([
    pool.query(
      // Three separate embedding timestamps exist in the schema — v1 (legacy,
      // frozen), title_v2, thumbnail_v2. The old code only returned
      // embedded_at (= v1), so the Similar button vanished for every video
      // embedded in v2 spaces. Return all three and let the client decide
      // which is relevant to the active similarity source.
      `SELECT v.id, v.keyword, v.url, v.title, v.view_count, v.channel_name,
              v.posted_date, v.posted_at, v.score, v.subscriber_count, v.like_count,
              v.comment_count, v.top_comment, v.thumbnail, v.fetched_at,
              v.channel_created_at,
              v.embedded_at,
              v.title_embedded_v2_at,
              v.thumbnail_embedded_v2_at,
              c.first_upload_at, c.dormancy_days
       FROM niche_spy_videos v
       LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
       ${joinWhere}
       ORDER BY ${joinOrderBy}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*) as cnt FROM niche_spy_videos ${bareWhere}`,
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

  // The active similarity source determines which embedded_at flag the
  // client should check to decide whether "Similar" is actionable. Pulled
  // from admin_config; defaults to title_v1 for back-compat.
  const simSrcRes = await pool.query(
    "SELECT value FROM admin_config WHERE key = 'niche_similarity_source'"
  );
  const similaritySource = (simSrcRes.rows[0]?.value || 'title_v1') as
    'title_v1' | 'title_v2' | 'thumbnail_v2';

  return NextResponse.json({
    videos: videosRes.rows,
    total: parseInt(countRes.rows[0].cnt),
    keywords: keywordsRes.rows,
    stats: statsRes.rows[0],
    similaritySource,
  });
}
