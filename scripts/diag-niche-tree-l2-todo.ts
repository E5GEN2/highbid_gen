/**
 * Reports how much L2 baking work is still owed for the most recent
 * global L1 run — i.e. L1 clusters with >=50 videos and no children.
 * Mirrors the query in /api/admin/niche-tree/resume-l2.
 */
import { getPool } from '@/lib/db';

async function main() {
  const pool = await getPool();
  const latest = await pool.query<{ id: number }>(
    `SELECT id FROM niche_tree_runs WHERE kind = 'global' ORDER BY started_at DESC LIMIT 1`,
  );
  const l1 = latest.rows[0]?.id;
  if (!l1) { console.log('no global runs'); await pool.end(); return; }
  console.log(`Most recent global L1 run: id=${l1}`);

  const summary = await pool.query<{
    total: string; eligible: string; with_children: string; tiny: string;
  }>(
    `SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (
          WHERE c.video_count >= 50
            AND NOT EXISTS (SELECT 1 FROM niche_tree_clusters child WHERE child.parent_cluster_id = c.id)
        )::text AS eligible,
        COUNT(*) FILTER (
          WHERE EXISTS (SELECT 1 FROM niche_tree_clusters child WHERE child.parent_cluster_id = c.id)
        )::text AS with_children,
        COUNT(*) FILTER (WHERE c.video_count < 50)::text AS tiny
      FROM niche_tree_clusters c
      WHERE c.run_id = $1 AND c.parent_cluster_id IS NULL`,
    [l1],
  );
  const s = summary.rows[0];
  console.log(`L1 clusters: total=${s.total} with_children=${s.with_children} eligible_to_bake=${s.eligible} tiny(<50)=${s.tiny}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
