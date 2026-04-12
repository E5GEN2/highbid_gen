import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/distribution?keyword=X&minScore=80
 * Returns subscriber + views distribution buckets in a single fast query.
 */
export async function GET(req: NextRequest) {
  const pool = await getPool();
  const keyword = req.nextUrl.searchParams.get('keyword') || '';
  const minScore = parseInt(req.nextUrl.searchParams.get('minScore') || '80');

  // Subscriber distribution — bucketed in SQL, returns 6 rows max
  const subsRes = await pool.query(`
    SELECT
      CASE
        WHEN subscriber_count IS NULL OR subscriber_count = 0 THEN '0'
        WHEN subscriber_count < 1000 THEN '1-1K'
        WHEN subscriber_count < 10000 THEN '1K-10K'
        WHEN subscriber_count < 100000 THEN '10K-100K'
        WHEN subscriber_count < 1000000 THEN '100K-1M'
        ELSE '1M+'
      END as bucket,
      COUNT(DISTINCT channel_name) as count
    FROM niche_spy_videos
    WHERE keyword = $1 AND score >= $2 AND channel_name IS NOT NULL
    GROUP BY bucket
  `, [keyword, minScore]);

  const subsBucketOrder = ['0', '1-1K', '1K-10K', '10K-100K', '100K-1M', '1M+'];
  const subsColors = ['#555', '#888', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444'];
  const subsDist = subsBucketOrder.map((label, i) => {
    const row = subsRes.rows.find(r => r.bucket === label);
    return { label, count: parseInt(row?.count || '0'), color: subsColors[i] };
  });

  // Views distribution — bucketed in SQL
  const viewsRes = await pool.query(`
    SELECT
      CASE
        WHEN view_count IS NULL OR view_count < 100 THEN '0-100'
        WHEN view_count < 1000 THEN '100-1K'
        WHEN view_count < 10000 THEN '1K-10K'
        WHEN view_count < 100000 THEN '10K-100K'
        WHEN view_count < 1000000 THEN '100K-1M'
        WHEN view_count < 10000000 THEN '1M-10M'
        ELSE '10M+'
      END as bucket,
      COUNT(*) as count
    FROM niche_spy_videos
    WHERE keyword = $1 AND score >= $2
    GROUP BY bucket
  `, [keyword, minScore]);

  const viewsBucketOrder = ['0-100', '100-1K', '1K-10K', '10K-100K', '100K-1M', '1M-10M', '10M+'];
  const viewsColors = ['#555', '#888', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#ec4899'];
  const viewsDist = viewsBucketOrder.map((label, i) => {
    const row = viewsRes.rows.find(r => r.bucket === label);
    return { label, count: parseInt(row?.count || '0'), color: viewsColors[i] };
  });

  // Video scatter data — 1 dot per video, X = channel subs, Y = video views
  const scatterRes = await pool.query(`
    SELECT
      id, channel_name, channel_id, subscriber_count as subs,
      view_count, score, channel_created_at,
      url as video_url, title as video_title,
      like_count, comment_count, posted_at, posted_date, keyword,
      embedded_at, top_comment
    FROM niche_spy_videos
    WHERE keyword = $1 AND score >= $2
      AND (subscriber_count > 0 OR view_count > 0)
    ORDER BY view_count DESC NULLS LAST
  `, [keyword, minScore]);

  const scatter = scatterRes.rows.map(r => {
    const createdAt = r.channel_created_at ? new Date(r.channel_created_at) : null;
    const ageDays = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86400000) : null;
    const vidMatch = r.video_url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    const thumbnail = vidMatch ? `https://img.youtube.com/vi/${vidMatch[1]}/hqdefault.jpg` : null;
    return {
      id: r.id,
      name: r.channel_name,
      channelId: r.channel_id || null,
      subs: parseInt(r.subs) || 0,
      views: parseInt(r.view_count) || 0,
      videos: 1,
      avgScore: parseInt(r.score) || 0,
      ageDays,
      videoUrl: r.video_url || null,
      videoTitle: r.video_title || null,
      thumbnail,
      likeCount: parseInt(r.like_count) || 0,
      commentCount: parseInt(r.comment_count) || 0,
      postedAt: r.posted_at || null,
      postedDate: r.posted_date || null,
      keyword: r.keyword || null,
      embeddedAt: r.embedded_at || null,
      topComment: r.top_comment || null,
    };
  });

  return NextResponse.json({ subsDist, viewsDist, scatter });
}
