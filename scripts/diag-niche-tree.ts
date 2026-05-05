import { getPool } from '@/lib/db';

async function main() {
  const pool = await getPool();
  const running = await pool.query(`
    SELECT id, kind, parent_cluster_id, status,
      EXTRACT(EPOCH FROM (NOW() - started_at))::int AS age_sec,
      total_videos,
      progress->>'stage' AS stage,
      progress->'l2' AS l2,
      progress->>'stageStartedAt' AS stage_started_at
    FROM niche_tree_runs
    WHERE status = 'running'
    ORDER BY id`);
  console.log('=== running rows ===');
  for (const r of running.rows) {
    console.log(JSON.stringify(r, null, 2));
  }

  const recent = await pool.query(`
    SELECT id, kind, status, error_message,
      EXTRACT(EPOCH FROM (NOW() - started_at))::int AS age_sec
    FROM niche_tree_runs
    ORDER BY started_at DESC LIMIT 8`);
  console.log('\n=== recent runs ===');
  for (const r of recent.rows) console.log(JSON.stringify(r));

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
