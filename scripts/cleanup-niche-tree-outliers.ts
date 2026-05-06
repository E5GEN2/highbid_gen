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

  // Update the run rows' num_noise tally so the admin header reflects reality.
  if (!DRY_RUN && totalDemoted > 0) {
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
  console.log(`  Clusters affected: ${clustersAffected}`);
  console.log(`  Videos demoted to noise: ${totalDemoted}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
