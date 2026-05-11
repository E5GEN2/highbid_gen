import { NextRequest, NextResponse } from 'next/server';
import { getClusterChildren, getClusterVideos } from '@/lib/niche-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/niche-spy/tree-clusters/[id]?videoLimit=60&videoOffset=0&videoSort=centroid
 *
 * Public-facing endpoint that returns one cluster's full payload:
 *   - parent (the cluster itself + rep info + ancestor breadcrumb)
 *   - children (L2 sub-clusters under this one, if any)
 *   - videos (the cluster's member videos, paginated via limit+offset)
 *
 * Drives the user-facing /niche/niches/cluster/[id] detail page.
 *
 * Query params:
 *   videoLimit  default 60, max 200
 *   videoOffset default 0 — page through large clusters
 *   videoSort   centroid | outlier | score | views | date | oldest | likes
 *   q           optional title filter (ILIKE %q%)
 *   skipChildren=1   skip the children fetch (useful for infinite-scroll
 *                    pages that already loaded children on first request)
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await ctx.params;
  const clusterId = parseInt(rawId);
  if (!clusterId) return NextResponse.json({ error: 'invalid cluster id' }, { status: 400 });

  const url = new URL(req.url);
  const videoLimit = Math.min(Math.max(parseInt(url.searchParams.get('videoLimit') ?? '60') || 60, 1), 200);
  const videoOffset = Math.max(parseInt(url.searchParams.get('videoOffset') ?? '0') || 0, 0);
  const sortRaw = url.searchParams.get('videoSort') ?? 'centroid';
  const validSorts = ['centroid', 'outlier', 'score', 'views', 'date', 'oldest', 'likes'] as const;
  const sort = (validSorts as readonly string[]).includes(sortRaw)
    ? sortRaw as typeof validSorts[number]
    : 'centroid';
  const q = url.searchParams.get('q') ?? undefined;
  const skipChildren = url.searchParams.get('skipChildren') === '1';

  // Pull children and the videos slice in parallel. Subsequent infinite-
  // scroll fetches pass skipChildren=1 to avoid re-fetching the static
  // bits — saves an N+1-ish round trip per scroll page.
  const [childrenRes, videosRes] = await Promise.all([
    skipChildren
      ? Promise.resolve({ parent: null, ancestors: [], children: [], subdivideRun: null })
      : getClusterChildren(clusterId),
    getClusterVideos({ clusterId, sort, limit: videoLimit, offset: videoOffset, q }),
  ]);

  if (!childrenRes.parent && !videosRes.parent) {
    return NextResponse.json({ error: 'cluster not found' }, { status: 404 });
  }

  const parent = childrenRes.parent || videosRes.parent;
  return NextResponse.json({
    parent,
    ancestors: childrenRes.ancestors.length > 0 ? childrenRes.ancestors : videosRes.ancestors,
    children: childrenRes.children.map(c => ({
      id: c.id,
      level: c.level,
      parentClusterId: c.parentClusterId,
      autoLabel: c.autoLabel,
      aiLabel: c.aiLabel,
      label: c.label,
      videoCount: c.videoCount,
      avgScore: c.avgScore,
      avgViews: c.avgViews,
      totalViews: c.totalViews,
      topChannels: c.topChannels,
      representativeVideoId: c.representativeVideoId,
      repTitle: c.repTitle,
      repThumbnail: c.repThumbnail,
      repUrl: c.repUrl,
      repViewCount: c.repViewCount,
      repChannelName: c.repChannelName,
      popularVideos: c.popularVideos,
      channelCount: c.channelCount,
      uploadHistogram: c.uploadHistogram,
      opportunity: c.opportunity,
      childrenCount: c.childrenCount,
    })),
    videos: videosRes.videos,
    totalVideos: videosRes.total,
    childrenCount: childrenRes.children.length,
  });
}
