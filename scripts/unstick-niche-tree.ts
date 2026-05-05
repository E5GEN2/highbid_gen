/**
 * One-shot recovery: marks all niche_tree_runs rows still flagged
 * 'running' as errored ('Orphaned: server restarted before run
 * finished'). Use when a Railway redeploy killed the in-process
 * baking loop and the boot-sweep hasn't yet run (or the deploy
 * with the sweep landed AFTER the orphans). Idempotent.
 */
import { getPool } from '@/lib/db';

async function main() {
  const pool = await getPool();
  const before = await pool.query(
    `SELECT id, kind, parent_cluster_id, total_videos,
       EXTRACT(EPOCH FROM (NOW() - started_at))::int AS age_sec,
       progress->>'stage' AS stage
     FROM niche_tree_runs
     WHERE status = 'running'
     ORDER BY id`,
  );
  console.log(`Found ${before.rowCount ?? 0} 'running' row(s):`);
  for (const r of before.rows) console.log('  ' + JSON.stringify(r));

  if ((before.rowCount ?? 0) === 0) {
    console.log('Nothing to unstick.');
    await pool.end();
    return;
  }

  const r = await pool.query(
    `UPDATE niche_tree_runs
        SET status = 'error',
            error_message = COALESCE(error_message, 'Orphaned: server restarted before run finished'),
            completed_at = NOW()
      WHERE status = 'running'
      RETURNING id, kind`,
  );
  console.log(`Marked ${r.rowCount} row(s) errored.`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
