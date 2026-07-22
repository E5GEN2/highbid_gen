import { getPool } from '@/lib/db';
import { reMeasureChannels } from '@/lib/channel-remeasure';

/**
 * Channel Growth Watcher — Phase 1 (capture + liveness) + Phase 2 (staging
 * ladder + per-video deep-track). See docs/growth-watcher/spec.md.
 *
 * Enrolls small (<100-sub) already-collected channels and captures a DAILY
 * snapshot of their subs / video_count so channel growth can be documented over
 * time. Channels that show life climb a ladder that fetches progressively more:
 *
 *   liveness   stats-only (~0.02 u/ch)         the wide net (~59K channels)
 *   pulse      + recent uploads (~2 u/ch)      showed life (new upload / subs jump)
 *   traction   + per-video view snapshots      sustained velocity over 7d
 *   documented same as traction, sticky        confirmed risers — the showcase set
 *   dormant    stats-only @ 7d cadence         no life for N scans; auto-resurrects
 *
 * Promotion/demotion is data-driven each pass; the expensive tiers stay small
 * because only genuinely-growing channels earn them, and a daily budget cap
 * (growth_deep_max_per_day) bounds the deep waves regardless. All thresholds
 * are admin_config-tunable (defaults below).
 *
 * Runs on its OWN interval (a scan batch is several sequential YT calls and must
 * not stall the 60s runAll flywheel ticks) + a cluster-wide advisory lock.
 * Kill switch: admin_config growth_watcher_enabled ('false' disables).
 */
const GROWTH_LOCK = 728412003;         // distinct from cg-sweep (…001) + niche-watcher (…002)
const ENROLL_BATCH = 2000;             // new small channels enrolled per tick
const SCAN_BATCH = 300;                // liveness/dormant channels scanned per tick (stats-only, 50/call)
const DEEP_BATCH = 40;                 // pulse/traction/documented channels per tick (sequential 2u pulls, ~0.5s each)
const LIVE_CADENCE_H = 20;             // ~daily re-scan for every active stage (<24h so a daily snapshot always lands)
const DORMANT_CADENCE_H = 168;         // dormant channels re-checked weekly
const MAX_SUBS_ENROLL = 100;           // catch net: < 100 subs
const VIDEOS_PER_CHANNEL_SNAP = 30;    // newest N videos snapshotted per deep channel

/** Tunables (admin_config key → default). All read each tick. */
interface GrowthCfg {
  pulseMinGain: number;        // liveness→pulse: subs gained in one ~daily step (growth_pulse_min_gain)
  tractionVelocity: number;    // pulse→traction: fractional subs growth over 7d, e.g. 0.30 (growth_traction_velocity_7d)
  tractionMinGain: number;     // pulse→traction: AND absolute subs gained over 7d (growth_traction_min_gain)
  documentedUpDays: number;    // traction→documented: consecutive up-scans (growth_documented_up_days)
  documentedMinSubs: number;   // traction→documented: AND current subs floor (growth_documented_min_subs)
  demoteDeadScans: number;     // pulse/traction→down: consecutive lifeless scans (growth_demote_dead_scans)
  dormantDeadScans: number;    // liveness→dormant: consecutive lifeless scans (growth_dormant_dead_scans)
  deepMaxPerDay: number;       // budget cap on deep (2u) scans per day (growth_deep_max_per_day)
}

async function loadCfg(): Promise<GrowthCfg & { enabled: boolean }> {
  const pool = await getPool();
  const r = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config WHERE key LIKE 'growth_%'`,
  );
  const c: Record<string, string> = {};
  for (const row of r.rows) c[row.key] = row.value;
  return {
    enabled:           (c.growth_watcher_enabled ?? 'true') !== 'false',
    pulseMinGain:      parseInt(c.growth_pulse_min_gain) || 10,
    tractionVelocity:  parseFloat(c.growth_traction_velocity_7d) || 0.30,
    tractionMinGain:   parseInt(c.growth_traction_min_gain) || 50,
    documentedUpDays:  parseInt(c.growth_documented_up_days) || 5,
    documentedMinSubs: parseInt(c.growth_documented_min_subs) || 500,
    demoteDeadScans:   parseInt(c.growth_demote_dead_scans) || 7,
    dormantDeadScans:  parseInt(c.growth_dormant_dead_scans) || 14,
    deepMaxPerDay:     parseInt(c.growth_deep_max_per_day) || 10000,
  };
}

export interface GrowthWatcherResult {
  enabled: boolean;
  skipped: boolean;
  enrolled: number;
  scanned: number;       // liveness/dormant channels scanned (stats-only)
  deepScanned: number;   // pulse/traction/documented channels scanned (full)
  snapshotted: number;   // channel snapshot rows written
  videoSnaps: number;    // video snapshot rows written (traction/documented)
  promoted: number;      // stage went UP this tick
  demoted: number;       // stage went DOWN this tick (incl. →dormant)
  lives: number;
  ms: number;
}

/** Enroll small channels not yet tracked (idempotent, bounded, index-driven). */
async function enrollCandidates(batch: number): Promise<number> {
  const pool = await getPool();
  const r = await pool.query(
    `INSERT INTO growth_tracked_channels
       (channel_id, first_caught_subs, first_caught_video_count, last_subs, last_video_count)
     SELECT sc.channel_id, sc.subscriber_count, sc.video_count, sc.subscriber_count, sc.video_count
       FROM niche_spy_channels sc
      WHERE sc.subscriber_count IS NOT NULL
        AND sc.subscriber_count < $1
        AND NOT EXISTS (SELECT 1 FROM growth_tracked_channels g WHERE g.channel_id = sc.channel_id)
      LIMIT $2
     ON CONFLICT (channel_id) DO NOTHING`,
    [MAX_SUBS_ENROLL, batch],
  );
  return r.rowCount ?? 0;
}

interface TrackedRow {
  channel_id: string;
  stage: string;
  last_subs: string | null;
  last_video_count: number | null;
  first_caught_subs: string | null;
  dead_scans: number;
  up_days: number;
}

interface ScanOutcome { snapshotted: number; lives: number; promoted: number; demoted: number; videoSnaps: number }

/**
 * Scan one wave of due channels: re-measure (depth per wave), write the daily
 * channel snapshot, compute stage transitions, persist state. deep=true adds
 * recent-uploads fetch + (for traction/documented) per-video snapshots.
 */
async function scanWave(rows: TrackedRow[], deep: boolean, cfg: GrowthCfg): Promise<ScanOutcome> {
  const out: ScanOutcome = { snapshotted: 0, lives: 0, promoted: 0, demoted: 0, videoSnaps: 0 };
  if (rows.length === 0) return out;
  const pool = await getPool();
  const ids = rows.map(r => r.channel_id);
  const prev = new Map(rows.map(r => [r.channel_id, r]));

  await reMeasureChannels(ids, deep ? { recentUploads: true, maxRecent: 15 } : { recentUploads: false });

  const fresh = await pool.query<{ channel_id: string; subscriber_count: string | null; total_views: string | null; video_count: number | null; recent_videos_avg_views: string | null }>(
    `SELECT channel_id, subscriber_count, total_views, video_count, recent_videos_avg_views
       FROM niche_spy_channels WHERE channel_id = ANY($1)`,
    [ids],
  );

  // 7d-ago subs (closest snapshot ≥6 days back) for velocity — only needed for
  // pulse→traction checks, but cheap for the bounded batch via the day index.
  const velRes = await pool.query<{ channel_id: string; subs_7d: string | null }>(
    `SELECT g.channel_id, s.subscriber_count::text AS subs_7d
       FROM unnest($1::text[]) AS g(channel_id)
       LEFT JOIN LATERAL (
         SELECT subscriber_count FROM channel_growth_snapshots
          WHERE channel_id = g.channel_id AND day <= CURRENT_DATE - 6
          ORDER BY day DESC LIMIT 1
       ) s ON true`,
    [ids],
  );
  const subs7d = new Map<string, number | null>(
    velRes.rows.map(r => [r.channel_id, r.subs_7d != null ? parseInt(r.subs_7d) : null]),
  );

  const snapVals: string[] = [];
  const snapParams: unknown[] = [];
  let sp = 0;
  const statePayload: Array<{
    c: string; s: number | null; v: number | null; life: boolean; gs: number;
    stage: string; dead: number; up: number; cad: number; moved: 1 | 0 | -1;
  }> = [];

  for (const f of fresh.rows) {
    const p = prev.get(f.channel_id);
    if (!p) continue;
    const subs = f.subscriber_count != null ? parseInt(f.subscriber_count) : null;
    const vc = f.video_count;
    const totalViews = f.total_views != null ? parseInt(f.total_views) : null;
    const recentAvg = f.recent_videos_avg_views != null ? parseInt(f.recent_videos_avg_views) : null;
    const prevSubs = p.last_subs != null ? parseInt(p.last_subs) : null;
    const prevVc = p.last_video_count;
    const caughtSubs = p.first_caught_subs != null ? parseInt(p.first_caught_subs) : null;

    const subsDelta = (subs != null && prevSubs != null) ? subs - prevSubs : 0;
    const newUpload = vc != null && prevVc != null && vc > prevVc;
    const life = subsDelta > 0 || newUpload;
    const dead = life ? 0 : p.dead_scans + 1;
    const up = subsDelta > 0 ? p.up_days + 1 : (subsDelta < 0 ? 0 : p.up_days);
    const base7d = subs7d.get(f.channel_id);
    const vel7d = (subs != null && base7d != null && base7d > 0) ? (subs - base7d) / base7d : 0;
    const gain7d = (subs != null && base7d != null) ? subs - base7d : 0;

    // ── Stage transitions ────────────────────────────────────────────────
    let stage = p.stage;
    let moved: 1 | 0 | -1 = 0;
    if (p.stage === 'liveness') {
      if (newUpload || subsDelta >= cfg.pulseMinGain) { stage = 'pulse'; moved = 1; }
      else if (dead >= cfg.dormantDeadScans) { stage = 'dormant'; moved = -1; }
    } else if (p.stage === 'dormant') {
      if (life) { stage = 'liveness'; moved = 1; }   // resurrection
    } else if (p.stage === 'pulse') {
      if (vel7d >= cfg.tractionVelocity && gain7d >= cfg.tractionMinGain) { stage = 'traction'; moved = 1; }
      else if (dead >= cfg.demoteDeadScans) { stage = 'liveness'; moved = -1; }
    } else if (p.stage === 'traction') {
      if (up >= cfg.documentedUpDays && subs != null && subs >= cfg.documentedMinSubs) { stage = 'documented'; moved = 1; }
      else if (dead >= cfg.demoteDeadScans) { stage = 'pulse'; moved = -1; }
    }
    // documented is sticky (the showcase set keeps its daily history).

    const cad = stage === 'dormant' ? DORMANT_CADENCE_H : LIVE_CADENCE_H;
    const gs = (subs != null && caughtSubs != null) ? (subs - caughtSubs) : 0;

    snapVals.push(`($${++sp}, $${++sp}::bigint, $${++sp}::bigint, $${++sp}, $${++sp}::bigint, $${++sp}, $${++sp})`);
    snapParams.push(f.channel_id, subs, totalViews, vc, recentAvg, stage, deep ? 'deep' : 'liveness');
    statePayload.push({ c: f.channel_id, s: subs, v: vc, life, gs, stage, dead, up, cad, moved });
  }

  if (snapVals.length > 0) {
    const res = await pool.query(
      `INSERT INTO channel_growth_snapshots
         (channel_id, subscriber_count, total_views, video_count, recent_avg_views, stage, source)
       VALUES ${snapVals.join(', ')}
       ON CONFLICT (channel_id, day) DO NOTHING`,
      snapParams,
    ).catch((e) => { console.error('[growth-watcher] snapshot insert failed:', (e as Error).message); return { rowCount: 0 }; });
    out.snapshotted = res.rowCount ?? 0;
  }

  out.lives = statePayload.filter(x => x.life).length;
  out.promoted = statePayload.filter(x => x.moved === 1).length;
  out.demoted = statePayload.filter(x => x.moved === -1).length;

  await pool.query(
    `UPDATE growth_tracked_channels g SET
       last_subs = COALESCE((x->>'s')::bigint, g.last_subs),
       last_video_count = COALESCE((x->>'v')::int, g.last_video_count),
       last_scanned_at = NOW(),
       next_due_at = NOW() + ((x->>'cad') || ' hours')::interval,
       showed_life = g.showed_life OR (x->>'life')::boolean,
       growth_score = (x->>'gs')::double precision,
       stage = x->>'stage',
       dead_scans = (x->>'dead')::int,
       up_days = (x->>'up')::int,
       promoted_at = CASE WHEN (x->>'moved')::int = 1 THEN NOW() ELSE g.promoted_at END
     FROM jsonb_array_elements($1::jsonb) x
     WHERE g.channel_id = x->>'c'`,
    [JSON.stringify(statePayload)],
  ).catch((e) => console.error('[growth-watcher] state update failed:', (e as Error).message));

  // Channels reMeasure returned no row for still get their due-stamp bumped so
  // they can't wedge the queue (deleted/terminated channels cycle harmlessly).
  const refreshed = new Set(fresh.rows.map(r => r.channel_id));
  const stalled = ids.filter(id => !refreshed.has(id));
  if (stalled.length > 0) {
    await pool.query(
      `UPDATE growth_tracked_channels SET next_due_at = NOW() + ($2 || ' hours')::interval, last_scanned_at = NOW()
        WHERE channel_id = ANY($1)`,
      [stalled, String(LIVE_CADENCE_H)],
    ).catch(() => {});
  }

  // ── Per-video snapshots (traction/documented only) ─────────────────────
  // The deep re-measure just refreshed niche_spy_videos view counts for these
  // channels; capture the newest N per channel into the daily video history.
  if (deep) {
    const deepDocIds = statePayload
      .filter(x => x.stage === 'traction' || x.stage === 'documented')
      .map(x => x.c);
    if (deepDocIds.length > 0) {
      const res = await pool.query(
        `INSERT INTO video_growth_snapshots (video_id, view_count, like_count, comment_count)
         SELECT id, view_count, like_count, comment_count FROM (
           SELECT v.id, v.view_count, v.like_count, v.comment_count,
                  ROW_NUMBER() OVER (PARTITION BY v.channel_id ORDER BY v.posted_at DESC NULLS LAST) rn
             FROM niche_spy_videos v
            WHERE v.channel_id = ANY($1)
         ) t WHERE t.rn <= $2
         ON CONFLICT (video_id, day) DO NOTHING`,
        [deepDocIds, VIDEOS_PER_CHANNEL_SNAP],
      ).catch((e) => { console.error('[growth-watcher] video snapshot failed:', (e as Error).message); return { rowCount: 0 }; });
      out.videoSnaps = res.rowCount ?? 0;
    }
  }

  return out;
}

/** Select due channels for a stage set, oldest-due first. Deep wave orders by
 *  growth_score DESC first so the hottest channels never starve under the cap. */
async function selectDue(stages: string[], limit: number, hotFirst: boolean): Promise<TrackedRow[]> {
  const pool = await getPool();
  const r = await pool.query<TrackedRow>(
    `SELECT channel_id, stage, last_subs, last_video_count, first_caught_subs,
            COALESCE(dead_scans, 0) AS dead_scans, COALESCE(up_days, 0) AS up_days
       FROM growth_tracked_channels
      WHERE stage = ANY($1) AND (next_due_at IS NULL OR next_due_at <= NOW())
      ORDER BY ${hotFirst ? 'growth_score DESC NULLS LAST,' : ''} next_due_at ASC NULLS FIRST
      LIMIT $2`,
    [stages, limit],
  );
  return r.rows;
}

/** Deep (2u) scans already spent today — enforces growth_deep_max_per_day. */
async function deepSpentToday(): Promise<number> {
  const pool = await getPool();
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM channel_growth_snapshots WHERE day = CURRENT_DATE AND source = 'deep'`,
  );
  return parseInt(r.rows[0]?.n ?? '0');
}

/** One growth-watcher tick — safe to call on a ~60s interval. No-op if disabled
 *  or another tick holds the advisory lock. force=true bypasses the enabled
 *  flag (the admin controlled-test path). */
export async function runGrowthWatcherTick(opts: { force?: boolean } = {}): Promise<GrowthWatcherResult> {
  const t0 = Date.now();
  const base: GrowthWatcherResult = {
    enabled: true, skipped: false, enrolled: 0, scanned: 0, deepScanned: 0,
    snapshotted: 0, videoSnaps: 0, promoted: 0, demoted: 0, lives: 0, ms: 0,
  };
  const cfg = await loadCfg();
  if (!opts.force && !cfg.enabled) return { ...base, enabled: false, ms: Date.now() - t0 };

  const pool = await getPool();
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [GROWTH_LOCK]);
    if (!lock.rows[0]?.locked) return { ...base, skipped: true, ms: Date.now() - t0 };
    try {
      base.enrolled = await enrollCandidates(ENROLL_BATCH)
        .catch((e) => { console.error('[growth-watcher] enroll failed:', (e as Error).message); return 0; });

      // Deep wave (pulse/traction/documented) — budget-capped per day.
      const spent = await deepSpentToday().catch(() => 0);
      const deepAllowance = Math.max(0, Math.min(DEEP_BATCH, cfg.deepMaxPerDay - spent));
      if (deepAllowance > 0) {
        const deepRows = await selectDue(['pulse', 'traction', 'documented'], deepAllowance, true);
        if (deepRows.length > 0) {
          const r = await scanWave(deepRows, true, cfg)
            .catch((e) => { console.error('[growth-watcher] deep wave failed:', (e as Error).message); return null; });
          if (r) {
            base.deepScanned = deepRows.length;
            base.snapshotted += r.snapshotted; base.videoSnaps += r.videoSnaps;
            base.promoted += r.promoted; base.demoted += r.demoted; base.lives += r.lives;
          }
        }
      }

      // Liveness wave (liveness/dormant) — stats-only, the wide net.
      const liveRows = await selectDue(['liveness', 'dormant'], SCAN_BATCH, false);
      if (liveRows.length > 0) {
        const r = await scanWave(liveRows, false, cfg)
          .catch((e) => { console.error('[growth-watcher] liveness wave failed:', (e as Error).message); return null; });
        if (r) {
          base.scanned = liveRows.length;
          base.snapshotted += r.snapshotted;
          base.promoted += r.promoted; base.demoted += r.demoted; base.lives += r.lives;
        }
      }

      return { ...base, ms: Date.now() - t0 };
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [GROWTH_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
}