import { NextRequest, NextResponse } from 'next/server';
import { getLatestGlobalRun, type ClusterSortKey } from '@/lib/niche-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/niche-spy/tree-clusters
 *
 * Returns the latest L1 + L2 niche cluster set in a paginated way so
 * /niche/niches can render the first page in under a second instead
 * of waiting on the full 4k-cluster pull (which costs ~7s of DB time).
 *
 * Query params (all optional):
 *   l1Limit  number  default 100  max 500
 *   l1Offset number  default 0
 *   l2Limit  number  default 100  max 500
 *   l2Offset number  default 0
 *   sort     'videos' | 'views' | 'score'  default 'videos'
 *
 * Returns:
 *   { runId, source, status, totalVideos, numClusters, numL1, numL2,
 *     totalL1, totalL2,           ← drives "load more" stop signal
 *     clusters: [{ id, level, parentClusterId, autoLabel, label,
 *                  videoCount, avgScore, avgViews, totalViews,
 *                  topChannels, popularVideos: [...], channelCount,
 *                  uploadHistogram, opportunity, childrenCount }] }
 *
 * The page splits the cluster list at the L1/L2 boundary itself —
 * L1 rows always come first in the array (parent_cluster_id IS NULL).
 *
 * Cache: per (sort, l1Limit, l1Offset, l2Limit, l2Offset) key with a
 * 60s TTL. Subsequent loads with the same paging params are instant.
 * Cache is process-local so a Railway redeploy / scale event resets
 * it. Staleness bound = TTL because the underlying run only changes
 * on rebake.
 */

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { ts: number; body: unknown }>();

function parseIntParam(v: string | null, def: number, max: number): number {
  const n = parseInt(v ?? '');
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(n, max));
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const sortRaw = (sp.get('sort') || 'videos') as ClusterSortKey;
  const sort: ClusterSortKey =
    sortRaw === 'views' || sortRaw === 'score' ? sortRaw : 'videos';
  const l1Limit  = parseIntParam(sp.get('l1Limit'),  100, 500);
  const l1Offset = parseIntParam(sp.get('l1Offset'),   0, 100_000);
  const l2Limit  = parseIntParam(sp.get('l2Limit'),  100, 500);
  const l2Offset = parseIntParam(sp.get('l2Offset'),   0, 100_000);

  const cacheKey = `${sort}|${l1Limit}|${l1Offset}|${l2Limit}|${l2Offset}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.body, {
      headers: { 'x-tree-clusters-cache': 'hit' },
    });
  }

  let result;
  try {
    result = await getLatestGlobalRun({ l1Limit, l1Offset, l2Limit, l2Offset, sort });
  } catch (err) {
    // Always return JSON — a thrown 500 ends up as an HTML error
    // page and the client gets "Unexpected token <" / "Unexpected
    // end of JSON input" depending on what bytes leak out.
    return NextResponse.json(
      { error: (err as Error).message?.slice(0, 500) || 'unknown', clusters: [] },
      { status: 500 },
    );
  }

  if (!result.run) {
    return NextResponse.json({
      runId: null, source: null, status: null,
      totalVideos: 0, numClusters: 0, numL1: 0, numL2: 0,
      totalL1: 0, totalL2: 0, clusters: [],
    });
  }

  const all = result.clusters;
  const numL1 = all.filter(c => c.parentClusterId == null).length;
  const numL2 = all.filter(c => c.parentClusterId != null).length;

  // Strip fields the card UI doesn't read so the payload stays
  // small: rep_* (NicheClusterCard renders popularVideos, not the
  // rep video) and per-popular-video postedAt/postedDate/score
  // (also unused in the card).
  const body = {
    runId: result.run.id,
    source: result.run.source,
    status: result.run.status,
    totalVideos: result.run.totalVideos,
    numClusters: numL1 + numL2,
    numL1, numL2,
    totalL1: result.totalL1 ?? numL1,
    totalL2: result.totalL2 ?? numL2,
    clusters: all.map(c => ({
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
      popularVideos: c.popularVideos.map(p => ({
        videoId: p.videoId,
        title: p.title,
        thumbnail: p.thumbnail,
        url: p.url,
        viewCount: p.viewCount,
        channelName: p.channelName,
      })),
      channelCount: c.channelCount,
      uploadHistogram: c.uploadHistogram,
      opportunity: c.opportunity,
      childrenCount: c.childrenCount,
    })),
  };

  cache.set(cacheKey, { ts: Date.now(), body });
  // Bound cache size — distinct (sort, offset) combos can grow,
  // evict oldest when above 32 entries. 32 ≈ a few users x 3 sorts x
  // a few scroll-pages each.
  if (cache.size > 32) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }

  return NextResponse.json(body, {
    headers: { 'x-tree-clusters-cache': 'miss' },
  });
}
