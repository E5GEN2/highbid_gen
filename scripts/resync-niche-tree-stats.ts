/**
 * Resync denormalized cluster stats with the actual assignments table.
 * Fixes the case where assignments were demoted to noise but the
 * cluster row's video_count / avg_score / avg_views / total_views /
 * top_channels still reflect the pre-demotion state. Also deletes
 * clusters that ended up with 0 assignments.
 *
 * Idempotent. Run after the cascade cleanup if cluster cards still
 * show stale counts.
 */
import { getPool } from '@/lib/db';

async function main() {
  const pool = await getPool();

  // Find every cluster where denorm.video_count disagrees with the
  // assignment row count. Cheap: single GROUP BY join across the
  // whole tree.
  const stale = await pool.query<{ id: number; label: string | null; auto_label: string | null; denorm: number; actual: string }>(
    `SELECT c.id, c.label, c.auto_label, c.video_count AS denorm,
            COALESCE(cnt.cnt, 0)::text AS actual
       FROM niche_tree_clusters c
       LEFT JOIN (
         SELECT cluster_id, COUNT(*)::int AS cnt
           FROM niche_tree_assignments WHERE cluster_id IS NOT NULL
           GROUP BY cluster_id
       ) cnt ON cnt.cluster_id = c.id
      WHERE c.video_count <> COALESCE(cnt.cnt, 0)
      ORDER BY c.video_count DESC`,
  );
  console.log(`Stale clusters (denorm != actual): ${stale.rows.length}`);

  let recomputed = 0;
  let deleted = 0;
  for (const c of stale.rows) {
    const actual = parseInt(c.actual);
    const label = c.label || c.auto_label || `cluster ${c.id}`;
    if (actual === 0) {
      await pool.query(`DELETE FROM niche_tree_clusters WHERE id = $1`, [c.id]);
      deleted += 1;
      console.log(`  DEL  cid=${c.id.toString().padStart(4)}  ${label.padEnd(45)} (denorm=${c.denorm}, actual=0)`);
      continue;
    }
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
      [c.id],
    );
    recomputed += 1;
    console.log(`  UPD  cid=${c.id.toString().padStart(4)}  ${label.padEnd(45)} (denorm=${c.denorm}, actual=${actual})`);
  }

  console.log(`\nDone.`);
  console.log(`  Stats recomputed: ${recomputed}`);
  console.log(`  Empty clusters deleted: ${deleted}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
