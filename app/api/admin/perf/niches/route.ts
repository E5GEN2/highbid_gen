import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { fetchUploadHistograms, fetchClusterOpportunities } from '@/lib/niche-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/perf/niches
 *
 * Performance probe for the /niche/niches page. Re-runs every SQL
 * query that getLatestGlobalRun() executes, timing each one with
 * process.hrtime, then returns a JSON breakdown. Used by Claude to
 * iteratively optimize the tree-clusters endpoint — without this
 * the only feedback signal is "feels slow" which doesn't say
 * whether the bottleneck is DB, JS, network, or render.
 *
 * Bypasses the route-handler cache so every probe is a fresh
 * measurement. Admin Bearer (`hba_...`) required.
 *
 * Returns:
 *   {
 *     ok, totalMs, clusterCount, responseBytes,
 *     phases: { runRes, parallelBatch1, parallelBatch2, jsMap, stringify },
 *     queries: { runRes, liveStats, clRes, popRes, channelCount,
 *                histogram, opportunity, childStats },
 *     parallelism: "serial" | "parallel"
 *   }
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) {
    return NextResponse.json({ error: 'admin required' }, { status: 403 });
  }

  const pool = await getPool();
  const timings: Record<string, number> = {};
  const t = (label: string, t0: bigint) => {
    timings[label] = Number(process.hrtime.bigint() - t0) / 1e6;
  };

  const tTotal = process.hrtime.bigint();

  // ── Phase 1: latest global run ─────────────────────────────
  const tRun = process.hrtime.bigint();
  const runRes = await pool.query(
    `SELECT id FROM niche_tree_runs
       WHERE kind = 'global'
       ORDER BY started_at DESC
       LIMIT 1`,
  );
  t('runRes', tRun);
  if (runRes.rows.length === 0) {
    return NextResponse.json({ ok: false, reason: 'no global run' });
  }
  const runId: number = runRes.rows[0].id;

  // ── Phase 2: liveStats + clRes in parallel ─────────────────
  const tBatch1 = process.hrtime.bigint();
  const tLive = process.hrtime.bigint();
  const liveStatsP = pool.query(
    `SELECT
       (SELECT COUNT(*)::text FROM niche_tree_assignments WHERE run_id = $1 AND cluster_id IS NOT NULL) AS assigned,
       (SELECT COUNT(*)::text FROM niche_tree_assignments WHERE run_id = $1 AND cluster_id IS NULL)     AS noise,
       (SELECT COUNT(*)::text FROM niche_tree_clusters    WHERE run_id = $1 AND parent_cluster_id IS NULL) AS clusters`,
    [runId],
  ).then(r => { t('liveStats', tLive); return r; });

  const tCl = process.hrtime.bigint();
  const clResP = pool.query(
    `WITH l1 AS (
       SELECT id FROM niche_tree_clusters
        WHERE run_id = $1 AND parent_cluster_id IS NULL
     )
     SELECT
       c.id, c.run_id, c.parent_cluster_id, c.level, c.cluster_index,
       c.auto_label, c.ai_label, c.label, c.video_count, c.avg_score,
       c.avg_views, c.total_views, c.top_channels, c.representative_video_id,
       c.centroid_2d,
       v.title         AS rep_title,
       v.thumbnail     AS rep_thumbnail,
       v.url           AS rep_url,
       v.view_count    AS rep_view_count,
       v.channel_name  AS rep_channel_name
     FROM niche_tree_clusters c
     LEFT JOIN niche_spy_videos v ON v.id = c.representative_video_id AND v.thumbnail_dead_at IS NULL
     WHERE c.id IN (SELECT id FROM l1)
        OR c.parent_cluster_id IN (SELECT id FROM l1)
     ORDER BY c.parent_cluster_id NULLS FIRST, c.video_count DESC`,
    [runId],
  ).then(r => { t('clRes', tCl); return r; });

  const [, clRes] = await Promise.all([liveStatsP, clResP]);
  t('parallelBatch1', tBatch1);
  const allClusterIds: number[] = clRes.rows.map((r: { id: number }) => r.id);

  // ── Phase 3: five per-cluster queries in parallel ──────────
  const tBatch2 = process.hrtime.bigint();

  const tPop = process.hrtime.bigint();
  const popP = pool.query(
    `WITH per_channel AS (
       SELECT a.cluster_id,
              v.id AS video_id, v.title, v.thumbnail, v.url, v.view_count,
              v.channel_name, v.posted_at, v.posted_date, v.score,
              a.distance_to_centroid,
              ROW_NUMBER() OVER (
                PARTITION BY a.cluster_id, v.channel_name
                ORDER BY a.distance_to_centroid ASC NULLS LAST
              ) AS channel_rn
         FROM niche_tree_assignments a
         JOIN niche_spy_videos v ON v.id = a.video_id
         WHERE a.cluster_id = ANY($1::int[])
           AND v.channel_name IS NOT NULL
           AND v.thumbnail_dead_at IS NULL
     ),
     ranked AS (
       SELECT *, ROW_NUMBER() OVER (
                  PARTITION BY cluster_id
                  ORDER BY distance_to_centroid ASC NULLS LAST
                ) AS rn
         FROM per_channel WHERE channel_rn = 1
     )
     SELECT cluster_id, video_id, title, thumbnail, url, view_count,
            channel_name, posted_at, posted_date, score
       FROM ranked WHERE rn <= 4 ORDER BY cluster_id, rn`,
    [allClusterIds],
  ).then(r => { t('popRes', tPop); return r; });

  const tCc = process.hrtime.bigint();
  const ccP = pool.query(
    `SELECT a.cluster_id, COUNT(DISTINCT v.channel_name)::text AS cnt
       FROM niche_tree_assignments a
       JOIN niche_spy_videos v ON v.id = a.video_id
      WHERE a.cluster_id = ANY($1::int[]) AND v.channel_name IS NOT NULL AND v.channel_name <> ''
      GROUP BY a.cluster_id`,
    [allClusterIds],
  ).then(r => { t('channelCount', tCc); return r; });

  const tHist = process.hrtime.bigint();
  const histP = fetchUploadHistograms(pool, { clusterIds: allClusterIds })
    .then(r => { t('histogram', tHist); return r; });

  const tOpp = process.hrtime.bigint();
  const oppP = fetchClusterOpportunities(pool, { clusterIds: allClusterIds })
    .then(r => { t('opportunity', tOpp); return r; });

  const tCs = process.hrtime.bigint();
  const csP = pool.query(
    `WITH child_counts AS (
       SELECT parent_cluster_id AS parent_id, COUNT(*)::int AS children_count
         FROM niche_tree_clusters
         WHERE parent_cluster_id IS NOT NULL
         GROUP BY parent_cluster_id
     ),
     latest_sub AS (
       SELECT DISTINCT ON (parent_cluster_id)
              parent_cluster_id AS parent_id,
              status            AS subdivide_status,
              error_message     AS subdivide_error
         FROM niche_tree_runs
         WHERE kind = 'subdivide' AND parent_cluster_id IS NOT NULL
         ORDER BY parent_cluster_id, started_at DESC
     )
     SELECT
       COALESCE(cc.parent_id, ls.parent_id) AS parent_id,
       COALESCE(cc.children_count::text, '0') AS children_count,
       ls.subdivide_status, ls.subdivide_error
     FROM child_counts cc
     FULL OUTER JOIN latest_sub ls ON ls.parent_id = cc.parent_id`,
  ).then(r => { t('childStats', tCs); return r; });

  await Promise.all([popP, ccP, histP, oppP, csP]);
  t('parallelBatch2', tBatch2);

  // ── Phase 4: rough JSON-stringify of clRes to estimate
  // serialization cost. Not the full response build (no
  // hydration map) but a proxy for "how heavy is the data". ──
  const tStr = process.hrtime.bigint();
  const sample = JSON.stringify(clRes.rows);
  t('stringify_clRes', tStr);

  t('total', tTotal);

  return NextResponse.json({
    ok: true,
    runId,
    clusterCount: allClusterIds.length,
    clResRows: clRes.rows.length,
    clResStringifiedBytes: sample.length,
    timingsMs: Object.fromEntries(
      Object.entries(timings).map(([k, v]) => [k, Math.round(v * 100) / 100]),
    ),
  });
}
