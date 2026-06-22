import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { runSeedSchedulerTick, runSeedReaperTick } from '@/lib/content-gen/seed-scheduler';

/**
 * Auto-seed scheduler control + overwatch.
 *
 * GET  /api/admin/content-gen/auto-seed
 *   Returns the config flags + a live status snapshot: ledger counts by
 *   status, niches currently crawling, recent dispatches, last-tick stamps.
 *
 * POST /api/admin/content-gen/auto-seed
 *   Body: { config?: {<flag>: <value>}, action?: 'run_scheduler'|'run_reaper' }
 *   - config: set any of the auto_seed_* / novelty_auto_recompute_* flags.
 *   - action: manually fire one scheduler or reaper tick now (for testing
 *     without waiting for the cron interval). Respects the same advisory
 *     locks + flags as the cron path.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const FLAG_KEYS = [
  'auto_seed_enabled',
  'auto_seed_min_novelty_pct',
  'auto_seed_max_threads',
  'auto_seed_threads_per_seed',
  'auto_seed_max_seeds_per_tick',
  'auto_seed_loop_number',
  'auto_seed_interval_minutes',
  'novelty_auto_recompute_enabled',
  'novelty_recompute_interval_minutes',
  'seed_english_only',
];
const STAMP_KEYS = [
  'last_seed_schedule_at',
  'last_seed_reaper_at',
  'last_novelty_recompute_at',
  'last_novelty_full_recompute_at',
];

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();

  const cfgRes = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config WHERE key = ANY($1::text[])`,
    [[...FLAG_KEYS, ...STAMP_KEYS]],
  );
  const config: Record<string, string> = {};
  for (const r of cfgRes.rows) config[r.key] = r.value;

  // Ledger status breakdown.
  const ledgerRes = await pool.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*) AS n FROM niche_discovery_seeds GROUP BY status`,
  );
  const ledger: Record<string, number> = {};
  for (const r of ledgerRes.rows) ledger[r.status] = parseInt(r.n);

  // Niches by status.
  const nicheRes = await pool.query<{ status: string; n: string }>(
    `SELECT COALESCE(status,'active') AS status, COUNT(*) AS n FROM agent_niches GROUP BY status`,
  );
  const niches: Record<string, number> = {};
  for (const r of nicheRes.rows) niches[r.status] = parseInt(r.n);

  // Recent dispatches (last 20).
  const recentRes = await pool.query(
    `SELECT s.seed_video_id, s.seed_url, s.niche_id, s.status, s.origin_cluster_id,
            s.discovered_count, s.dispatched_at, s.completed_at,
            n.label AS niche_label, v.title AS seed_title
       FROM niche_discovery_seeds s
       LEFT JOIN agent_niches n ON n.niche_id = s.niche_id
       LEFT JOIN niche_spy_videos v ON v.id = s.seed_video_id
      ORDER BY s.dispatched_at DESC LIMIT 20`,
  );

  return NextResponse.json({
    ok: true,
    config: {
      auto_seed_enabled: config.auto_seed_enabled === 'true',
      auto_seed_min_novelty_pct: parseFloat(config.auto_seed_min_novelty_pct) || 80,
      auto_seed_max_threads: parseInt(config.auto_seed_max_threads) || 10,
      auto_seed_threads_per_seed: parseInt(config.auto_seed_threads_per_seed) || 1,
      auto_seed_max_seeds_per_tick: parseInt(config.auto_seed_max_seeds_per_tick) || 5,
      auto_seed_loop_number: parseInt(config.auto_seed_loop_number) || 14,
      auto_seed_interval_minutes: parseInt(config.auto_seed_interval_minutes) || 30,
      novelty_auto_recompute_enabled: config.novelty_auto_recompute_enabled === 'true',
      novelty_recompute_interval_minutes: parseInt(config.novelty_recompute_interval_minutes) || 15,
      seed_english_only: config.seed_english_only !== 'false',
    },
    stamps: {
      last_seed_schedule_at: config.last_seed_schedule_at ?? null,
      last_seed_reaper_at: config.last_seed_reaper_at ?? null,
      last_novelty_recompute_at: config.last_novelty_recompute_at ?? null,
      last_novelty_full_recompute_at: config.last_novelty_full_recompute_at ?? null,
    },
    ledger,
    niches,
    recent_dispatches: recentRes.rows.map(r => ({
      seed_video_id: r.seed_video_id,
      seed_url: r.seed_url,
      seed_title: r.seed_title,
      niche_id: r.niche_id,
      niche_label: r.niche_label,
      status: r.status,
      origin_cluster_id: r.origin_cluster_id,
      discovered_count: r.discovered_count,
      dispatched_at: r.dispatched_at,
      completed_at: r.completed_at,
    })),
  });
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const pool = await getPool();

  // Set config flags.
  if (body.config && typeof body.config === 'object') {
    for (const [k, v] of Object.entries(body.config)) {
      if (!FLAG_KEYS.includes(k)) continue;
      await pool.query(
        `INSERT INTO admin_config (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = $2`,
        [k, String(v)],
      );
    }
  }

  // Manual tick triggers (bypass the cron interval, respect locks+flags).
  let tickResult: unknown = undefined;
  if (body.action === 'run_scheduler') {
    tickResult = await runSeedSchedulerTick();
  } else if (body.action === 'run_reaper') {
    tickResult = await runSeedReaperTick();
  }

  return NextResponse.json({ ok: true, tickResult });
}
