import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * LIVE incremental stats. The header tiles want all-time totals that tick on
 * every 3s poll, but the naive aggregation (COUNT(DISTINCT) over the multi-M-row
 * append-only table) costs ~7s — polls piled up and starved the feed
 * (2026-07-20). niche_seed_expansions is APPEND-ONLY with a monotonic id, so:
 * one full aggregation seeds the state per filter-combination, then each poll
 * only aggregates rows with id > lastMaxId (a handful, via the pkey index) and
 * folds them into the running totals — exact, live, ~1ms per poll.
 */
interface StatsState {
  total: number;
  errors: number;
  simSum: number;
  simCount: number;
  seeds: Set<number>;
  tasks: Set<string>;
  maxId: string;       // bigint as string
  lastUsed: number;
  seededAt: number;    // when the full aggregation ran — hourly re-seed guards
                       // against drift if an old row is ever UPDATEd (the
                       // incremental fold only sees appends)
}
const statsState = new Map<string, StatsState>();
const MAX_STATS_COMBOS = 20;
const RESEED_AFTER_MS = 60 * 60 * 1000;

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

  // Prefix every column with `e.` (niche_seed_expansions) — niche_spy_videos
  // shares column names (keyword, task_id) so bare references are ambiguous
  // after the LEFT JOIN below.
  const conds: string[] = [];
  const args: (string | number | boolean)[] = [];
  let p = 1;
  if (since)   { conds.push(`e.detected_at > $${p++}`); args.push(since); }
  if (taskId)  { conds.push(`e.task_id = $${p++}`); args.push(taskId); }
  if (keyword) { conds.push(`e.keyword = $${p++}`); args.push(keyword); }
  if (matched === 'true')  { conds.push(`e.matched = TRUE`); }
  if (matched === 'false') { conds.push(`e.matched = FALSE`); }
  if (minSim)  { conds.push(`e.similarity >= $${p++}`); args.push(parseFloat(minSim)); }
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
    candidate_was_new: boolean | null;
    detected_at: Date;
  }>(
    `SELECT e.id, e.seed_video_id, e.seed_url,
            sv.title AS seed_title, sv.thumbnail AS seed_thumbnail,
            e.candidate_video_id, e.candidate_url, e.candidate_title, e.candidate_thumbnail,
            e.similarity, e.matched, e.threshold, e.rank_in_batch,
            e.task_id, e.keyword, e.error_message, e.candidate_was_new, e.detected_at
       FROM niche_seed_expansions e
       LEFT JOIN niche_spy_videos sv ON sv.id = e.seed_video_id
       ${where}
       ORDER BY e.detected_at DESC, e.id DESC
       LIMIT $${p}`,
    args,
  );

  // LIVE stats, incrementally maintained (see StatsState above): tiles tick on
  // every poll, but each poll only aggregates the rows added since the last one.
  const filterArgs = args.slice(0, -1) as (string | number | boolean)[];
  const andWhere = (extra: string) => (where ? `${where} AND ${extra}` : `WHERE ${extra}`);
  const statsKey = JSON.stringify([since, taskId, keyword, matched, minSim]);
  let st = statsState.get(statsKey);
  if (st && Date.now() - st.seededAt > RESEED_AFTER_MS) { statsState.delete(statsKey); st = undefined; }
  if (!st) {
    // Seed the state: one aggregation pass (no COUNT(DISTINCT) — the distinct
    // id lists come from their own index-driven DISTINCT scans) per
    // filter-combination per process. Every later poll is incremental.
    const fullRes = await pool.query<{ total: string; error_count: string; sim_sum: string | null; sim_count: string; max_id: string | null }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE e.error_message IS NOT NULL) AS error_count,
              SUM(e.similarity) FILTER (WHERE e.similarity IS NOT NULL) AS sim_sum,
              COUNT(e.similarity) AS sim_count,
              MAX(e.id) AS max_id
         FROM niche_seed_expansions e ${where}`,
      filterArgs,
    );
    const seedsRes = await pool.query<{ seed_video_id: number }>(
      `SELECT DISTINCT e.seed_video_id FROM niche_seed_expansions e ${andWhere('e.seed_video_id IS NOT NULL')}`,
      filterArgs,
    );
    const tasksRes = await pool.query<{ task_id: string }>(
      `SELECT DISTINCT e.task_id FROM niche_seed_expansions e ${andWhere('e.task_id IS NOT NULL')}`,
      filterArgs,
    );
    const f = fullRes.rows[0];
    st = {
      total: parseInt(f.total),
      errors: parseInt(f.error_count),
      simSum: f.sim_sum != null ? parseFloat(f.sim_sum) : 0,
      simCount: parseInt(f.sim_count),
      seeds: new Set(seedsRes.rows.map(r => r.seed_video_id)),
      tasks: new Set(tasksRes.rows.map(r => r.task_id)),
      maxId: f.max_id ?? '0',
      lastUsed: Date.now(),
      seededAt: Date.now(),
    };
    statsState.set(statsKey, st);
    // Bounded: evict the least-recently-used combo when filter churn piles up.
    if (statsState.size > MAX_STATS_COMBOS) {
      let lruKey: string | null = null; let lruAt = Infinity;
      for (const [k, v] of statsState) if (v.lastUsed < lruAt) { lruAt = v.lastUsed; lruKey = k; }
      if (lruKey && lruKey !== statsKey) statsState.delete(lruKey);
    }
  } else {
    // Fold in only what's new since the last poll (pkey range scan, ~ms). The
    // LIMIT bounds a big catch-up after idle; if we hit it, the next poll
    // continues from where this one stopped — self-healing, never unbounded.
    const deltaRes = await pool.query<{ id: string; seed_video_id: number | null; task_id: string | null; similarity: number | null; is_err: boolean }>(
      `SELECT e.id, e.seed_video_id, e.task_id, e.similarity,
              (e.error_message IS NOT NULL) AS is_err
         FROM niche_seed_expansions e ${andWhere(`e.id > $${filterArgs.length + 1}`)}
        ORDER BY e.id ASC
        LIMIT 5000`,
      [...filterArgs, st.maxId],
    );
    for (const r of deltaRes.rows) {
      st.total++;
      if (r.is_err) st.errors++;
      if (r.similarity != null) { st.simSum += Number(r.similarity); st.simCount++; }
      if (r.seed_video_id != null) st.seeds.add(r.seed_video_id);
      if (r.task_id != null) st.tasks.add(r.task_id);
      st.maxId = r.id;
    }
    st.lastUsed = Date.now();
  }
  const stats = {
    total: st.total,
    errors: st.errors,
    avgSimilarity: st.simCount > 0 ? st.simSum / st.simCount : null,
    distinctSeeds: st.seeds.size,
    distinctTasks: st.tasks.size,
  };

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
      // matched + threshold deprecated — no longer returned. The columns
      // stay in the DB for back-compat but are always false / NULL now.
      rankInBatch: r.rank_in_batch,
      taskId: r.task_id,
      keyword: r.keyword,
      errorMessage: r.error_message,
      candidateWasNew: r.candidate_was_new,
      detectedAt: r.detected_at?.toISOString() ?? null,
    })),
    stats,
  });
}
