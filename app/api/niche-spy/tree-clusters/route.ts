import { NextResponse } from 'next/server';
import { getLatestGlobalRun } from '@/lib/niche-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/niche-spy/tree-clusters
 *
 * Public-facing endpoint that returns the latest L1 niche cluster set,
 * each enriched with its representative video's title/thumbnail/url and
 * 4 popular videos for the collage strip. Drives the user-facing
 * /niche/niches grid (replaces the manual keyword cards).
 *
 * Errors with empty clusters[] if no global run has finished yet.
 *
 * Cache: in-memory 60s TTL because building the response runs ~6 DB
 * queries over the full 2k-cluster set (heartbeat histograms +
 * opportunity indicators are the heaviest). Without it the page
 * skeleton hangs for ~10s on every load. Cache is per-process so a
 * Railway redeploy / scale event resets it — staleness window is
 * bounded by TTL anyway.
 */

const CACHE_TTL_MS = 60_000;
let cache: { ts: number; body: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.body, {
      headers: { 'x-tree-clusters-cache': 'hit' },
    });
  }

  let result;
  try {
    result = await getLatestGlobalRun();
  } catch (err) {
    // Always return JSON — a thrown 500 ends up as an HTML error
    // page and the client gets "Unexpected token <" / "Unexpected
    // end of JSON input" depending on what bytes leak out. Better
    // to say "we failed, here's the message" so the UI can render
    // a real error instead of a parse blowup.
    return NextResponse.json(
      { error: (err as Error).message?.slice(0, 500) || 'unknown', clusters: [] },
      { status: 500 },
    );
  }

  if (!result.run) {
    const empty = {
      runId: null, source: null, status: null,
      totalVideos: 0, numClusters: 0, numL1: 0, numL2: 0, clusters: [],
    };
    return NextResponse.json(empty);
  }

  // Return BOTH L1 and L2 so the home grid can render parents first
  // (sorted) followed by the L2 sub-niches. The page renders them in
  // two sections so users can scroll through the full tree without
  // drilling.
  const all = result.clusters;
  const numL1 = all.filter(c => c.parentClusterId == null).length;
  const numL2 = all.filter(c => c.parentClusterId != null).length;

  // Strip fields the card UI doesn't read so the 8MB-class payload
  // stays small: rep* fields (NicheClusterCard renders popularVideos,
  // not the rep video) and per-popular-video postedAt/postedDate/score
  // (also unused in the card). ~30% payload shrink.
  const body = {
    runId: result.run.id,
    source: result.run.source,
    status: result.run.status,
    totalVideos: result.run.totalVideos,
    // Combined L1+L2 count so the page header reads as the full
    // niche universe rather than just the broad-niche count.
    numClusters: numL1 + numL2,
    numL1,
    numL2,
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

  cache = { ts: Date.now(), body };
  return NextResponse.json(body, {
    headers: { 'x-tree-clusters-cache': 'miss' },
  });
}
