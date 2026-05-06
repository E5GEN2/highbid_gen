/**
 * Show how many L2/L3+ assignments still hold the L1-demoted video_ids
 * — i.e. how much the cascade cleanup will need to clean up.
 */
import { getPool } from '@/lib/db';

async function main() {
  const pool = await getPool();

  const latest = await pool.query<{ id: number }>(
    `SELECT id FROM niche_tree_runs WHERE kind='global' ORDER BY started_at DESC LIMIT 1`,
  );
  const rootId = latest.rows[0].id;
  console.log('Latest global run_id:', rootId);

  // All descendant runs (L1 + every subdivide nested under it).
  const desc = await pool.query<{ id: number }>(
    `WITH RECURSIVE descendant_runs AS (
       SELECT id FROM niche_tree_runs WHERE id = $1
       UNION ALL
       SELECT r.id FROM niche_tree_runs r
         JOIN niche_tree_clusters c ON c.id = r.parent_cluster_id
         JOIN descendant_runs dr ON c.run_id = dr.id
        WHERE r.kind = 'subdivide'
     )
     SELECT id FROM descendant_runs`,
    [rootId],
  );
  const runIds = desc.rows.map(r => r.id);
  console.log(`Descendant runs (incl. root): ${runIds.length}`);

  // Demoted videos = anything with NULL cluster_id in scope.
  const dem = await pool.query<{ cnt: string }>(
    `SELECT COUNT(DISTINCT video_id)::text AS cnt
       FROM niche_tree_assignments
      WHERE run_id = ANY($1::int[]) AND cluster_id IS NULL`,
    [runIds],
  );
  console.log(`Distinct demoted video_ids in scope: ${dem.rows[0].cnt}`);

  // L2+ assignments that still attach a demoted video to a cluster
  const cascade = await pool.query<{ cluster_id: number; label: string | null; auto_label: string | null; cnt: string; total: string }>(
    `SELECT c.id AS cluster_id, c.label, c.auto_label,
            COUNT(*)::text AS cnt,
            c.video_count::text AS total
       FROM niche_tree_assignments a
       JOIN niche_tree_clusters c ON c.id = a.cluster_id
      WHERE a.run_id = ANY($1::int[])
        AND a.cluster_id IS NOT NULL
        AND a.video_id IN (
          SELECT DISTINCT video_id FROM niche_tree_assignments
            WHERE run_id = ANY($1::int[]) AND cluster_id IS NULL
        )
      GROUP BY c.id, c.label, c.auto_label, c.video_count
      ORDER BY COUNT(*) DESC LIMIT 30`,
    [runIds],
  );
  console.log(`\nClusters still holding demoted videos:`);
  for (const r of cascade.rows) {
    const label = r.label || r.auto_label || `cluster ${r.cluster_id}`;
    console.log(`  cid=${r.cluster_id.toString().padStart(4)} ${label.padEnd(45)} demoted_attached=${r.cnt.padStart(4)} / total=${r.total}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
