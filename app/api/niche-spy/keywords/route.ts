import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

/**
 * GET /api/niche-spy/keywords
 * Returns keyword cards with aggregated stats for the niche selector.
 * Params: search?, sort? (videos|score|views|channels), limit?
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const sp = req.nextUrl.searchParams;
  const search = sp.get('search') || '';
  const sort = sp.get('sort') || 'videos';
  const limit = Math.min(parseInt(sp.get('limit') || '100'), 500);

  const conditions = ["keyword IS NOT NULL", "keyword != ''"];
  const params: (string | number)[] = [];
  let idx = 1;

  if (search) {
    conditions.push(`keyword ILIKE $${idx}`);
    params.push(`%${search}%`);
    idx++;
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  let orderBy: string;
  switch (sort) {
    case 'score': orderBy = 'avg_score DESC'; break;
    case 'views': orderBy = 'total_views DESC'; break;
    case 'channels': orderBy = 'channel_count DESC'; break;
    case 'newest': orderBy = 'newest_video DESC NULLS LAST'; break;
    default: orderBy = 'video_count DESC';
  }

  params.push(limit);

  const result = await pool.query(`
    SELECT
      keyword,
      COUNT(*) as video_count,
      COUNT(DISTINCT channel_name) as channel_count,
      ROUND(AVG(score)) as avg_score,
      SUM(view_count) as total_views,
      ROUND(AVG(view_count)) as avg_views,
      MAX(view_count) as max_views,
      COUNT(*) FILTER (WHERE score >= 80) as high_score_count,
      COUNT(*) FILTER (WHERE channel_created_at > NOW() - INTERVAL '180 days') as new_channel_videos,
      COUNT(DISTINCT channel_name) FILTER (WHERE channel_created_at > NOW() - INTERVAL '180 days') as new_channel_count,
      MAX(posted_at) as newest_video,
      MIN(posted_at) as oldest_video
    FROM niche_spy_videos
    ${where}
    GROUP BY keyword
    ORDER BY ${orderBy}
    LIMIT $${idx}
  `, params);

  // Also get saturation data
  const satResult = await pool.query(`
    SELECT DISTINCT ON (keyword) keyword, global_saturation_pct, run_saturation_pct
    FROM niche_saturation_runs
    ORDER BY keyword, run_at DESC
  `);
  const satMap = new Map(satResult.rows.map(r => [r.keyword, {
    globalSaturation: parseFloat(r.global_saturation_pct),
    runSaturation: parseFloat(r.run_saturation_pct),
  }]));

  return NextResponse.json({
    keywords: result.rows.map(r => ({
      keyword: r.keyword,
      videoCount: parseInt(r.video_count),
      channelCount: parseInt(r.channel_count),
      avgScore: parseInt(r.avg_score) || 0,
      totalViews: parseInt(r.total_views) || 0,
      avgViews: parseInt(r.avg_views) || 0,
      maxViews: parseInt(r.max_views) || 0,
      highScoreCount: parseInt(r.high_score_count),
      newChannelVideos: parseInt(r.new_channel_videos),
      newChannelCount: parseInt(r.new_channel_count),
      newestVideo: r.newest_video,
      oldestVideo: r.oldest_video,
      saturation: satMap.get(r.keyword) || null,
    })),
    total: result.rows.length,
  });
}

/**
 * DELETE /api/niche-spy/keywords
 * Delete a keyword and ALL associated videos, embeddings, saturation data.
 * Body: { keyword } or { keywords: string[] }
 */
export async function DELETE(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();
  const body = await req.json();
  const keywords: string[] = body.keywords || (body.keyword ? [body.keyword] : []);

  if (keywords.length === 0) {
    return NextResponse.json({ error: 'keyword or keywords[] required' }, { status: 400 });
  }

  const results: Array<{ keyword: string; videosDeleted: number; saturationDeleted: number; vectorsDeleted: number }> = [];

  for (const keyword of keywords) {
    // Count before delete
    const countRes = await pool.query('SELECT COUNT(*) as cnt FROM niche_spy_videos WHERE keyword = $1', [keyword]);
    const videoCount = parseInt(countRes.rows[0].cnt);

    // Delete videos (this also removes their embeddings from main DB)
    await pool.query('DELETE FROM niche_spy_videos WHERE keyword = $1', [keyword]);

    // Delete saturation data
    const satRes = await pool.query('DELETE FROM niche_spy_saturation WHERE keyword = $1', [keyword]);
    const satRunsRes = await pool.query('DELETE FROM niche_saturation_runs WHERE keyword = $1', [keyword]);

    // Delete vectors from pgvector DB
    let vectorsDeleted = 0;
    try {
      const { Pool: PgPool } = await import('pg');
      const vectorUrl = process.env.VECTOR_DB_URL || 'postgresql://postgres:rLcWspOFJIPFDMbJSDdNlynLgcnupOfY@gondola.proxy.rlwy.net:10303/railway';
      const vectorPool = new PgPool({ connectionString: vectorUrl, max: 2, connectionTimeoutMillis: 5000 });
      const vRes = await vectorPool.query('DELETE FROM niche_video_vectors WHERE keyword = $1', [keyword]);
      vectorsDeleted = vRes.rowCount || 0;
      await vectorPool.end();
    } catch { /* vector DB might not be available */ }

    results.push({
      keyword,
      videosDeleted: videoCount,
      saturationDeleted: (satRes.rowCount || 0) + (satRunsRes.rowCount || 0),
      vectorsDeleted,
    });
  }

  return NextResponse.json({
    deleted: results,
    totalKeywords: results.length,
    totalVideos: results.reduce((s, r) => s + r.videosDeleted, 0),
  });
}
