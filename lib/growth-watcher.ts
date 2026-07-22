import { getPool } from '@/lib/db';
import { reMeasureChannels } from '@/lib/channel-remeasure';

/**
 * Channel Growth Watcher — Phase 1 (capture + liveness). See
 * docs/growth-watcher/spec.md.
 *
 * Enrolls small (<100-sub) already-collected channels and captures a DAILY
 * snapshot of their subs / video_count so channel growth can be documented over
 * time — the rest of the schema keeps only the LATEST value (niche_spy_channels
 * overwrites in place), so without this the growth curve is unrecoverable.
 *
 * Uses the shared reMeasureChannels engine in STATS-ONLY mode (~0.02 YT units/
 * channel, channels.list batched 50/call) — scanning the whole ~59K <100-sub
 * corpus daily costs ~1.2K units, a rounding error against the 11K-key pool, so
 * this never dents the discovery enricher's quota (the #1 KPI).
 *
 * Runs on its OWN interval (a scan batch is several sequential YT calls and must
 * not stall the 60s runAll flywheel ticks) + a cluster-wide advisory lock.
 * Kill switch: admin_config growth_watcher_enabled ('false' disables).
 * Phase 2 adds the promotion ladder (pulse/traction/documented) + per-video
 * snapshots; Phase 1 keeps every channel at 'liveness' and just captures.
 */
const GROWTH_LOCK = 728412003;         // distinct from cg-sweep (…001) + niche-watcher (…002)
const ENROLL_BATCH = 2000;             // new small channels enrolled per tick (self-populates over a few ticks)
const SCAN_BATCH = 300;                // channels liveness-scanned + snapshotted per tick (stats-only, 50/call → ~6 API calls)
const LIVENESS_CADENCE_HOURS = 20;     // re-scan each tracked channel ~daily (< 24h so a daily snapshot always lands)
const MAX_SUBS_ENROLL = 100;           // Phase-1 catch net: < 100 subs

export interface GrowthWatcherResult {
  enabled: boolean;
  skipped: boolean;      // another tick held the lock
  enrolled: number;      // new channels added to tracking this tick
  scanned: number;       // channels liveness-scanned this tick
  snapshotted: number;   // daily snapshot rows written this tick
  lives: number;         // channels that grew (subs or video_count up) since last pass
  ms: number;
}

async function isEnabled(): Promise<boolean> {
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(`SELECT value FROM admin_config WHERE key = 'growth_watcher_enabled'`);
  return (r.rows[0]?.value ?? 'true') !== 'false';   // default ON
}

/** Enroll small (<100-sub) channels not yet tracked. Set-based + bounded +
 *  idempotent; rides idx_nsc_small_subs so it never seq-scans niche_spy_channels.
 *  Runs every tick so newly-discovered small channels get picked up over time. */
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

/** Liveness-scan the most-due tracked channels: stats-only re-measure, then
 *  write a daily snapshot + update per-channel delta state. */
async function scanDue(batch: number): Promise<{ scanned: number; snapshotted: number; lives: number }> {
  const pool = await getPool();
  const due = await pool.query<{ channel_id: string; last_subs: string | null; last_video_count: number | null; first_caught_subs: string | null }>(
    `SELECT channel_id, last_subs, last_video_count, first_caught_subs
       FROM growth_tracked_channels
      WHERE stage <> 'dormant' AND (next_due_at IS NULL OR next_due_at <= NOW())
      ORDER BY next_due_at ASC NULLS FIRST
      LIMIT $1`,
    [batch],
  );
  if (due.rows.length === 0) return { scanned: 0, snapshotted: 0, lives: 0 };
  const ids = due.rows.map(r => r.channel_id);
  const prev = new Map(due.rows.map(r => [r.channel_id, r]));

  // Liveness pulse — stats only (subs + video_count). reMeasureChannels writes
  // the fresh values into niche_spy_channels; we read them back to snapshot.
  await reMeasureChannels(ids, { recentUploads: false });

  const fresh = await pool.query<{ channel_id: string; subscriber_count: string | null; total_views: string | null; video_count: number | null; recent_videos_avg_views: string | null }>(
    `SELECT channel_id, subscriber_count, total_views, video_count, recent_videos_avg_views
       FROM niche_spy_channels WHERE channel_id = ANY($1)`,
    [ids],
  );

  // Build the daily snapshot rows + the per-channel state-update payload.
  const snapVals: string[] = [];
  const snapParams: unknown[] = [];
  let sp = 0;
  const statePayload: Array<{ c: string; s: number | null; v: number | null; life: boolean; gs: number }> = [];
  for (const f of fresh.rows) {
    const subs = f.subscriber_count != null ? parseInt(f.subscriber_count) : null;
    const vc = f.video_count;
    const totalViews = f.total_views != null ? parseInt(f.total_views) : null;
    const recentAvg = f.recent_videos_avg_views != null ? parseInt(f.recent_videos_avg_views) : null;
    snapVals.push(`($${++sp}, $${++sp}::bigint, $${++sp}::bigint, $${++sp}, $${++sp}::bigint, 'liveness', 'liveness')`);
    snapParams.push(f.channel_id, subs, totalViews, vc, recentAvg);
    const p = prev.get(f.channel_id);
    const prevSubs = p?.last_subs != null ? parseInt(p.last_subs) : null;
    const prevVc = p?.last_video_count ?? null;
    const caughtSubs = p?.first_caught_subs != null ? parseInt(p.first_caught_subs) : null;
    const life = (subs != null && prevSubs != null && subs > prevSubs) || (vc != null && prevVc != null && vc > prevVc);
    const gs = (subs != null && caughtSubs != null) ? (subs - caughtSubs) : 0;
    statePayload.push({ c: f.channel_id, s: subs, v: vc, life, gs });
  }

  let snapshotted = 0;
  if (snapVals.length > 0) {
    const res = await pool.query(
      `INSERT INTO channel_growth_snapshots
         (channel_id, subscriber_count, total_views, video_count, recent_avg_views, stage, source)
       VALUES ${snapVals.join(', ')}
       ON CONFLICT (channel_id, day) DO NOTHING`,
      snapParams,
    ).catch((e) => { console.error('[growth-watcher] snapshot insert failed:', (e as Error).message); return { rowCount: 0 }; });
    snapshotted = res.rowCount ?? 0;
  }

  // Update tracked state (delta detection) for EVERY scanned channel — even ones
  // reMeasure couldn't refresh get next_due_at bumped so the queue keeps moving.
  const lives = statePayload.filter(x => x.life).length;
  await pool.query(
    `UPDATE growth_tracked_channels g SET
       last_subs = COALESCE((x->>'s')::bigint, g.last_subs),
       last_video_count = COALESCE((x->>'v')::int, g.last_video_count),
       last_scanned_at = NOW(),
       next_due_at = NOW() + ($2 || ' hours')::interval,
       showed_life = g.showed_life OR (x->>'life')::boolean,
       growth_score = (x->>'gs')::double precision
     FROM jsonb_array_elements($1::jsonb) x
     WHERE g.channel_id = x->>'c'`,
    [JSON.stringify(statePayload), String(LIVENESS_CADENCE_HOURS)],
  ).catch((e) => console.error('[growth-watcher] state update failed:', (e as Error).message));
  // Bump channels reMeasure returned no row for (so they don't wedge the queue).
  const refreshed = new Set(fresh.rows.map(r => r.channel_id));
  const stalled = ids.filter(id => !refreshed.has(id));
  if (stalled.length > 0) {
    await pool.query(
      `UPDATE growth_tracked_channels SET next_due_at = NOW() + ($2 || ' hours')::interval, last_scanned_at = NOW()
        WHERE channel_id = ANY($1)`,
      [stalled, String(LIVENESS_CADENCE_HOURS)],
    ).catch(() => {});
  }

  return { scanned: ids.length, snapshotted, lives };
}

/** One growth-watcher tick — safe to call on a ~60s interval. No-op if disabled
 *  or another tick holds the advisory lock. */
export async function runGrowthWatcherTick(opts: { force?: boolean } = {}): Promise<GrowthWatcherResult> {
  const t0 = Date.now();
  const base: GrowthWatcherResult = { enabled: true, skipped: false, enrolled: 0, scanned: 0, snapshotted: 0, lives: 0, ms: 0 };
  // force=true = the admin controlled-test path (runs even while the flag is off).
  if (!opts.force && !(await isEnabled())) return { ...base, enabled: false, ms: Date.now() - t0 };

  const pool = await getPool();
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [GROWTH_LOCK]);
    if (!lock.rows[0]?.locked) return { ...base, skipped: true, ms: Date.now() - t0 };
    try {
      const enrolled = await enrollCandidates(ENROLL_BATCH).catch((e) => { console.error('[growth-watcher] enroll failed:', (e as Error).message); return 0; });
      const scan = await scanDue(SCAN_BATCH).catch((e) => { console.error('[growth-watcher] scan failed:', (e as Error).message); return { scanned: 0, snapshotted: 0, lives: 0 }; });
      return { enabled: true, skipped: false, enrolled, scanned: scan.scanned, snapshotted: scan.snapshotted, lives: scan.lives, ms: Date.now() - t0 };
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [GROWTH_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
