import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { auth } from '@/lib/auth';

/**
 * GET /api/niche-spy/tree-clusters/[id]/fresh
 *
 * The Niche Watcher's payoff surface. Returns the videos the cheap watcher
 * has DISCOVERED in this cluster since it started watching — rows the watcher
 * inserted into niche_tree_assignments with a non-NULL assigned_at (batch
 * recluster rows leave it NULL). Newest-appeared first.
 *
 * For a logged-in user who WATCHES this cluster we also compute `isNew` per
 * video (assigned_at > the user's previous visit) and then advance their
 * last-viewed watermark to now — so the NEW highlight fires exactly once,
 * "the first time you see it". Non-watchers / logged-out still see the fresh
 * list (a preview of the watcher's value) but no NEW badges.
 *
 * Rides idx_nta_cluster_fresh (cluster_id, assigned_at DESC) WHERE assigned_at
 * IS NOT NULL → an index scan of ≤limit rows regardless of cluster size.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const FRESH_LIMIT = 24;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await ctx.params;
  const clusterId = parseInt(rawId);
  if (!clusterId) return NextResponse.json({ error: 'invalid cluster id' }, { status: 400 });

  const pool = await getPool();
  const session = await auth();
  const userId = session?.user?.id ?? null;

  // Is this user watching this niche? Only watchers get NEW-badge tracking.
  let watching = false;
  let since: string | null = null;
  if (userId) {
    const w = await pool.query('SELECT 1 FROM user_niche_watches WHERE user_id = $1 AND cluster_id = $2', [userId, clusterId]);
    watching = w.rows.length > 0;
    if (watching) {
      const s = await pool.query<{ last_viewed_at: string }>(
        'SELECT last_viewed_at FROM user_niche_seen WHERE user_id = $1 AND cluster_id = $2',
        [userId, clusterId],
      );
      since = s.rows[0]?.last_viewed_at ?? null;
    }
  }

  const vres = await pool.query<{
    id: number; url: string | null; title: string | null; thumbnail: string | null;
    channel_name: string | null; view_count: number | null; like_count: number | null;
    subscriber_count: number | null; channel_created_at: string | null;
    posted_at: string | null; posted_date: string | null; score: number | null;
    assigned_at: string;
  }>(
    `SELECT v.id, v.url, v.title, v.thumbnail, v.channel_name,
            v.view_count, v.like_count, v.subscriber_count, v.channel_created_at,
            v.posted_at, v.posted_date, v.score, a.assigned_at
       FROM niche_tree_assignments a
       JOIN niche_spy_videos v ON v.id = a.video_id
      WHERE a.cluster_id = $1 AND a.assigned_at IS NOT NULL
      ORDER BY a.assigned_at DESC
      LIMIT $2`,
    [clusterId, FRESH_LIMIT],
  );

  const sinceMs = since ? new Date(since).getTime() : null;
  const videos = vres.rows.map(v => ({
    id: v.id,
    url: v.url,
    title: v.title,
    thumbnail: v.thumbnail,
    channelName: v.channel_name,
    viewCount: v.view_count,
    likeCount: v.like_count,
    subscriberCount: v.subscriber_count,
    channelCreatedAt: v.channel_created_at,
    firstUploadAt: null,
    dormancyDays: null,
    postedAt: v.posted_at,
    postedDate: v.posted_date,
    score: v.score,
    // NEW only for a watcher who has a prior watermark and this video appeared
    // after it. First-ever visit (since=null) sets a baseline and flags nothing
    // so the user isn't hit with a wall of NEW.
    isNew: watching && sinceMs != null && new Date(v.assigned_at).getTime() > sinceMs,
  }));

  const newCount = videos.filter(v => v.isNew).length;

  // Advance the watermark AFTER computing isNew — the highlight fires once.
  if (watching && userId) {
    await pool.query(
      `INSERT INTO user_niche_seen (user_id, cluster_id, last_viewed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, cluster_id) DO UPDATE SET last_viewed_at = NOW()`,
      [userId, clusterId],
    ).catch(() => {});
  }

  return NextResponse.json({ videos, watching, total: videos.length, newCount });
}
