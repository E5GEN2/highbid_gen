import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/niche-spy/seed-feed
 *
 * Live feed for the admin Video Seed tab. Returns recent rows from
 * niche_seed_expansions — every (seed, candidate, similarity) tuple
 * the xgodo agents have submitted.
 *
 * Query params:
 *   since      ISO timestamp; rows with detected_at > since (incremental
 *              polling).  When set, also returns counts since that point.
 *   taskId     filter to a specific xgodo task
 *   keyword    filter to a specific niche tag
 *   matched    'true' | 'false' to filter
 *   minSim     numeric — only rows with similarity >= this value
 *   limit      default 200, max 1000
 *
 * Returns rows newest-first so the admin can `append-to-top` on
 * each poll without sorting client-side.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const sp = req.nextUrl.searchParams;
  const since = sp.get('since');
  const taskId = sp.get('taskId');
  const keyword = sp.get('keyword');
  const matched = sp.get('matched');
  const minSim = sp.get('minSim');
  const limit = Math.min(parseInt(sp.get('limit') || '200') || 200, 1000);

  const conds: string[] = [];
  const args: (string | number | boolean)[] = [];
  let p = 1;
  if (since)   { conds.push(`detected_at > $${p++}`); args.push(since); }
  if (taskId)  { conds.push(`task_id = $${p++}`); args.push(taskId); }
  if (keyword) { conds.push(`keyword = $${p++}`); args.push(keyword); }
  if (matched === 'true')  { conds.push(`matched = TRUE`); }
  if (matched === 'false') { conds.push(`matched = FALSE`); }
  if (minSim)  { conds.push(`similarity >= $${p++}`); args.push(parseFloat(minSim)); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  args.push(limit);

  // Join the seed row to surface its title / thumbnail — the admin
  // wants to see "candidate X compared against THIS seed" without
  // jumping pages.
  const res = await pool.query<{
    id: string;
    seed_video_id: number | null;
    seed_url: string | null;
    seed_title: string | null;
    seed_thumbnail: string | null;
    candidate_video_id: number | null;
    candidate_url: string;
    candidate_title: string | null;
    candidate_thumbnail: string | null;
    similarity: number | null;
    matched: boolean;
    threshold: number | null;
    rank_in_batch: number | null;
    task_id: string | null;
    keyword: string | null;
    error_message: string | null;
    detected_at: Date;
  }>(
    `SELECT e.id, e.seed_video_id, e.seed_url,
            sv.title AS seed_title, sv.thumbnail AS seed_thumbnail,
            e.candidate_video_id, e.candidate_url, e.candidate_title, e.candidate_thumbnail,
            e.similarity, e.matched, e.threshold, e.rank_in_batch,
            e.task_id, e.keyword, e.error_message, e.detected_at
       FROM niche_seed_expansions e
       LEFT JOIN niche_spy_videos sv ON sv.id = e.seed_video_id
       ${where}
       ORDER BY e.detected_at DESC, e.id DESC
       LIMIT $${p}`,
    args,
  );

  // Aggregate stats — useful for the header "X matches, Y rejected,
  // Z errors" tiles when polling for since=<ts>.
  const statsRes = await pool.query<{
    total: string;
    matched_count: string;
    error_count: string;
    avg_sim: number | null;
    distinct_seeds: string;
    distinct_tasks: string;
  }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE matched) AS matched_count,
       COUNT(*) FILTER (WHERE error_message IS NOT NULL) AS error_count,
       AVG(similarity) FILTER (WHERE similarity IS NOT NULL) AS avg_sim,
       COUNT(DISTINCT seed_video_id) AS distinct_seeds,
       COUNT(DISTINCT task_id) FILTER (WHERE task_id IS NOT NULL) AS distinct_tasks
     FROM niche_seed_expansions
     ${where}`,
    args.slice(0, -1),
  );

  return NextResponse.json({
    rows: res.rows.map(r => ({
      id: r.id,
      seedVideoId: r.seed_video_id,
      seedUrl: r.seed_url,
      seedTitle: r.seed_title,
      seedThumbnail: r.seed_thumbnail,
      candidateVideoId: r.candidate_video_id,
      candidateUrl: r.candidate_url,
      candidateTitle: r.candidate_title,
      candidateThumbnail: r.candidate_thumbnail,
      similarity: r.similarity,
      matched: r.matched,
      threshold: r.threshold,
      rankInBatch: r.rank_in_batch,
      taskId: r.task_id,
      keyword: r.keyword,
      errorMessage: r.error_message,
      detectedAt: r.detected_at?.toISOString() ?? null,
    })),
    stats: {
      total:           parseInt(statsRes.rows[0].total),
      matched:         parseInt(statsRes.rows[0].matched_count),
      errors:          parseInt(statsRes.rows[0].error_count),
      avgSimilarity:   statsRes.rows[0].avg_sim != null ? parseFloat(String(statsRes.rows[0].avg_sim)) : null,
      distinctSeeds:   parseInt(statsRes.rows[0].distinct_seeds),
      distinctTasks:   parseInt(statsRes.rows[0].distinct_tasks),
    },
  });
}
