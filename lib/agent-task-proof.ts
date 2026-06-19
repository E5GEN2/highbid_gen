/**
 * Task crawl-trace history — the durable record of what each xgodo niche-spy
 * task actually did:
 *
 *   1. SNAPSHOT (write): xgodo's job_proof carries the bot's watch path
 *      (orderNumber) + every suggested candidate it scored (similarity). That
 *      blob only lives while the task is in the applicants list, so we parse
 *      and persist it into `agent_task_proof`. snapshotTaskProofs() is called
 *      from the history endpoint each load (running + recently-completed),
 *      capturing the trace before it ages out.
 *
 *   2. LIST (read): listTaskHistory() returns the last N tasks from
 *      `agent_task_log` (the lifecycle ledger) enriched with seed/label +
 *      per-task watched/scored counts.
 *
 *   3. TRACE (read): getTaskTrace() merges two durable sources for one task —
 *      the watch path from `agent_task_proof` and the rofe-scored candidates
 *      from `niche_seed_expansions` (which also carries thumbnails + our own
 *      combined_v2 similarity) — into one ordered list the UI can render.
 */

import { getPool } from './db';
import type { ProofVideo } from './xgodo-tasks';

const YT_ID_RE = /(?:v=|\/shorts\/|youtu\.be\/|\/watch\?v=)([A-Za-z0-9_-]{11})/;
function ytId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(YT_ID_RE);
  return m ? m[1] : null;
}

/**
 * Persist the parsed crawl trace for a batch of tasks. Upsert merges so a
 * later snapshot of a still-running task fills in newly-watched videos and
 * never downgrades a watched row back to scored-only.
 */
export async function snapshotTaskProofs(
  tasks: Array<{ taskId: string; proof: ProofVideo[] }>,
): Promise<{ tasksWritten: number; rowsWritten: number }> {
  const pool = await getPool();
  let tasksWritten = 0;
  let rowsWritten = 0;

  for (const t of tasks) {
    if (!t.taskId || t.proof.length === 0) continue;
    // Build a multi-row VALUES insert per task (proof lists are small — a few
    // dozen videos at most).
    const values: unknown[] = [];
    const tuples: string[] = [];
    let i = 1;
    for (const v of t.proof) {
      if (!v.url) continue;
      const cols = 18;
      tuples.push('(' + Array.from({ length: cols }, () => `$${i++}`).join(', ') + ')');
      values.push(
        t.taskId, v.url, v.orderNumber, v.watched, v.title, v.channelName,
        v.viewCount, v.duration, v.similarity, v.source, v.seenStatus, v.isNew,
        v.hop, v.score, v.subscriberCount, v.likeCount, v.postedDate,
        v.raw ? JSON.stringify(v.raw) : null,
      );
    }
    if (tuples.length === 0) continue;
    await pool.query(
      `INSERT INTO agent_task_proof
         (task_id, video_url, order_number, watched, title, channel_name,
          view_count, duration, similarity, source, seen_status, is_new,
          hop, score, subscriber_count, like_count, posted_date, raw_json)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (task_id, video_url) DO UPDATE SET
         order_number = COALESCE(EXCLUDED.order_number, agent_task_proof.order_number),
         watched      = agent_task_proof.watched OR EXCLUDED.watched,
         title        = COALESCE(EXCLUDED.title, agent_task_proof.title),
         channel_name = COALESCE(EXCLUDED.channel_name, agent_task_proof.channel_name),
         view_count   = COALESCE(EXCLUDED.view_count, agent_task_proof.view_count),
         duration     = COALESCE(EXCLUDED.duration, agent_task_proof.duration),
         similarity   = COALESCE(EXCLUDED.similarity, agent_task_proof.similarity),
         source       = COALESCE(EXCLUDED.source, agent_task_proof.source),
         seen_status  = COALESCE(EXCLUDED.seen_status, agent_task_proof.seen_status),
         is_new       = COALESCE(EXCLUDED.is_new, agent_task_proof.is_new),
         hop          = COALESCE(EXCLUDED.hop, agent_task_proof.hop),
         score        = COALESCE(EXCLUDED.score, agent_task_proof.score),
         subscriber_count = COALESCE(EXCLUDED.subscriber_count, agent_task_proof.subscriber_count),
         like_count   = COALESCE(EXCLUDED.like_count, agent_task_proof.like_count),
         posted_date  = COALESCE(EXCLUDED.posted_date, agent_task_proof.posted_date),
         raw_json     = COALESCE(EXCLUDED.raw_json, agent_task_proof.raw_json),
         last_snapshot_at = NOW()`,
      values,
    ).catch((e) => { console.error('[task-proof] snapshot upsert failed', t.taskId, (e as Error).message); });
    tasksWritten++;
    rowsWritten += tuples.length;
  }
  return { tasksWritten, rowsWritten };
}

export interface TaskHistoryRow {
  taskId: string;
  key: string;                 // work-unit key (keyword OR nicheId)
  kind: 'keyword' | 'seed';
  label: string;               // human display name
  seedUrl: string | null;      // for seed tasks, the video it crawled from
  status: string;
  workerName: string | null;
  firstSeen: string;
  lastSeen: string;
  durationSec: number | null;
  watchedCount: number;        // videos the bot actually watched (proof)
  scoredCount: number;         // candidates scored (niche_seed_expansions)
}

/**
 * List recent tasks (running + completed) from the lifecycle ledger, enriched
 * with seed/label + per-task counts.
 */
export async function listTaskHistory(opts: {
  limit?: number;
  kind?: 'keyword' | 'seed' | 'all';
  status?: string;             // 'all' | 'running' | 'completed' | ...
} = {}): Promise<TaskHistoryRow[]> {
  const pool = await getPool();
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const kind = opts.kind ?? 'all';
  const status = opts.status ?? 'all';

  const where: string[] = [];
  const params: unknown[] = [];
  if (status !== 'all') { params.push(status); where.push(`l.status = $${params.length}`); }
  // Seed tasks have a nicheId key (nd_…); keyword tasks don't.
  if (kind === 'seed') where.push(`(l.kind = 'seed' OR l.keyword LIKE 'nd\\_%')`);
  else if (kind === 'keyword') where.push(`(COALESCE(l.kind,'keyword') <> 'seed' AND l.keyword NOT LIKE 'nd\\_%')`);

  params.push(limit);
  const limitParam = `$${params.length}`;

  const res = await pool.query<{
    task_id: string; keyword: string; kind: string | null; seed_url: string | null;
    status: string; worker_name: string | null; first_seen_at: string; last_seen_at: string;
    duration_sec: number | null; niche_label: string | null; niche_seeds: string[] | null;
    watched_count: string; scored_count: string;
  }>(
    `SELECT l.task_id, l.keyword, l.kind, l.seed_url, l.status, l.worker_name,
            l.first_seen_at, l.last_seen_at,
            EXTRACT(EPOCH FROM (l.last_seen_at - l.first_seen_at))::integer AS duration_sec,
            n.label AS niche_label, n.seed_urls AS niche_seeds,
            COALESCE(p.watched_count, 0) AS watched_count,
            COALESCE(e.scored_count, 0)  AS scored_count
       FROM agent_task_log l
       LEFT JOIN agent_niches n ON n.niche_id = l.keyword
       LEFT JOIN LATERAL (
         -- DISTINCT order_number, not COUNT(*): a crawl restart can leave a stale
         -- "ghost" row sharing an order_number with the current chain (different
         -- video_url => no upsert conflict, so it persists). Counting distinct
         -- order slots gives the true watch-path length.
         SELECT COUNT(DISTINCT order_number) FILTER (WHERE watched) AS watched_count
           FROM agent_task_proof WHERE task_id = l.task_id
       ) p ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS scored_count
           FROM niche_seed_expansions WHERE task_id = l.task_id
       ) e ON true
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY l.last_seen_at DESC
       LIMIT ${limitParam}`,
    params,
  );

  return res.rows.map(r => {
    const isSeed = r.kind === 'seed' || /^nd_/.test(r.keyword);
    return {
      taskId: r.task_id,
      key: r.keyword,
      kind: isSeed ? 'seed' : 'keyword',
      label: r.niche_label ?? r.keyword,
      seedUrl: r.seed_url ?? (r.niche_seeds && r.niche_seeds.length ? r.niche_seeds[0] : null),
      status: r.status,
      workerName: r.worker_name,
      firstSeen: r.first_seen_at,
      lastSeen: r.last_seen_at,
      durationSec: r.duration_sec,
      watchedCount: parseInt(r.watched_count) || 0,
      scoredCount: parseInt(r.scored_count) || 0,
    };
  });
}

export interface TraceVideo {
  videoId: string | null;
  url: string;
  title: string | null;
  orderNumber: number | null;   // watch order (null = scored-only)
  hop: number | null;           // 0-based crawl depth
  watched: boolean;
  score: number | null;             // bot's pick score from job_proof
  proofSimilarity: number | null;   // xgodo-side cosine from job_proof (legacy)
  rofeSimilarity: number | null;    // our combined_v2 cosine to the seed
  rank: number | null;              // rofe rank within the candidate batch
  channelName: string | null;
  subscriberCount: string | null;
  viewCount: string | null;
  likeCount: string | null;
  duration: string | null;
  postedDate: string | null;
  thumbnail: string | null;
  seenStatus: string | null;
  detectedAt: string | null;        // when rofe scored it
}

/**
 * Full crawl trace for one task: the watch path (from agent_task_proof) merged
 * with the rofe-scored candidates (from niche_seed_expansions, which adds
 * thumbnails + our own similarity). Sorted watched-first (by orderNumber),
 * then scored candidates by best available similarity.
 */
export async function getTaskTrace(taskId: string): Promise<{
  taskId: string;
  videos: TraceVideo[];
  watchedCount: number;
  scoredCount: number;
}> {
  const pool = await getPool();

  const [proofRes, nseRes] = await Promise.all([
    pool.query<{
      video_url: string; order_number: number | null; hop: number | null; watched: boolean; title: string | null;
      channel_name: string | null; subscriber_count: string | null; view_count: string | null;
      like_count: string | null; duration: string | null; posted_date: string | null;
      similarity: number | null; score: number | null; seen_status: string | null;
      last_snapshot_at: string | null;
    }>(
      `SELECT video_url, order_number, hop, watched, title, channel_name, subscriber_count,
              view_count, like_count, duration, posted_date, similarity, score, seen_status,
              last_snapshot_at
         FROM agent_task_proof WHERE task_id = $1`,
      [taskId],
    ),
    pool.query<{
      candidate_url: string; candidate_title: string | null; candidate_thumbnail: string | null;
      similarity: number | null; rank_in_batch: number | null; detected_at: string | null;
    }>(
      `SELECT candidate_url, candidate_title, candidate_thumbnail, similarity,
              rank_in_batch, detected_at
         FROM niche_seed_expansions WHERE task_id = $1`,
      [taskId],
    ),
  ]);

  const byKey = new Map<string, TraceVideo>();
  const snapAtByKey = new Map<string, number>();   // last_snapshot_at (ms) per video, for ghost dedup
  const keyOf = (url: string) => ytId(url) ?? url;

  for (const r of proofRes.rows) {
    const k = keyOf(r.video_url);
    snapAtByKey.set(k, r.last_snapshot_at ? new Date(r.last_snapshot_at).getTime() : 0);
    byKey.set(k, {
      videoId: ytId(r.video_url),
      url: r.video_url,
      title: r.title,
      orderNumber: r.order_number,
      hop: r.hop,
      watched: r.watched,
      score: r.score,
      proofSimilarity: r.similarity,
      rofeSimilarity: null,
      rank: null,
      channelName: r.channel_name,
      subscriberCount: r.subscriber_count,
      viewCount: r.view_count,
      likeCount: r.like_count,
      duration: r.duration,
      postedDate: r.posted_date,
      thumbnail: null,
      seenStatus: r.seen_status,
      detectedAt: null,
    });
  }

  for (const r of nseRes.rows) {
    const k = keyOf(r.candidate_url);
    const prev = byKey.get(k);
    if (prev) {
      prev.title = prev.title ?? r.candidate_title;
      prev.thumbnail = prev.thumbnail ?? r.candidate_thumbnail;
      prev.rofeSimilarity = r.similarity;
      prev.rank = r.rank_in_batch;
      prev.detectedAt = r.detected_at;
    } else {
      byKey.set(k, {
        videoId: ytId(r.candidate_url),
        url: r.candidate_url,
        title: r.candidate_title,
        orderNumber: null,
        hop: null,
        watched: false,
        score: null,
        proofSimilarity: null,
        rofeSimilarity: r.similarity,
        rank: r.rank_in_batch,
        channelName: null,
        subscriberCount: null,
        viewCount: null,
        likeCount: null,
        duration: null,
        postedDate: null,
        thumbnail: r.candidate_thumbnail,
        seenStatus: null,
        detectedAt: r.detected_at,
      });
    }
  }

  // Dedup crawl-restart ghosts: when >1 watched video claims the same order_number
  // (a different video_url took the slot after a restart), keep the one with the
  // latest snapshot — that's the current chain, since the ghost stops being
  // snapshotted at the restart. Demote the rest to scored-only so the watch path +
  // counts reflect the real crawl. (Read-side only — the writer keeps accumulating,
  // which stays robust to transient/partial proofs.)
  const winnerByOrder = new Map<number, { key: string; snap: number }>();
  for (const [k, v] of byKey) {
    if (!v.watched || v.orderNumber == null) continue;
    const snap = snapAtByKey.get(k) ?? 0;
    const cur = winnerByOrder.get(v.orderNumber);
    if (!cur || snap > cur.snap) winnerByOrder.set(v.orderNumber, { key: k, snap });
  }
  for (const [k, v] of byKey) {
    if (!v.watched || v.orderNumber == null) continue;
    if (winnerByOrder.get(v.orderNumber)!.key !== k) {
      v.watched = false;
      v.orderNumber = null;
      v.hop = null;
    }
  }

  const videos = [...byKey.values()].sort((a, b) => {
    if (a.watched && b.watched) return (a.orderNumber ?? 1e9) - (b.orderNumber ?? 1e9);
    if (a.watched !== b.watched) return a.watched ? -1 : 1;
    const sa = a.rofeSimilarity ?? a.proofSimilarity ?? -1;
    const sb = b.rofeSimilarity ?? b.proofSimilarity ?? -1;
    return sb - sa;
  });

  return {
    taskId,
    videos,
    watchedCount: videos.filter(v => v.watched).length,
    scoredCount: videos.filter(v => !v.watched).length,
  };
}
