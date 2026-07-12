/**
 * CG-eligibility sweep — keeps channel_cg_status up to date incrementally so the
 * KPI (cg-eligible channels/day) is a cheap pre-stamped read instead of a heavy
 * ad-hoc aggregation. Runs each tick from instrumentation.ts's 60s runAll loop.
 *
 * Three bounded, indexed passes per tick (kill switch: admin_config
 * cg_sweep_enabled='false'):
 *   1. DISCOVER-stamp — insert a row for each channel not yet tracked, with its
 *      discovered_at (first video sighting) + FIRST-TOUCH seed lineage (the seed
 *      whose expansion first surfaced any of the channel's videos).
 *   2. EVAL-stamp — for tracked+enriched channels not yet evaluated (or at an old
 *      cg_eval_version), run the shared predicate and stamp the verdict.
 *   3. RE-EVAL — refresh a small slice of stale verdicts (age/recency gates drift
 *      over time), so the KPI stays honest without a full re-sweep.
 *
 * All batches are bounded + driven off indexed anti-joins on the ~168K-row
 * channels table (NOT the 2.4M-row videos table) to avoid the seq-scan/pool
 * saturation class of incident.
 */
import { getPool } from '@/lib/db';
import { evaluateChannelEligibility, CG_EVAL_VERSION } from './cg-eligibility';

const DISCOVER_BATCH = 600;
const EVAL_BATCH = 400;
const REEVAL_BATCH = 100;
const REEVAL_AFTER_DAYS = 21;

export interface CgSweepResult {
  enabled: boolean;
  discovered: number;   // rows newly inserted
  evaluated: number;    // rows freshly stamped
  reevaluated: number;  // stale rows refreshed
  eligibleInBatch: number;
  ms: number;
}

async function isEnabled(): Promise<boolean> {
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'cg_sweep_enabled'`,
  );
  // Default ON (only 'false' disables).
  return (r.rows[0]?.value ?? 'true') !== 'false';
}

/** Insert channel_cg_status rows (discovered_at + first-touch lineage) for
 *  channels not yet tracked. Returns count inserted. */
async function discoverStamp(batch: number): Promise<number> {
  const pool = await getPool();
  const res = await pool.query(
    `WITH todo AS (
       SELECT sc.channel_id
         FROM niche_spy_channels sc
        WHERE NOT EXISTS (SELECT 1 FROM channel_cg_status s WHERE s.channel_id = sc.channel_id)
        LIMIT $1
     )
     INSERT INTO channel_cg_status
       (channel_id, discovered_at, discovered_by_seed_video_id, discovered_by_task_id, discovered_source)
     SELECT t.channel_id, disc.discovered_at, ft.seed_video_id, ft.task_id, COALESCE(ds.source, 'other')
       FROM todo t
       LEFT JOIN LATERAL (
         SELECT MIN(COALESCE(v.fetched_at, v.synced_at)) AS discovered_at
           FROM niche_spy_videos v WHERE v.channel_id = t.channel_id
       ) disc ON true
       LEFT JOIN LATERAL (
         -- first-touch: earliest expansion whose candidate video belongs to this channel
         SELECT nse.seed_video_id, nse.task_id
           FROM niche_seed_expansions nse
           JOIN niche_spy_videos v ON v.id = nse.candidate_video_id
          WHERE v.channel_id = t.channel_id
          ORDER BY nse.detected_at ASC
          LIMIT 1
       ) ft ON true
       LEFT JOIN LATERAL (
         SELECT source FROM niche_discovery_seeds WHERE seed_video_id = ft.seed_video_id LIMIT 1
       ) ds ON true
     ON CONFLICT (channel_id) DO NOTHING`,
    [batch],
  );
  return res.rowCount ?? 0;
}

/** Evaluate + stamp a set of channels via the shared predicate. Returns
 *  { evaluated, eligible }. */
async function stampEval(channelIds: string[]): Promise<{ evaluated: number; eligible: number }> {
  if (channelIds.length === 0) return { evaluated: 0, eligible: 0 };
  const pool = await getPool();
  const evals = await evaluateChannelEligibility(channelIds);
  if (evals.length === 0) return { evaluated: 0, eligible: 0 };
  const payload = evals.map(e => ({ c: e.channel_id, e: e.eligible, f: e.fail_reasons }));
  await pool.query(
    `UPDATE channel_cg_status s
        SET cg_eligible = (x->>'e')::boolean,
            cg_fail_reasons = ARRAY(SELECT jsonb_array_elements_text(x->'f')),
            cg_evaluated_at = NOW(),
            cg_eval_version = $2
       FROM jsonb_array_elements($1::jsonb) x
      WHERE s.channel_id = x->>'c'`,
    [JSON.stringify(payload), CG_EVAL_VERSION],
  );
  return { evaluated: evals.length, eligible: evals.filter(e => e.eligible).length };
}

async function evalStamp(batch: number): Promise<{ evaluated: number; eligible: number }> {
  const pool = await getPool();
  const r = await pool.query<{ channel_id: string }>(
    `SELECT s.channel_id
       FROM channel_cg_status s
       JOIN niche_spy_channels sc ON sc.channel_id = s.channel_id AND sc.subscriber_count IS NOT NULL
      WHERE s.cg_evaluated_at IS NULL OR s.cg_eval_version IS DISTINCT FROM $2
      LIMIT $1`,
    [batch, CG_EVAL_VERSION],
  );
  return stampEval(r.rows.map(x => x.channel_id));
}

async function reEvalStamp(batch: number): Promise<{ evaluated: number; eligible: number }> {
  const pool = await getPool();
  const r = await pool.query<{ channel_id: string }>(
    `SELECT s.channel_id
       FROM channel_cg_status s
       JOIN niche_spy_channels sc ON sc.channel_id = s.channel_id AND sc.subscriber_count IS NOT NULL
      WHERE s.cg_evaluated_at IS NOT NULL
        AND s.cg_eval_version = $2
        AND s.cg_evaluated_at < NOW() - ($3 || ' days')::interval
      ORDER BY s.cg_evaluated_at ASC
      LIMIT $1`,
    [batch, CG_EVAL_VERSION, String(REEVAL_AFTER_DAYS)],
  );
  return stampEval(r.rows.map(x => x.channel_id));
}

/**
 * One sweep tick. Safe to call every 60s. `mult` scales the batch sizes for
 * on-demand backfill (the admin endpoint passes a higher value).
 */
export async function runCgSweepTick(mult = 1): Promise<CgSweepResult> {
  const t0 = Date.now();
  if (!(await isEnabled())) {
    return { enabled: false, discovered: 0, evaluated: 0, reevaluated: 0, eligibleInBatch: 0, ms: Date.now() - t0 };
  }
  const discovered = await discoverStamp(DISCOVER_BATCH * mult).catch(() => 0);
  const ev = await evalStamp(EVAL_BATCH * mult).catch(() => ({ evaluated: 0, eligible: 0 }));
  const re = await reEvalStamp(REEVAL_BATCH * mult).catch(() => ({ evaluated: 0, eligible: 0 }));
  return {
    enabled: true,
    discovered,
    evaluated: ev.evaluated,
    reevaluated: re.evaluated,
    eligibleInBatch: ev.eligible + re.eligible,
    ms: Date.now() - t0,
  };
}
