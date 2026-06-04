import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { discoverChannels, groupByCluster } from '@/lib/content-gen/discovery';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/content-gen/discover
 *
 * Sweeps our DB for channels passing the discovery rules. Returns the
 * top-K candidates with their showcase cluster attached. Use this to
 * validate the picker against real data.
 *
 * Default: sweeps ALL of niche_spy_videos (no cluster scope). Each
 * candidate's `showcase_cluster` field tells us which niche to feature
 * them under.
 *
 * Optional scoping:
 *   scopeRunId      — limit to videos in a specific clustering run
 *   scopeClusterId  — limit to a single cluster (for debugging one niche)
 *
 * Other params:
 *   topK            default 50
 *   minSubs         default 10_000
 *   maxSubs         default 5_000_000
 *   group           '1' to group candidates by their showcase_cluster in
 *                   the response — useful for "show me the niches that
 *                   surfaced and how many candidates each one has"
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const topK    = Math.min(500, parseInt(sp.get('topK') ?? '50') || 50);
  const minSubs = parseInt(sp.get('minSubs') ?? '10000')   || 10_000;
  const maxSubs = parseInt(sp.get('maxSubs') ?? '5000000') || 5_000_000;
  const scopeRunId     = sp.get('scopeRunId') != null ? parseInt(sp.get('scopeRunId')!) : undefined;
  const scopeClusterId = sp.get('scopeClusterId') != null ? parseInt(sp.get('scopeClusterId')!) : undefined;
  const group = sp.get('group') === '1';

  const t0 = Date.now();

  // Population-size diagnostic — how big is the input set we're sweeping?
  // Helps differentiate "filters are too strict" from "the input pool is
  // tiny." Run separately so it doesn't bloat the picker SQL.
  const pool = await getPool();
  let popScopeClause = '';
  const popParams: number[] = [];
  if (scopeRunId != null) {
    popScopeClause = `JOIN niche_tree_assignments sa ON sa.video_id = v.id AND sa.run_id = $1`;
    popParams.push(scopeRunId);
  } else if (scopeClusterId != null) {
    popScopeClause = `JOIN niche_tree_assignments sa ON sa.video_id = v.id AND sa.cluster_id = $1`;
    popParams.push(scopeClusterId);
  }
  const popRes = await pool.query<{
    total_videos: string;
    distinct_channels: string;
    enriched_channels: string;
  }>(
    `SELECT
       COUNT(*) AS total_videos,
       COUNT(DISTINCT v.channel_id) FILTER (WHERE v.channel_id IS NOT NULL) AS distinct_channels,
       COUNT(DISTINCT v.channel_id) FILTER (WHERE v.channel_id IS NOT NULL
                                              AND sc.subscriber_count IS NOT NULL) AS enriched_channels
     FROM niche_spy_videos v
     ${popScopeClause}
     LEFT JOIN niche_spy_channels sc ON sc.channel_id = v.channel_id
     WHERE v.channel_id IS NOT NULL AND v.view_count IS NOT NULL`,
    popParams,
  );

  const candidates = await discoverChannels({
    topK,
    minSubs,
    maxSubs,
    scopeRunId,
    scopeClusterId,
  });

  const elapsedMs = Date.now() - t0;

  // Distributions for the response — at-a-glance "what mix did we get?"
  const tierCounts: Record<string, number> = { mature: 0, mid_young: 0, young: 0, ultra_young: 0 };
  for (const c of candidates) tierCounts[c.age_tier]++;

  const scaleCounts = {
    small_10K_100K:   candidates.filter((c) => c.subscriber_count < 100_000).length,
    mid_100K_1M:      candidates.filter((c) => c.subscriber_count >= 100_000 && c.subscriber_count < 1_000_000).length,
    big_1M_5M:        candidates.filter((c) => c.subscriber_count >= 1_000_000).length,
  };

  const withCluster = candidates.filter((c) => c.showcase_cluster != null).length;

  return NextResponse.json({
    ok: true,
    elapsedMs,
    scope: {
      scopeRunId:     scopeRunId ?? null,
      scopeClusterId: scopeClusterId ?? null,
      default_when_null: 'all niche_spy_videos with a channel + view count',
    },
    diagnostic: {
      population_videos:            parseInt(popRes.rows[0]?.total_videos ?? '0') || 0,
      population_distinct_channels: parseInt(popRes.rows[0]?.distinct_channels ?? '0') || 0,
      population_enriched_channels: parseInt(popRes.rows[0]?.enriched_channels ?? '0') || 0,
      candidates_after_hard_filters: candidates.length,
      candidates_with_showcase_cluster: withCluster,
    },
    filter_thresholds_applied: {
      sub_band:                      [minSubs, maxSubs],
      top_video_views_floor_tiered: '1M (>365d) / 500K (180-365d) / 200K (90-180d) / 100K (≤90d)',
      views_to_subs_ratio_min:      5,
      channel_age_days_max:         730,
      top_video_age_max_months:     12,
      videos_indexed_min:           5,
      median_to_top_views_min:      0.05,
    },
    distribution: {
      by_age_tier: tierCounts,
      by_scale:    scaleCounts,
    },
    ...(group
      ? { niches: groupByCluster(candidates).map((g) => ({
            cluster:  g.cluster,
            channels: g.channels.map((c) => ({
              channel_id:         c.channel_id,
              channel_name:       c.channel_name,
              subscriber_count:   c.subscriber_count,
              channel_age_days:   c.channel_age_days,
              top_video_views:    c.top_video_views,
              views_to_subs_ratio: c.views_to_subs_ratio,
              composite_score:    c.composite_score,
              age_tier:           c.age_tier,
            })),
          })) }
      : { candidates }),
  });
}
