/**
 * Why are scary stories in the "bitcoin crypto home" cluster?
 *  - d distribution
 *  - whether scary-stories channels appear elsewhere
 *  - sibling cluster labels for context
 */
import { getPool } from '@/lib/db';

async function main() {
  const pool = await getPool();

  // Pick the bitcoin cluster from the LATEST global run (the one
  // the user is browsing now). Older runs may have different
  // clusters with the same labels; we want a consistent view.
  const latestRun = await pool.query<{ id: number }>(
    `SELECT id FROM niche_tree_runs WHERE kind='global' ORDER BY started_at DESC LIMIT 1`,
  );
  const runId = latestRun.rows[0]?.id;
  console.log('latest global run_id:', runId);
  const clu = await pool.query<{ id: number; run_id: number; label: string | null; auto_label: string | null; video_count: number }>(
    `SELECT id, run_id, label, auto_label, video_count
       FROM niche_tree_clusters
       WHERE parent_cluster_id IS NULL AND run_id = $1
         AND (label ILIKE '%bitcoin%' OR auto_label ILIKE '%bitcoin%')
       ORDER BY video_count DESC LIMIT 5`,
    [runId],
  );
  console.log('=== bitcoin-ish clusters in latest run ===');
  for (const r of clu.rows) console.log(JSON.stringify(r));
  if (clu.rows.length === 0) { await pool.end(); return; }
  const c = clu.rows[0];

  // d distribution in that cluster
  const dist = await pool.query<{
    bucket: string; cnt: string; min_d: number; max_d: number;
  }>(
    `SELECT
       CASE
         WHEN distance_to_centroid < 0.5 THEN 'a) <0.5  (core)'
         WHEN distance_to_centroid < 1.0 THEN 'b) <1.0'
         WHEN distance_to_centroid < 2.0 THEN 'c) <2.0'
         WHEN distance_to_centroid < 3.0 THEN 'd) <3.0'
         WHEN distance_to_centroid < 5.0 THEN 'e) <5.0'
         ELSE                                  'f) >=5.0 (far edge)'
       END AS bucket,
       COUNT(*)::text AS cnt,
       MIN(distance_to_centroid) AS min_d,
       MAX(distance_to_centroid) AS max_d
     FROM niche_tree_assignments
     WHERE cluster_id = $1
     GROUP BY 1 ORDER BY 1`,
    [c.id],
  );
  console.log(`\n=== cluster ${c.id} "${c.label || c.auto_label}" — d distribution (${c.video_count} videos) ===`);
  for (const r of dist.rows) console.log(`  ${r.bucket.padEnd(22)} ${r.cnt.padStart(5)}  min=${r.min_d?.toFixed(2)}  max=${r.max_d?.toFixed(2)}`);

  // Top channels in the high-d tail (>=3.0) — likely the "shouldn't be here" videos
  const tail = await pool.query<{ channel_name: string | null; cnt: string; avg_d: number }>(
    `SELECT v.channel_name, COUNT(*)::text AS cnt, AVG(a.distance_to_centroid)::numeric AS avg_d
       FROM niche_tree_assignments a
       JOIN niche_spy_videos v ON v.id = a.video_id
      WHERE a.cluster_id = $1 AND a.distance_to_centroid >= 3.0
      GROUP BY v.channel_name ORDER BY COUNT(*) DESC LIMIT 12`,
    [c.id],
  );
  console.log(`\n=== top "edge-of-niche" channels (d >= 3.0) ===`);
  for (const r of tail.rows) console.log(`  ${(r.channel_name ?? '—').padEnd(40)} cnt=${r.cnt}  avg_d=${Number(r.avg_d).toFixed(2)}`);

  // Is there a "scary stories" cluster anywhere in the same run?
  const scary = await pool.query<{ id: number; label: string | null; auto_label: string | null; video_count: number }>(
    `SELECT id, label, auto_label, video_count
       FROM niche_tree_clusters
      WHERE run_id = $1 AND parent_cluster_id IS NULL
        AND (label ILIKE '%scary%' OR auto_label ILIKE '%scary%' OR label ILIKE '%horror%' OR auto_label ILIKE '%horror%' OR label ILIKE '%creepy%' OR auto_label ILIKE '%creepy%')`,
    [c.run_id],
  );
  console.log(`\n=== scary/horror clusters in same run (run_id=${c.run_id}) ===`);
  if (scary.rows.length === 0) console.log('  none');
  for (const r of scary.rows) console.log('  ' + JSON.stringify(r));

  // What keywords pulled "Mr Revenant" videos into the dataset?
  const kw = await pool.query<{ keyword: string; cnt: string }>(
    `SELECT keyword, COUNT(*)::text AS cnt
       FROM niche_spy_videos
      WHERE channel_name = 'Mr Revenant'
      GROUP BY keyword ORDER BY COUNT(*) DESC`,
  );
  console.log(`\n=== keywords that scraped Mr Revenant ===`);
  for (const r of kw.rows) console.log(`  ${r.keyword.padEnd(40)} ${r.cnt}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
