import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/clusters/[clusterId]/videos?limit=60&offset=0&sort=score
 * Get videos belonging to a specific cluster.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ clusterId: string }> }) {
  const { clusterId } = await params;
  const pool = await getPool();
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '60'), 200);
  const offset = parseInt(req.nextUrl.searchParams.get('offset') || '0');
  const sort = req.nextUrl.searchParams.get('sort') || 'score';

  const orderMap: Record<string, string> = {
    score: 'v.score DESC NULLS LAST',
    views: 'v.view_count DESC NULLS LAST',
    date: 'v.posted_at DESC NULLS LAST',
    oldest: 'v.posted_at ASC NULLS LAST',
    likes: 'v.like_count DESC NULLS LAST',
  };
  const orderBy = orderMap[sort] || orderMap.score;

  // Count total
  const countRes = await pool.query(
    `SELECT COUNT(*) as cnt FROM niche_cluster_assignments WHERE cluster_id = $1`,
    [clusterId]
  );
  const total = parseInt(countRes.rows[0].cnt);

  // Fetch videos
  const res = await pool.query(
    `SELECT v.id, v.keyword, v.url, v.title, v.view_count, v.channel_name,
            v.posted_date, v.posted_at, v.score, v.subscriber_count, v.like_count,
            v.comment_count, v.top_comment, v.thumbnail, v.channel_created_at, v.embedded_at
     FROM niche_cluster_assignments a
     JOIN niche_spy_videos v ON v.id = a.video_id
     WHERE a.cluster_id = $1
     ORDER BY ${orderBy}
     LIMIT $2 OFFSET $3`,
    [clusterId, limit, offset]
  );

  return NextResponse.json({
    videos: res.rows,
    total,
  });
}
