/**
 * Retroactive outlier cleanup for an existing niche-tree run.
 *
 * Mirrors the Tukey IQR fence the python script now applies on fresh
 * runs (Q3 + k*IQR on each cluster's distance_to_centroid). Anything
 * above the fence gets demoted to noise:
 *   niche_tree_assignments.cluster_id  = NULL
 *   niche_tree_assignments.cluster_index = -1
 * and the cluster row's denormalized stats (video_count, avg_score,
 * avg_views, total_views, top_channels) are recomputed from the
 * remaining assignments.
 *
 * Default scope: latest global run + all its descendants. Pass a runId
 * via env to target a specific run.
 *
 * Usage:
 *   npx tsx scripts/cleanup-niche-tree-outliers.ts            # latest global
 *   IQR_MULT=2.5 npx tsx scripts/cleanup-niche-tree-outliers.ts
 *   RUN_ID=6 npx tsx scripts/cleanup-niche-tree-outliers.ts
 *   DRY_RUN=1 npx tsx scripts/cleanup-niche-tree-outliers.ts  # report only
 */
import { getPool } from '@/lib/db';

const IQR_MULT = parseFloat(process.env.IQR_MULT || '3.0');
const DRY_RUN  = process.env.DRY_RUN === '1';

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function main() {
  const pool = await getPool();

  // Pick scope: explicit RUN_ID, or latest global + its subdivides
  const explicitRunId = process.env.RUN_ID ? parseInt(process.env.RUN_ID) : null;
  let runIds: number[];
  if (explicitRunId) {
    runIds = [explicitRunId];
  } else {
    const latest = await pool.query<{ id: number }>(
      `SELECT id FROM niche_tree_runs WHERE kind='global' ORDER BY started_at DESC LIMIT 1`,
    );
    if (latest.rows.length === 0) { console.log('no global run to clean'); await pool.end(); return; }
    const rootId = latest.rows[0].id;
    // Find descendant subdivide runs whose parent_cluster_id sits in the
    // tree rooted at this global run. Two-step join via niche_tree_clusters.
    const desc = await pool.query<{ id: number }>(
      `SELECT id FROM niche_tree_runs
        WHERE id = $1
           OR (kind = 'subdivide' AND parent_cluster_id IN (
                 SELECT id FROM niche_tree_clusters WHERE run_id = $1
              ))`,
      [rootId],
    );
    runIds = desc.rows.map(r => r.id);
  }
  console.log(`Scope: ${runIds.length} run(s):`, runIds.slice(0, 10).join(','), runIds.length > 10 ? '…' : '');
  console.log(`IQR multiplier: ${IQR_MULT}  Dry-run: ${DRY_RUN}`);

  // Fetch every cluster in scope plus its assignments' distances.
  const clusterRes = await pool.query<{ id: number; run_id: number; label: string | null; auto_label: string | null; video_count: number }>(
    `SELECT id, run_id, label, auto_label, video_count
       FROM niche_tree_clusters
      WHERE run_id = ANY($1::int[])
      ORDER BY video_count DESC`,
    [runIds],
  );

  let totalDemoted = 0;
  let clustersAffected = 0;

  for (const c of clusterRes.rows) {
    const dRes = await pool.query<{ id: number; d: number | null }>(
      `SELECT id, distance_to_centroid AS d
         FROM niche_tree_assignments
        WHERE cluster_id = $1`,
      [c.id],
    );
    const valid = dRes.rows.filter(r => r.d != null && r.d >= 0) as { id: number; d: number }[];
    if (valid.length < 4) continue;

    const sorted = valid.map(r => r.d).sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    if (iqr <= 0) continue;
    const fence = q3 + IQR_MULT * iqr;
    const outliers = valid.filter(r => r.d > fence);
    if (outliers.length === 0) continue;

    const label = c.label || c.auto_label || `cluster ${c.id}`;
    console.log(`  ${label.padEnd(45)}  cnt=${valid.length.toString().padStart(5)}  q3=${q3.toFixed(2)}  iqr=${iqr.toFixed(2)}  fence=${fence.toFixed(2)}  demote=${outliers.length}`);
    totalDemoted += outliers.length;
    clustersAffected += 1;

    if (DRY_RUN) continue;

    // Demote: set cluster_id NULL + cluster_index -1 for these assignment rows.
    const ids = outliers.map(r => r.id);
    await pool.query(
      `UPDATE niche_tree_assignments
          SET cluster_id = NULL, cluster_index = -1
        WHERE id = ANY($1::int[])`,
      [ids],
    );

    // Recompute denormalized stats on the cluster row from the remaining
    // assignments. Mirrors the formulas niche-tree.ts uses at insert time.
    await pool.query(
      `UPDATE niche_tree_clusters c SET
         video_count = sub.cnt,
         avg_score   = sub.avg_score,
         avg_views   = sub.avg_views,
         total_views = sub.total_views,
         top_channels = sub.top_channels
       FROM (
         SELECT
           COUNT(*)::int AS cnt,
           AVG(v.score)::numeric AS avg_score,
           AVG(NULLIF(v.view_count, 0))::numeric AS avg_views,
           SUM(v.view_count)::numeric AS total_views,
           (
             SELECT array_agg(channel_name)
               FROM (
                 SELECT v2.channel_name, COUNT(*) AS k
                   FROM niche_tree_assignments a2
                   JOIN niche_spy_videos v2 ON v2.id = a2.video_id
                  WHERE a2.cluster_id = $1 AND v2.channel_name IS NOT NULL
                  GROUP BY v2.channel_name
                  ORDER BY k DESC LIMIT 5
               ) t
           ) AS top_channels
         FROM niche_tree_assignments a
         JOIN niche_spy_videos v ON v.id = a.video_id
         WHERE a.cluster_id = $1
       ) sub
       WHERE c.id = $1`,
      [c.id],
    );
  }

  // ── Phase 2: cascade ─────────────────────────────────────────
  // The IQR fence is intra-cluster — it can't catch "this entire L2
  // cluster shouldn't exist under this parent" cases. Real example:
  // 19 motorcycle videos at d=4.74 from the bitcoin centroid form a
  // legit-looking L2 sub-cluster ("motorcycle riding ride") because
  // they're tightly grouped with each other, even though as a whole
  // they don't belong under bitcoin.
  //
  // Cascade: walk runs by depth (L1 → L2 → L3). For each run, find
  // its own noise videos and demote those same video_ids in every
  // direct-child subdivide run. Iterating top-down means a video
  // demoted at L1 propagates to L2 in iteration 1, then L2 → L3 in
  // iteration 2, and so on, without recursion gymnastics.
  console.log(`\n── Phase 2: cascade L1-noise into descendants ──`);
  // Order runs by level (L1 first). niche_tree_runs.level holds the
  // depth-from-L1 for subdivides; the global run is level=0.
  const runsByDepth = await pool.query<{ id: number; level: number }>(
    `SELECT id, COALESCE(level, 0) AS level FROM niche_tree_runs
       WHERE id = ANY($1::int[]) ORDER BY level ASC, id ASC`,
    [runIds],
  );

  let cascadeDemoted = 0;
  const affectedClusterIds = new Set<number>();
  for (const run of runsByDepth.rows) {
    // Videos marked noise at this run
    const noiseRes = await pool.query<{ video_id: number }>(
      `SELECT DISTINCT video_id FROM niche_tree_assignments
        WHERE run_id = $1 AND cluster_id IS NULL`,
      [run.id],
    );
    if (noiseRes.rows.length === 0) continue;
    const noiseIds = noiseRes.rows.map(r => r.video_id);

    // Direct child subdivide runs (their parent cluster is in this run)
    const childRes = await pool.query<{ id: number }>(
      `SELECT r.id FROM niche_tree_runs r
         JOIN niche_tree_clusters c ON c.id = r.parent_cluster_id
        WHERE r.kind = 'subdivide' AND c.run_id = $1`,
      [run.id],
    );
    if (childRes.rows.length === 0) continue;
    const childRunIds = childRes.rows.map(r => r.id);

    // Demote the noise videos in any non-NULL assignment in the child runs
    if (DRY_RUN) {
      const previewRes = await pool.query<{ cluster_id: number; cnt: string }>(
        `SELECT cluster_id, COUNT(*)::text AS cnt
           FROM niche_tree_assignments
          WHERE run_id = ANY($1::int[])
            AND cluster_id IS NOT NULL
            AND video_id = ANY($2::int[])
          GROUP BY cluster_id ORDER BY COUNT(*) DESC`,
        [childRunIds, noiseIds],
      );
      const sum = previewRes.rows.reduce((s, r) => s + parseInt(r.cnt), 0);
      cascadeDemoted += sum;
      console.log(`  run=${run.id} (level ${run.level}): would cascade ${sum} assignments across ${previewRes.rows.length} clusters`);
      for (const p of previewRes.rows) affectedClusterIds.add(p.cluster_id);
    } else {
      // CTE pattern: capture the OLD cluster_id values BEFORE the
      // UPDATE rewrites them to NULL. RETURNING from the UPDATE
      // itself only sees post-update values (i.e. NULL), which would
      // leave affectedClusterIds full of NULLs.
      const updRes = await pool.query<{ cluster_id: number }>(
        `WITH targets AS (
           SELECT id, cluster_id FROM niche_tree_assignments
            WHERE run_id = ANY($1::int[])
              AND cluster_id IS NOT NULL
              AND video_id = ANY($2::int[])
         ),
         done AS (
           UPDATE niche_tree_assignments a
              SET cluster_id = NULL, cluster_index = -1
             FROM targets t
            WHERE a.id = t.id
         )
         SELECT cluster_id FROM targets`,
        [childRunIds, noiseIds],
      );
      cascadeDemoted += updRes.rowCount ?? 0;
      for (const r of updRes.rows) affectedClusterIds.add(r.cluster_id);
      console.log(`  run=${run.id} (level ${run.level}): cascaded ${updRes.rowCount} assignments`);
    }
  }

  // ── Phase 3: recompute stats + delete empty clusters ────────
  // Some descendants will have lost most/all of their videos to
  // cascade. Recompute denormalized stats; if a cluster ends up with
  // 0 videos, delete the row entirely (its remaining noise rows live
  // on with cluster_id=NULL — kept for the run's noise tally).
  let clustersDeleted = 0;
  let clustersStatsRecomputed = 0;
  if (!DRY_RUN && affectedClusterIds.size > 0) {
    for (const clusterId of affectedClusterIds) {
      const cnt = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM niche_tree_assignments WHERE cluster_id = $1`,
        [clusterId],
      );
      const remaining = parseInt(cnt.rows[0].cnt);
      if (remaining === 0) {
        // Drop the empty cluster row. ON DELETE CASCADE on its
        // assignments doesn't apply here since they already have
        // cluster_id=NULL, so this is a clean row delete.
        await pool.query(`DELETE FROM niche_tree_clusters WHERE id = $1`, [clusterId]);
        clustersDeleted += 1;
      } else {
        await pool.query(
          `UPDATE niche_tree_clusters c SET
             video_count = sub.cnt,
             avg_score   = sub.avg_score,
             avg_views   = sub.avg_views,
             total_views = sub.total_views,
             top_channels = sub.top_channels
           FROM (
             SELECT
               COUNT(*)::int AS cnt,
               AVG(v.score)::numeric AS avg_score,
               AVG(NULLIF(v.view_count, 0))::numeric AS avg_views,
               SUM(v.view_count)::numeric AS total_views,
               (
                 SELECT array_agg(channel_name) FROM (
                   SELECT v2.channel_name, COUNT(*) AS k
                     FROM niche_tree_assignments a2
                     JOIN niche_spy_videos v2 ON v2.id = a2.video_id
                    WHERE a2.cluster_id = $1 AND v2.channel_name IS NOT NULL
                    GROUP BY v2.channel_name ORDER BY k DESC LIMIT 5
                 ) t
               ) AS top_channels
             FROM niche_tree_assignments a
             JOIN niche_spy_videos v ON v.id = a.video_id
            WHERE a.cluster_id = $1
           ) sub WHERE c.id = $1`,
          [clusterId],
        );
        clustersStatsRecomputed += 1;
      }
    }
  }

  // Update the run rows' num_noise tally so the admin header reflects reality.
  if (!DRY_RUN && (totalDemoted > 0 || cascadeDemoted > 0)) {
    for (const runId of runIds) {
      await pool.query(
        `UPDATE niche_tree_runs r SET num_noise = (
           SELECT COUNT(*) FROM niche_tree_assignments WHERE run_id = $1 AND cluster_id IS NULL
         ) WHERE r.id = $1`,
        [runId],
      );
    }
  }

  console.log(`\nDone. ${DRY_RUN ? '(DRY RUN — no writes)' : ''}`);
  console.log(`  IQR phase — clusters affected: ${clustersAffected}, videos demoted: ${totalDemoted}`);
  console.log(`  Cascade phase — assignments demoted: ${cascadeDemoted}`);
  if (!DRY_RUN) {
    console.log(`  Empty descendant clusters deleted: ${clustersDeleted}`);
    console.log(`  Descendant cluster stats recomputed: ${clustersStatsRecomputed}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
