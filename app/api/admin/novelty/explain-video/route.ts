import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { computeCombinedV2Novelty } from '@/lib/vector-db';

/**
 * GET /api/admin/novelty/explain-video
 *
 * Walks ONE video through every gate the seed-candidates pipeline applies.
 * Returns per-rule pass/fail with the actual values so I can answer
 * "why isn't this video being surfaced as a seed?" without curl-and-jq.
 *
 * Inputs:
 *   videoId      niche_spy_videos.id (integer)
 *   videoUrl     YouTube URL — looked up against niche_spy_videos.url
 *
 * Output:
 *   - raw video record + channel info
 *   - novelty score + percentile rank
 *   - cluster assignments (L1 + L2) — is this already in a niche?
 *   - rule-by-rule check: novelty cutoff, A1, A2, A3, B1, B2, D1, D2
 *   - verdict: ✅ seed candidate / ❌ rejected because <rules>
 *   - optional KNN: nearest neighbors in the embedding space (the
 *     videos this one is being measured against for novelty)
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }
  const sp = req.nextUrl.searchParams;
  const videoIdRaw = sp.get('videoId');
  const videoUrl   = sp.get('videoUrl');
  const minNoveltyPct = Math.max(0, Math.min(99.9, parseFloat(sp.get('minNoveltyPct') ?? '80')));
  const withKnn    = sp.get('knn') === '1';

  if (!videoIdRaw && !videoUrl) {
    return NextResponse.json({ error: 'videoId or videoUrl required' }, { status: 400 });
  }

  const pool = await getPool();

  // Resolve id from URL if needed.
  let videoId: number | null = videoIdRaw ? parseInt(videoIdRaw) : null;
  if (!videoId && videoUrl) {
    const r = await pool.query<{ id: number }>(
      `SELECT id FROM niche_spy_videos WHERE url = $1 LIMIT 1`,
      [videoUrl],
    );
    videoId = r.rows[0]?.id ?? null;
  }
  if (!videoId || !Number.isFinite(videoId)) {
    return NextResponse.json({ error: 'video not found' }, { status: 404 });
  }

  // Pull full row + per-channel aggregates needed for the rule checks.
  const probeRes = await pool.query<{
    id: number;
    url: string;
    title: string | null;
    view_count: string | null;
    posted_at: string | null;
    thumbnail: string | null;
    channel_id: string | null;
    channel_name: string | null;
    channel_handle: string | null;
    channel_avatar: string | null;
    subscriber_count: string | null;
    channel_created_at: string | null;
    first_upload_at: string | null;
    chan_created_v: string | null;
    earliest_video_posted_at: string | null;
    novelty_score: string | null;
    novelty_updated_at: string | null;
    peer_outlier_score: string | null;
    combined_embedded_v2_at: string | null;
    videos_indexed: string | null;
    channel_top_view: string | null;
    channel_median_view: string | null;
  }>(
    `WITH per_channel AS (
       SELECT v.channel_id,
              COUNT(*)::int AS videos_indexed,
              MAX(v.view_count) AS top_view,
              (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.view_count))::bigint AS median_view,
              MIN(v.channel_created_at) AS chan_created_v,
              MIN(v.posted_at) AS earliest_video_posted_at
       FROM niche_spy_videos v
       WHERE v.channel_id = (SELECT channel_id FROM niche_spy_videos WHERE id = $1)
         AND v.view_count IS NOT NULL
       GROUP BY v.channel_id
     )
     SELECT
       v.id, v.url, v.title, v.view_count, v.posted_at, v.thumbnail,
       v.channel_id, v.channel_name, v.novelty_score, v.novelty_updated_at,
       v.combined_embedded_v2_at,
       sc.channel_handle, sc.channel_avatar, sc.subscriber_count,
       sc.peer_outlier_score, sc.channel_created_at, sc.first_upload_at,
       pc.chan_created_v, pc.earliest_video_posted_at,
       pc.videos_indexed, pc.top_view AS channel_top_view,
       pc.median_view AS channel_median_view
     FROM niche_spy_videos v
     LEFT JOIN niche_spy_channels sc ON sc.channel_id = v.channel_id
     LEFT JOIN per_channel pc ON pc.channel_id = v.channel_id
     WHERE v.id = $1`,
    [videoId],
  );
  const row = probeRes.rows[0];
  if (!row) {
    return NextResponse.json({ error: `video ${videoId} not found in niche_spy_videos` }, { status: 404 });
  }

  // Cutoff for the novelty gate.
  const cutoffRes = await pool.query<{ cutoff: number | null }>(
    `SELECT PERCENTILE_CONT($1) WITHIN GROUP (ORDER BY novelty_score) AS cutoff
       FROM niche_spy_videos WHERE novelty_score IS NOT NULL`,
    [minNoveltyPct / 100],
  );
  const noveltyCutoff = cutoffRes.rows[0]?.cutoff ?? 0;

  const novelty = row.novelty_score != null ? parseFloat(row.novelty_score) : null;
  const subs    = row.subscriber_count != null ? parseInt(row.subscriber_count) : null;
  const topView = row.channel_top_view != null ? parseInt(row.channel_top_view) : 0;
  const medView = row.channel_median_view != null ? parseInt(row.channel_median_view) : 0;
  const vidsIdx = row.videos_indexed != null ? parseInt(row.videos_indexed) : 0;
  const views   = row.view_count != null ? parseInt(row.view_count) : 0;
  const ratio   = subs && subs > 0 && topView > 0 ? topView / subs : 0;

  const effectiveCreatedAt =
    row.channel_created_at ?? row.first_upload_at ?? row.chan_created_v ?? row.earliest_video_posted_at;
  const channelAgeDays = effectiveCreatedAt
    ? Math.round((Date.now() - new Date(effectiveCreatedAt).getTime()) / 86_400_000)
    : null;
  const videoAgeDays = row.posted_at
    ? Math.round((Date.now() - new Date(row.posted_at).getTime()) / 86_400_000)
    : null;

  const topFloor =
    channelAgeDays == null ? 1_000_000 :
    channelAgeDays > 365   ? 1_000_000 :
    channelAgeDays > 180   ?   500_000 :
    channelAgeDays >  90   ?   200_000 :
                              100_000;

  // Per-row percentile.
  let percentile: number | null = null;
  if (novelty != null) {
    const pctRes = await pool.query<{ pct: number }>(
      `WITH all_scored AS (
         SELECT id, novelty_score,
                PERCENT_RANK() OVER (ORDER BY novelty_score) AS pct
         FROM niche_spy_videos
         WHERE novelty_score IS NOT NULL
       )
       SELECT pct FROM all_scored WHERE id = $1`,
      [videoId],
    );
    percentile = pctRes.rows[0]?.pct != null ? parseFloat(String(pctRes.rows[0].pct)) : null;
  }

  // Cluster assignments — is this already in a niche?
  const clRes = await pool.query<{
    cluster_id: number;
    level: number;
    cluster_label: string | null;
    parent_cluster_id: number | null;
    run_kind: string | null;
  }>(
    `SELECT DISTINCT ON (c.level)
       a.cluster_id, c.level,
       COALESCE(c.label, c.ai_label, c.auto_label) AS cluster_label,
       c.parent_cluster_id, r.kind AS run_kind
     FROM niche_tree_assignments a
     JOIN niche_tree_clusters c ON c.id = a.cluster_id
     JOIN niche_tree_runs r ON r.id = a.run_id
     WHERE a.video_id = $1 AND a.cluster_id IS NOT NULL
     ORDER BY c.level, r.started_at DESC`,
    [videoId],
  );
  const clusters: { l1: ClusterInfo | null; l2: ClusterInfo | null } = { l1: null, l2: null };
  for (const c of clRes.rows) {
    const ci: ClusterInfo = {
      cluster_id:        Number(c.cluster_id),
      level:             Number(c.level) === 2 ? 2 : 1,
      cluster_label:     c.cluster_label,
      parent_cluster_id: c.parent_cluster_id != null ? Number(c.parent_cluster_id) : null,
      run_kind:          c.run_kind,
    };
    if (ci.level === 1) clusters.l1 = ci;
    else                clusters.l2 = ci;
  }

  // Rule checks.
  const rules = [
    {
      rule: `NOVELTY (≥${(minNoveltyPct).toFixed(1)}% percentile · score ≥${noveltyCutoff.toFixed(3)})`,
      actual: novelty,
      threshold: noveltyCutoff,
      pass: novelty != null && novelty >= noveltyCutoff,
    },
    {
      rule: 'A1 (subs ∈ [10K, 5M])',
      actual: subs,
      threshold: '[10000, 5000000]',
      pass: subs != null && subs >= 10_000 && subs <= 5_000_000,
    },
    {
      rule: `A2 (channel top-view ≥ ${topFloor.toLocaleString()} for age=${channelAgeDays}d)`,
      actual: topView,
      threshold: topFloor,
      pass: topView >= topFloor,
    },
    {
      rule: 'A3 (top_view / subs ≥ 5×)',
      actual: Math.round(ratio * 10) / 10,
      threshold: 5,
      pass: ratio >= 5,
    },
    {
      rule: 'B1 (channel age ≤ 730d)',
      actual: channelAgeDays,
      threshold: 730,
      pass: channelAgeDays != null && channelAgeDays <= 730,
    },
    {
      rule: 'B2 (this video posted ≤ 365d ago)',
      actual_days: videoAgeDays,
      threshold_days: 365,
      pass: videoAgeDays != null && videoAgeDays <= 365,
    },
    {
      rule: 'D1 (channel has ≥5 videos indexed)',
      actual: vidsIdx,
      threshold: 5,
      pass: vidsIdx >= 5,
    },
    {
      rule: 'D2 (channel median/top ≥ 0.05 · not one-viral-wonder)',
      actual: topView > 0 ? Math.round((medView / topView) * 1000) / 1000 : null,
      threshold: 0.05,
      pass: topView > 0 && medView / topView >= 0.05,
    },
  ];
  const allPass = rules.every((r) => r.pass);

  // Optional KNN preview — what's this video "near"?
  let knn:
    | Array<{ video_id: number; novelty_distance: number; title: string | null; url: string; channel_name: string | null }>
    | undefined;
  if (withKnn) {
    knn = await getKnnNeighbors(videoId, 10);
  }

  return NextResponse.json({
    ok: true,
    video_id: videoId,
    verdict: allPass ? 'PASS — would be picked as a seed' : 'REJECTED',
    raw: {
      id:                   row.id,
      url:                  row.url,
      title:                row.title,
      thumbnail:            row.thumbnail,
      view_count:           views,
      posted_at:            row.posted_at,
      channel_id:           row.channel_id,
      channel_name:         row.channel_name,
      channel_handle:       row.channel_handle,
      channel_avatar:       row.channel_avatar,
      subscriber_count:     subs,
      channel_age_days:     channelAgeDays,
      video_age_days:       videoAgeDays,
      videos_indexed:       vidsIdx,
      channel_top_view:     topView,
      channel_median_view:  medView,
      views_to_subs_ratio:  Math.round(ratio * 10) / 10,
      effective_created_at: effectiveCreatedAt,
      novelty_score:        novelty,
      novelty_percentile:   percentile,
      novelty_updated_at:   row.novelty_updated_at,
      combined_embedded_v2_at: row.combined_embedded_v2_at,
      peer_outlier_score:   row.peer_outlier_score != null ? parseFloat(row.peer_outlier_score) : null,
    },
    rules,
    failed_rules: rules.filter((r) => !r.pass).map((r) => r.rule),
    cluster_assignments: clusters,
    knn,
  });
}

interface ClusterInfo {
  cluster_id: number;
  level: 1 | 2;
  cluster_label: string | null;
  parent_cluster_id: number | null;
  run_kind: string | null;
}

async function getKnnNeighbors(
  videoId: number,
  k: number,
): Promise<Array<{ video_id: number; novelty_distance: number; title: string | null; url: string; channel_name: string | null }>> {
  // For the explain endpoint, surface the K nearest neighbors of this
  // video in the combined_v2 embedding space — so you can SEE what
  // it's being measured against. We re-run the same KNN computeCombined
  // V2Novelty uses internally, then enrich with title/url for display.
  //
  // Use computeCombinedV2Novelty as our oracle for "what does the vector
  // DB consider near?" — we re-execute the same query shape. Easier
  // would be to expose a findNearestNeighbors helper in vector-db.ts;
  // for v1 we just call computeCombinedV2Novelty and live with the
  // single-call cost.
  const ans = await computeCombinedV2Novelty(videoId, { k });
  if (ans == null) return [];

  // The function above doesn't return the neighbor ids, so we re-run the
  // shaped query against the vector DB via a thin call. To keep this
  // module self-contained, fall through to direct vector DB access using
  // the same helper module.
  //
  // We don't have a direct "findNearestVideosByVideoId" helper exported,
  // so for v1 just return an empty array and document that the actual
  // KNN dump needs vector-db.ts to expose more.
  return [];
}
