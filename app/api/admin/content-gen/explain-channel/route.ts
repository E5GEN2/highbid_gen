import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/content-gen/explain-channel?channelId=X
 *      or                                   ?channelHandle=@foo
 *      or                                   ?videoId=N
 *
 * Walks ONE channel through every discovery rule and reports per-rule
 * pass/fail with the actual values. Use when:
 *
 *   - "Why isn't X being picked?" — see exactly which rule rejected
 *   - Validating a known good channel passes
 *   - Tuning thresholds: see the actual values to pick a better floor
 *
 * Also returns the channel's showcase_cluster (top video's cluster) if any.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  let channelId = sp.get('channelId');
  const channelHandle = sp.get('channelHandle');
  const videoIdRaw = sp.get('videoId');

  const pool = await getPool();

  // Resolve channelId from handle or video id if needed.
  if (!channelId && channelHandle) {
    const r = await pool.query<{ channel_id: string }>(
      `SELECT channel_id FROM niche_spy_channels
       WHERE channel_handle = $1
       LIMIT 1`,
      [channelHandle.startsWith('@') ? channelHandle : `@${channelHandle}`],
    );
    channelId = r.rows[0]?.channel_id ?? null;
  }
  if (!channelId && videoIdRaw) {
    const vid = parseInt(videoIdRaw);
    if (Number.isFinite(vid)) {
      const r = await pool.query<{ channel_id: string | null }>(
        `SELECT channel_id FROM niche_spy_videos WHERE id = $1`,
        [vid],
      );
      channelId = r.rows[0]?.channel_id ?? null;
    }
  }

  if (!channelId) {
    return NextResponse.json({ error: 'channelId (or channelHandle / videoId) required and must resolve' }, { status: 400 });
  }

  // Pull per-channel aggregate + enrichment + cluster info in one shot.
  const probe = await pool.query<{
    channel_id: string;
    channel_name: string | null;
    channel_handle: string | null;
    subscriber_count: string | null;
    channel_created_at: string | null;
    first_upload_at: string | null;
    video_count: string | null;
    chan_created_v: string | null;
    earliest_video_posted_at: string | null;
    videos_indexed: string;
    top_video_views: string | null;
    median_video_views: string | null;
    top_video_posted_at: string | null;
    top_video_id: string | null;
    top_video_title: string | null;
    max_novelty: string | null;
  }>(`
    WITH per_channel AS (
      SELECT
        v.channel_id,
        COUNT(*)::int                                AS videos_indexed,
        MAX(v.view_count)                            AS top_video_views,
        (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.view_count))::bigint
                                                      AS median_video_views,
        MAX(v.posted_at)                             AS top_video_posted_at,
        MIN(v.channel_created_at)                    AS chan_created_v,
        MIN(v.posted_at)                             AS earliest_video_posted_at,
        MAX(v.novelty_score)                         AS max_novelty
      FROM niche_spy_videos v
      WHERE v.channel_id = $1
        AND v.view_count IS NOT NULL
      GROUP BY v.channel_id
    ),
    top_v AS (
      SELECT v.id AS top_video_id, v.title AS top_video_title
      FROM niche_spy_videos v
      WHERE v.channel_id = $1
      ORDER BY v.view_count DESC NULLS LAST
      LIMIT 1
    )
    SELECT
      pc.channel_id,
      sc.channel_name,
      sc.channel_handle,
      sc.subscriber_count,
      sc.channel_created_at,
      sc.first_upload_at,
      sc.video_count,
      pc.chan_created_v,
      pc.earliest_video_posted_at,
      pc.videos_indexed,
      pc.top_video_views,
      pc.median_video_views,
      pc.top_video_posted_at,
      tv.top_video_id,
      tv.top_video_title,
      pc.max_novelty
    FROM per_channel pc
    LEFT JOIN niche_spy_channels sc ON sc.channel_id = pc.channel_id
    LEFT JOIN top_v tv ON true
  `, [channelId]);

  const row = probe.rows[0];
  if (!row) {
    return NextResponse.json({
      ok: false,
      reason: `channel ${channelId} has no rows in niche_spy_videos OR all videos have NULL view_count`,
    }, { status: 404 });
  }

  // Resolve effective_created_at + age_days (matches discovery picker).
  const effectiveCreatedAt =
    row.channel_created_at ?? row.first_upload_at ?? row.chan_created_v ?? row.earliest_video_posted_at;
  const ageDays = effectiveCreatedAt
    ? Math.round((Date.now() - new Date(effectiveCreatedAt).getTime()) / 86_400_000)
    : null;

  const subs    = row.subscriber_count != null ? parseInt(row.subscriber_count) : null;
  const topV    = row.top_video_views != null ? parseInt(row.top_video_views) : 0;
  const medV    = row.median_video_views != null ? parseInt(row.median_video_views) : 0;
  const vidsIdx = parseInt(row.videos_indexed);
  const ratio   = subs && subs > 0 ? topV / subs : 0;

  // Tiered top-video floor based on age.
  const topFloor =
    ageDays == null    ? 1_000_000 :
    ageDays > 365      ? 1_000_000 :
    ageDays > 180      ?   500_000 :
    ageDays >  90      ?   200_000 :
                          100_000;

  const topVideoAgeDays = row.top_video_posted_at
    ? Math.round((Date.now() - new Date(row.top_video_posted_at).getTime()) / 86_400_000)
    : null;

  // Per-rule evaluation.
  const rules = [
    {
      rule: 'A1 (subscribers ∈ [10K, 5M])',
      actual: subs,
      threshold: '[10000, 5000000]',
      pass: subs != null && subs >= 10_000 && subs <= 5_000_000,
    },
    {
      rule: `A2 (top_video_views ≥ ${topFloor.toLocaleString()} for age_days=${ageDays})`,
      actual: topV,
      threshold: topFloor,
      pass: topV >= topFloor,
    },
    {
      rule: 'A3 (views/subs ratio ≥ 5×)',
      actual: Math.round(ratio * 10) / 10,
      threshold: 5,
      pass: ratio >= 5,
    },
    {
      rule: 'B1 (channel age ≤ 730 days)',
      actual: ageDays,
      threshold: 730,
      pass: ageDays != null && ageDays <= 730,
    },
    {
      rule: 'B2 (top video posted ≤ 12 months ago)',
      actual_top_video_age_days: topVideoAgeDays,
      threshold_days: 365,
      pass: topVideoAgeDays != null && topVideoAgeDays <= 365,
    },
    {
      rule: 'D1 (videos_indexed ≥ 5)',
      actual: vidsIdx,
      threshold: 5,
      pass: vidsIdx >= 5,
    },
    {
      rule: 'D2 (median/top views ratio ≥ 0.05 — not one-viral-wonder)',
      actual: topV > 0 ? Math.round((medV / topV) * 1000) / 1000 : null,
      threshold: 0.05,
      pass: topV > 0 && medV / topV >= 0.05,
    },
  ];

  const allPass = rules.every((r) => r.pass);

  // Bonus: showcase cluster if top video has one.
  let showcase_cluster: {
    cluster_id: number;
    cluster_label: string | null;
    run_kind: string | null;
  } | null = null;
  if (row.top_video_id) {
    const c = await pool.query(
      `SELECT a.cluster_id, c.label AS cluster_label, r.kind AS run_kind
       FROM niche_tree_assignments a
       JOIN niche_tree_clusters c ON c.id = a.cluster_id
       JOIN niche_tree_runs r ON r.id = a.run_id
       WHERE a.video_id = $1 AND a.cluster_id IS NOT NULL
       ORDER BY r.started_at DESC
       LIMIT 1`,
      [parseInt(row.top_video_id)],
    );
    if (c.rows[0]) {
      showcase_cluster = {
        cluster_id:    Number(c.rows[0].cluster_id),
        cluster_label: c.rows[0].cluster_label,
        run_kind:      c.rows[0].run_kind,
      };
    }
  }

  return NextResponse.json({
    ok: true,
    channel_id: channelId,
    verdict: allPass ? 'PASS — would be picked by discovery' : 'REJECTED',
    raw: {
      channel_name:        row.channel_name,
      channel_handle:      row.channel_handle,
      subscriber_count:    subs,
      effective_created_at: effectiveCreatedAt,
      age_days:            ageDays,
      total_video_count:   row.video_count != null ? parseInt(row.video_count) : null,
      videos_indexed:      vidsIdx,
      top_video_views:     topV,
      top_video_id:        row.top_video_id != null ? parseInt(row.top_video_id) : null,
      top_video_title:     row.top_video_title,
      top_video_posted_at: row.top_video_posted_at,
      top_video_age_days:  topVideoAgeDays,
      median_video_views:  medV,
      views_to_subs_ratio: Math.round(ratio * 10) / 10,
      novelty_score:       row.max_novelty != null ? parseFloat(row.max_novelty) : null,
    },
    rules,
    failed_rules: rules.filter((r) => !r.pass).map((r) => r.rule),
    showcase_cluster,
  });
}
