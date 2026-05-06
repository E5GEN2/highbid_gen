/**
 * Smoke test for getClusterVideos. Picks the first L1 cluster from
 * the most recent global run and exercises every sort option. Use
 * to confirm the new admin endpoint backs onto a working query
 * without needing the Next dev server up.
 */
import { getPool } from '@/lib/db';
import { getClusterVideos, type ClusterVideoSort } from '@/lib/niche-tree';

async function main() {
  const pool = await getPool();
  const r = await pool.query<{ id: number; label: string | null; auto_label: string | null; video_count: number }>(
    `SELECT c.id, c.label, c.auto_label, c.video_count
       FROM niche_tree_clusters c
       JOIN niche_tree_runs r ON r.id = c.run_id
      WHERE r.kind='global' AND c.parent_cluster_id IS NULL
      ORDER BY c.video_count DESC LIMIT 1`,
  );
  if (r.rows.length === 0) { console.log('no L1 clusters'); await pool.end(); return; }
  const c = r.rows[0];
  console.log(`Picked L1 cluster id=${c.id}  label=${c.label || c.auto_label || '?'}  videos=${c.video_count}`);

  const sorts: ClusterVideoSort[] = ['centroid', 'outlier', 'score', 'views', 'date', 'oldest', 'likes'];
  for (const sort of sorts) {
    const res = await getClusterVideos({ clusterId: c.id, sort, limit: 3, offset: 0 });
    console.log(`\n=== sort=${sort}  total=${res.total}  returned=${res.videos.length} ===`);
    for (const v of res.videos) {
      console.log(`  v=${v.videoId}  d=${v.distanceToCentroid?.toFixed(3) ?? '—'}  views=${v.viewCount ?? '—'}  score=${v.score ?? '—'}  ${(v.title ?? '').slice(0, 60)}`);
    }
  }

  // Also exercise pagination
  const p1 = await getClusterVideos({ clusterId: c.id, sort: 'centroid', limit: 5, offset: 0 });
  const p2 = await getClusterVideos({ clusterId: c.id, sort: 'centroid', limit: 5, offset: 5 });
  console.log(`\nPagination check: page1 last id=${p1.videos.at(-1)?.videoId}  page2 first id=${p2.videos[0]?.videoId}  same=${p1.videos.at(-1)?.videoId === p2.videos[0]?.videoId}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
