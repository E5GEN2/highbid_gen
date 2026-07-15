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
const REFRESH_REEVAL_BATCH = 300;
const REEVAL_AFTER_DAYS = 21;

export interface CgSweepResult {
  enabled: boolean;
  skipped: boolean;     // true = another sweep held the lock (NOT "nothing to do")
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
 *  channels not yet tracked. SET-BASED: discovered_at and first-touch lineage
 *  are computed as batch CTEs (GROUP BY / DISTINCT ON), NOT per-channel LATERALs
 *  — the per-channel LATERAL over the 1.7M-row niche_seed_expansions was O(batch)
 *  slow queries that timed out + lock-contended (incident 2026-07-12). The
 *  first-touch join now rides idx_nse_cand_vid. Only the tiny niche_discovery_seeds
 *  source lookup stays a LATERAL (that table is ~thousands of rows). */
async function discoverStamp(batch: number): Promise<number> {
  const pool = await getPool();
  const res = await pool.query(
    `WITH todo AS (
       SELECT sc.channel_id
         FROM niche_spy_channels sc
        WHERE NOT EXISTS (SELECT 1 FROM channel_cg_status s WHERE s.channel_id = sc.channel_id)
        LIMIT $1
     ),
     disc AS (
       SELECT v.channel_id, MIN(COALESCE(v.fetched_at, v.synced_at)) AS discovered_at
         FROM niche_spy_videos v
        WHERE v.channel_id IN (SELECT channel_id FROM todo)
        GROUP BY v.channel_id
     ),
     ft AS (
       SELECT DISTINCT ON (v.channel_id) v.channel_id, nse.seed_video_id, nse.task_id
         FROM niche_seed_expansions nse
         JOIN niche_spy_videos v ON v.id = nse.candidate_video_id
        WHERE v.channel_id IN (SELECT channel_id FROM todo)
        ORDER BY v.channel_id, nse.detected_at ASC
     )
     INSERT INTO channel_cg_status
       (channel_id, discovered_at, discovered_by_seed_video_id, discovered_by_task_id, discovered_source)
     SELECT t.channel_id, disc.discovered_at, ft.seed_video_id, ft.task_id, COALESCE(ds.source, 'other')
       FROM todo t
       LEFT JOIN disc ON disc.channel_id = t.channel_id
       LEFT JOIN ft   ON ft.channel_id = t.channel_id
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
  // CRITICAL: evaluateChannelEligibility only returns channels that have at least
  // one view-enriched video (its per_channel CTE). A channel that got its
  // subscriber_count (Phase 2) but whose videos aren't view-enriched yet (Phase 1
  // lagging) yields NO row → without this it never gets stamped, stays
  // cg_evaluated_at=NULL, and CLOGS the eval queue forever, stalling the whole
  // sweep (incident 2026-07-15). Stamp those as not_enriched so they leave the
  // queue; refreshedReEval re-scores them once Phase 1 fills their videos.
  const scored = new Set(evals.map(e => e.channel_id));
  const payload: Array<{ c: string; e: boolean; f: string[] }> = evals.map(e => ({ c: e.channel_id, e: e.eligible, f: e.fail_reasons }));
  for (const c of channelIds) if (!scored.has(c)) payload.push({ c, e: false, f: ['not_enriched'] });
  if (payload.length === 0) return { evaluated: 0, eligible: 0 };
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
  return { evaluated: payload.length, eligible: evals.filter(e => e.eligible).length };
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
 * DATA-COMPLETENESS re-eval — self-heals channels scored before Phase 1 filled
 * their video view-counts. Such channels fail on data-completeness gates
 * (not_enriched = no scoreable videos, topview_zero = top video 0 views,
 * min_videos = <5 view-enriched videos); once Phase 1 catches up, re-scoring
 * flips the ones that now qualify. (Superseded the old Phase-4
 * last_recent_videos_fetched_at signal — that field has been dead since 6-28, so
 * it never fired.) A cooldown (evaluated >REEVAL_DATA_COOLDOWN ago, oldest first)
 * gives Phase 1 time to fill the videos and stops us re-scoring the same channel
 * every tick; genuinely-complete failures (subs_band/age/view_floor with real
 * data) are excluded, so this doesn't churn the whole table.
 */
const REEVAL_DATA_COOLDOWN_H = 4;
async function refreshedReEval(batch: number): Promise<{ evaluated: number; eligible: number }> {
  const pool = await getPool();
  const r = await pool.query<{ channel_id: string }>(
    `SELECT s.channel_id
       FROM channel_cg_status s
       JOIN niche_spy_channels sc ON sc.channel_id = s.channel_id AND sc.subscriber_count IS NOT NULL
      WHERE NOT s.cg_eligible
        AND s.cg_fail_reasons && ARRAY['not_enriched','topview_zero','min_videos']
        AND s.cg_evaluated_at < NOW() - ($2 || ' hours')::interval
      ORDER BY s.cg_evaluated_at ASC
      LIMIT $1`,
    [batch, String(REEVAL_DATA_COOLDOWN_H)],
  );
  return stampEval(r.rows.map(x => x.channel_id));
}

// Cluster-wide mutex: a dedicated pooled client holds pg_try_advisory_lock for
// the whole tick, so two runCgSweepTick calls (auto tick + manual backfill, or
// two app instances during a deploy swap) can never BOTH stamp at once — the
// loser returns immediately. Held on a dedicated client (session advisory locks
// are per-connection; unlock must be the same connection).
const CG_SWEEP_LOCK = 728412001;
let cgTickCounter = 0;  // throttles the (heavier) data-completeness recovery pass to ~every 10th auto-tick

/**
 * One sweep tick. Safe to call every 60s. `mult` scales the batch sizes for
 * on-demand backfill (the admin endpoint passes a higher value). No-op if the
 * advisory lock is already held by another sweep.
 */
export async function runCgSweepTick(mult = 1): Promise<CgSweepResult> {
  const t0 = Date.now();
  const base: CgSweepResult = { enabled: true, skipped: false, discovered: 0, evaluated: 0, reevaluated: 0, eligibleInBatch: 0, ms: 0 };
  if (!(await isEnabled())) return { ...base, enabled: false };

  const pool = await getPool();
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [CG_SWEEP_LOCK]);
    if (!lock.rows[0]?.locked) return { ...base, skipped: true, ms: Date.now() - t0 };  // another sweep is running
    try {
      const discovered = await discoverStamp(DISCOVER_BATCH * mult).catch(() => 0);
      const ev = await evalStamp(EVAL_BATCH * mult).catch(() => ({ evaluated: 0, eligible: 0 }));
      const re = await reEvalStamp(REEVAL_BATCH * mult).catch(() => ({ evaluated: 0, eligible: 0 }));
      // refreshedReEval scans a large fail-reason set (~2s) and isn't time-critical
      // (channels recover within hours), so throttle it to ~every 10th auto-tick;
      // run it every tick during a manual backfill (mult>1) so recovery drains fast.
      cgTickCounter++;
      const rr = (mult > 1 || cgTickCounter % 10 === 0)
        ? await refreshedReEval(REFRESH_REEVAL_BATCH * mult).catch(() => ({ evaluated: 0, eligible: 0 }))
        : { evaluated: 0, eligible: 0 };
      return {
        enabled: true, skipped: false, discovered, evaluated: ev.evaluated, reevaluated: re.evaluated + rr.evaluated,
        eligibleInBatch: ev.eligible + re.eligible + rr.eligible, ms: Date.now() - t0,
      };
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [CG_SWEEP_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

export interface CgKpiAlert { level: 'ok' | 'warn' | 'crit'; msg: string; at: string; }

/**
 * KPI alert tick — server-side, so a dip is caught even when nobody's watching
 * the panel (the 6-day enricher outage happened unwatched). Self-throttled to
 * ~hourly; persists admin_config.cg_kpi_alert (surfaced by /cg-kpi) and logs on
 * warn/crit. Thresholds are config-overridable. Kill switch cg_kpi_alert_enabled.
 */
export async function runCgKpiAlertTick(): Promise<CgKpiAlert | null> {
  const pool = await getPool();
  const cfgRes = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config WHERE key IN ('cg_kpi_alert_enabled','cg_kpi_alert_min_per_day','last_cg_kpi_alert_check')`,
  );
  const c: Record<string, string> = {};
  for (const r of cfgRes.rows) c[r.key] = r.value;
  if (c.cg_kpi_alert_enabled === 'false') return null;

  const last = c.last_cg_kpi_alert_check ? new Date(c.last_cg_kpi_alert_check).getTime() : 0;
  if (Date.now() - last < 55 * 60 * 1000) return null;   // ~hourly
  await pool.query(
    `INSERT INTO admin_config (key, value) VALUES ('last_cg_kpi_alert_check', NOW()::text)
       ON CONFLICT (key) DO UPDATE SET value = NOW()::text`,
  ).catch(() => {});

  const minPerDay = parseFloat(c.cg_kpi_alert_min_per_day || '8');
  const m = await pool.query<{ avg_day: string; fetched: string; fetched_subs: string; enrich_status: string | null }>(
    `SELECT
       (SELECT COUNT(*) FROM channel_cg_status WHERE cg_eligible AND discovered_at > NOW() - INTERVAL '7 days')::float / 7 AS avg_day,
       (SELECT COUNT(*) FROM niche_spy_channels WHERE last_channel_fetched_at > NOW() - INTERVAL '24 hours') AS fetched,
       (SELECT COUNT(*) FROM niche_spy_channels WHERE last_channel_fetched_at > NOW() - INTERVAL '24 hours' AND subscriber_count IS NOT NULL) AS fetched_subs,
       (SELECT status FROM niche_yt_enrich_jobs ORDER BY id DESC LIMIT 1) AS enrich_status`,
  );
  const row = m.rows[0];
  const avgDay = parseFloat(row.avg_day) || 0;
  const fetched = parseInt(row.fetched) || 0;
  const subsFill = fetched > 0 ? (parseInt(row.fetched_subs) || 0) / fetched : 1;

  let level: CgKpiAlert['level'] = 'ok';
  const reasons: string[] = [];
  // Leading indicators first (they predict a KPI dip before it shows).
  if (row.enrich_status !== 'running') { level = 'crit'; reasons.push('enricher not running'); }
  if (subsFill < 0.8) { level = level === 'crit' ? 'crit' : 'warn'; reasons.push(`subs-fill ${Math.round(subsFill * 100)}%`); }
  // The KPI itself (only meaningful once the pipeline has matured data).
  if (avgDay < minPerDay) { level = level === 'crit' ? 'crit' : 'warn'; reasons.push(`eligible/day ${avgDay.toFixed(1)} < ${minPerDay}`); }

  const alert: CgKpiAlert = {
    level,
    msg: level === 'ok' ? 'KPI healthy' : reasons.join('; '),
    at: new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO admin_config (key, value) VALUES ('cg_kpi_alert', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(alert)],
  ).catch(() => {});
  if (level !== 'ok') console.error(`[cg-kpi-alert] ${level.toUpperCase()}: ${alert.msg}`);
  return alert;
}
