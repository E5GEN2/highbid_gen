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
 * Returns:
 *   {
 *     runId, source, status, totalVideos, numClusters,
 *     clusters: [{ id, level, parentClusterId, autoLabel, label, videoCount,
 *                  avgScore, avgViews, totalViews, topChannels,
 *                  representativeVideoId, repTitle, repThumbnail, repUrl,
 *                  repViewCount, repChannelName, popularVideos: [...],
 *                  childrenCount }]
 *   }
 *
 * Errors with empty clusters[] if no global run has finished yet.
 */
export async function GET() {
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
    return NextResponse.json({
      runId: null, source: null, status: null,
      totalVideos: 0, numClusters: 0, clusters: [],
    });
  }

  // Only return L1 (parent_cluster_id IS NULL) for the home grid. L2
  // children are fetched per-cluster on the detail page so the home
  // payload stays small.
  const l1 = result.clusters.filter(c => c.parentClusterId == null);

  return NextResponse.json({
    runId: result.run.id,
    source: result.run.source,
    status: result.run.status,
    totalVideos: result.run.totalVideos,
    numClusters: result.run.numClusters,
    clusters: l1.map(c => ({
      id: c.id,
      level: c.level,
      parentClusterId: c.parentClusterId,
      autoLabel: c.autoLabel,
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
      childrenCount: c.childrenCount,
    })),
  });
}
