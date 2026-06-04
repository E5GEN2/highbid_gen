import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { discoverChannelsForCluster } from '@/lib/content-gen/discovery';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/content-gen/discover
 *
 * Returns the top-K candidate channels for a niche cluster per
 * data-discovery-rules.json. Use this to validate the picker against
 * real cluster data before wiring it into the generator.
 *
 * Query params:
 *   clusterId  REQUIRED — niche_tree_clusters.id to discover from
 *   topK       default 10
 *   minSubs    default 10_000
 *   maxSubs    default 5_000_000
 *
 * Response also includes a diagnostic block: the total cluster size,
 * how many channels we found before hard filters, and how many survived
 * each filter family. Helpful for tuning thresholds when too few or
 * too many candidates come back.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const clusterId = parseInt(sp.get('clusterId') ?? '');
  if (!Number.isFinite(clusterId)) {
    return NextResponse.json({ error: 'clusterId (int) required' }, { status: 400 });
  }
  const topK    = Math.min(100, parseInt(sp.get('topK')    ?? '10') || 10);
  const minSubs = parseInt(sp.get('minSubs') ?? '10000')   || 10_000;
  const maxSubs = parseInt(sp.get('maxSubs') ?? '5000000') || 5_000_000;

  const t0 = Date.now();

  // Diagnostic: how big is the cluster overall, and how many distinct
  // channels does it touch BEFORE hard filters? Useful for sanity-checking
  // "did the picker reject everything because of a bad threshold?" vs
  // "the cluster really only has 3 candidates."
  const pool = await getPool();
  const sizeRes = await pool.query<{
    cluster_videos: string;
    distinct_channels: string;
    channels_with_subs: string;
  }>(
    `SELECT
       COUNT(*) AS cluster_videos,
       COUNT(DISTINCT v.channel_id) FILTER (WHERE v.channel_id IS NOT NULL) AS distinct_channels,
       COUNT(DISTINCT v.channel_id) FILTER (WHERE v.channel_id IS NOT NULL
                                              AND sc.subscriber_count IS NOT NULL)
                                                                            AS channels_with_subs
     FROM niche_tree_assignments a
     JOIN niche_spy_videos v ON v.id = a.video_id
     LEFT JOIN niche_spy_channels sc ON sc.channel_id = v.channel_id
     WHERE a.cluster_id = $1`,
    [clusterId],
  );

  const candidates = await discoverChannelsForCluster({ clusterId, topK, minSubs, maxSubs });

  const elapsedMs = Date.now() - t0;

  // Compute distribution of result tiers for the response — at-a-glance
  // "did we get the recency-tiered mix we expected?"
  const tierCounts: Record<string, number> = { mature: 0, mid_young: 0, young: 0, ultra_young: 0 };
  for (const c of candidates) tierCounts[c.age_tier]++;

  const scaleCounts = {
    small_10K_100K:   candidates.filter((c) => c.subscriber_count < 100_000).length,
    mid_100K_1M:      candidates.filter((c) => c.subscriber_count >= 100_000 && c.subscriber_count < 1_000_000).length,
    big_1M_5M:        candidates.filter((c) => c.subscriber_count >= 1_000_000).length,
  };

  return NextResponse.json({
    ok: true,
    clusterId,
    elapsedMs,
    diagnostic: {
      total_videos_in_cluster:      parseInt(sizeRes.rows[0]?.cluster_videos ?? '0') || 0,
      distinct_channels_in_cluster: parseInt(sizeRes.rows[0]?.distinct_channels ?? '0') || 0,
      channels_with_enriched_data:  parseInt(sizeRes.rows[0]?.channels_with_subs ?? '0') || 0,
      candidates_after_hard_filters: candidates.length,
    },
    filter_thresholds_applied: {
      sub_band:                      [minSubs, maxSubs],
      top_video_views_floor_tiered: '1M (>365d) / 500K (180-365d) / 200K (90-180d) / 100K (≤90d)',
      views_to_subs_ratio_min:      5,
      channel_age_days_max:         730,
      top_video_age_max_months:     12,
      videos_in_cluster_min:        5,
      median_to_top_views_min:      0.05,
    },
    distribution: {
      by_age_tier: tierCounts,
      by_scale:    scaleCounts,
    },
    candidates,
  });
}
