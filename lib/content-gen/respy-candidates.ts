/**
 * RE-SPY candidate selection — Loop A's maintenance mode.
 *
 * Two discovery modes, deliberately non-overlapping:
 *   novelty — crawls clusters we have NEVER crawled (opens new niches)
 *   respy   — crawls clusters we HAVE crawled, to track their development  ← this file
 *
 * ── Rebuild-proof by construction ────────────────────────────────────────────
 * Clusters are REBUILT ~weekly by the distributed kNN engine, and cluster ids are
 * run-scoped: today only 256 of 1,034 ever-crawled cluster ids still exist in the
 * live tree — 778 are orphaned by past rebuilds. Keying learned stats on
 * `niche_discovery_seeds.origin_cluster_id` would therefore wipe our history every
 * week, at almost exactly the rate a ~5.4-day crawl cycle accumulates it. The
 * scorer would permanently see "everything unexplored" and never learn.
 *
 * So we do NOT key stats on cluster id. The durable facts — *this seed crawl found
 * N new channels* — hang off the SEED VIDEO, which is stable. Cluster membership is
 * applied at QUERY time by joining each seed video to its assignment in the CURRENT
 * tree run. After a rebuild the same facts simply re-aggregate into the new
 * clusters: no migration, no history loss, and nothing required from the clustering
 * engine. As a bonus this beats fixing `origin_cluster_id` (populated on only ~24%
 * of seeds) since every seed video with an assignment now counts.
 *
 * ── Scoring: PRIORITISATION, never exclusion ─────────────────────────────────
 *   score = expected_yield x recency_factor + staleness_bonus
 *
 * All three terms are measured, and all are SOFT — no cluster is ever filtered out
 * or blacklisted, because formats reignite: a niche that is dead in July can be hot
 * in October, and a hard filter would never find out. The staleness term grows
 * without bound so every cluster is eventually revisited no matter how poorly it
 * scored before.
 *
 *   expected_yield  — mean new_channels per crawl for the cluster. Measured
 *                     persistent: split-half r=0.68 (>=2 crawls per half), true
 *                     between-cluster SD ~10 on a mean of ~20. Genuinely learnable.
 *   recency_factor  — from the measured replenishment curve: yield is 11.2 when a
 *                     cluster is re-crawled <12h after the last visit vs ~18.5 once
 *                     >=24h have passed, and it SATURATES there (7-14d gives 20.5,
 *                     14d+ dips to 18.0). So this only penalises coming back too
 *                     soon; it does not reward waiting longer.
 *   staleness_bonus — coverage guarantee, and the reason nothing starves.
 *
 * NOTE we deliberately do NOT model a per-cluster replenishment RATE. It measured
 * non-persistent (split-half r=0.117 vs 0.68 for plain yield) and, more decisively,
 * fleet capacity forces ~5.4-day revisit gaps — always past the 24h saturation
 * point — so the rate could not be exploited even if it were real.
 */
import { getPool } from '../db';

export interface RespyCandidate {
  video_id: number;
  url: string;
  title: string | null;
  cluster_id: number;
  score: number;
  expected_yield: number;
  hours_since_last_crawl: number | null;
  prior_crawls: number;
}

/** Measured replenishment curve: only penalises re-crawling too soon. */
function recencyFactor(hoursSince: number | null): number {
  if (hoursSince == null) return 1;      // never crawled in the current mapping
  if (hoursSince >= 24) return 1;        // saturated — no further gain from waiting
  if (hoursSince >= 12) return 0.85;
  return 0.6;                            // <12h: measured ~40% yield penalty
}

/**
 * Pick clusters worth revisiting and one un-seeded video from each.
 * One cluster per candidate: re-crawling the same neighbourhood twice in a wave
 * would collide with the dispatcher's own region lock.
 */
export async function findRespyCandidates(limit = 20): Promise<RespyCandidate[]> {
  const pool = await getPool();
  const res = await pool.query<{
    video_id: string; url: string; title: string | null; cluster_id: string;
    expected_yield: string; hours_since: string | null; prior_crawls: string; score: string;
  }>(
    `WITH latest_run AS (
       SELECT id FROM niche_tree_runs
        WHERE kind = 'global' AND status = 'done'
        ORDER BY started_at DESC NULLS LAST LIMIT 1
     ),
     -- Crawl history re-projected onto the CURRENT tree (see header): join each
     -- previously-crawled SEED VIDEO to whatever cluster it belongs to today.
     hist AS (
       SELECT a.cluster_id,
              AVG(s.new_channels)::float  AS expected_yield,
              MAX(s.completed_at)         AS last_crawl,
              COUNT(*)                    AS prior_crawls
         FROM niche_discovery_seeds s
         JOIN niche_tree_assignments a
           ON a.video_id = s.seed_video_id
          AND a.run_id = (SELECT id FROM latest_run)
        WHERE s.new_channels IS NOT NULL
          AND s.completed_at IS NOT NULL
        GROUP BY a.cluster_id
     ),
     scored AS (
       SELECT h.cluster_id, h.expected_yield, h.prior_crawls,
              EXTRACT(EPOCH FROM (NOW() - h.last_crawl))/3600.0 AS hours_since
         FROM hist h
     ),
     -- One un-seeded, view-worthy video per cluster to act as the seed.
     pick AS (
       SELECT DISTINCT ON (a.cluster_id)
              a.cluster_id, v.id AS video_id, v.url, v.title
         FROM niche_tree_assignments a
         JOIN niche_spy_videos v ON v.id = a.video_id
        WHERE a.run_id = (SELECT id FROM latest_run)
          AND a.cluster_id IN (SELECT cluster_id FROM scored)
          AND v.url IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM niche_discovery_seeds s2
                 WHERE s2.seed_video_id = v.id AND s2.status <> 'failed')
        ORDER BY a.cluster_id, v.view_count DESC NULLS LAST
     )
     SELECT p.video_id, p.url, p.title, s.cluster_id,
            s.expected_yield, s.hours_since, s.prior_crawls,
            -- expected_yield x recency + staleness (see header: all terms soft)
            ( s.expected_yield
              * CASE WHEN s.hours_since IS NULL THEN 1
                     WHEN s.hours_since >= 24   THEN 1
                     WHEN s.hours_since >= 12   THEN 0.85
                     ELSE 0.6 END
              + LEAST(30, COALESCE(s.hours_since,0) / 24.0)   -- staleness: unbounded-ish, capped for sanity
            ) AS score
       FROM scored s
       JOIN pick p ON p.cluster_id = s.cluster_id
      ORDER BY score DESC
      LIMIT $1`,
    [limit],
  );

  return res.rows.map(r => ({
    video_id: Number(r.video_id),
    url: r.url,
    title: r.title,
    cluster_id: Number(r.cluster_id),
    score: parseFloat(r.score),
    expected_yield: parseFloat(r.expected_yield),
    hours_since_last_crawl: r.hours_since == null ? null : parseFloat(r.hours_since),
    prior_crawls: parseInt(r.prior_crawls),
  }));
}

/** Recency factor is exported for tests/inspection of the curve. */
export const _recencyFactor = recencyFactor;
