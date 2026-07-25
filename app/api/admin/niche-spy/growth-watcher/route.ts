import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { runGrowthWatcherTick } from '@/lib/growth-watcher';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET  /api/admin/niche-spy/growth-watcher  → status (tracked by stage, snapshots, top growers)
 * POST /api/admin/niche-spy/growth-watcher  → { action: 'tick' } runs one tick now (controlled test)
 *
 * See docs/growth-watcher/spec.md.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();

  const [cfg, byStage, tracked, snaps, growers] = await Promise.all([
    pool.query<{ key: string; value: string }>(`SELECT key, value FROM admin_config WHERE key IN ('growth_watcher_enabled','growth_watcher_alert')`),
    pool.query<{ stage: string; n: string; showed_life: string }>(
      `SELECT stage, COUNT(*)::text n, COUNT(*) FILTER (WHERE showed_life)::text showed_life
         FROM growth_tracked_channels GROUP BY stage ORDER BY COUNT(*) DESC`),
    pool.query<{ total: string; due: string }>(
      `SELECT COUNT(*)::text total,
              COUNT(*) FILTER (WHERE stage<>'dormant' AND (next_due_at IS NULL OR next_due_at<=NOW()))::text due
         FROM growth_tracked_channels`),
    pool.query<{ total: string; today: string; channels: string; last_at: string | null }>(
      `SELECT COUNT(*)::text total,
              COUNT(*) FILTER (WHERE day=CURRENT_DATE)::text today,
              COUNT(DISTINCT channel_id)::text channels,
              MAX(captured_at)::text last_at
         FROM channel_growth_snapshots`),
    pool.query<{ channel_id: string; first_caught_subs: string; last_subs: string; growth_score: string; first_caught_at: string }>(
      `SELECT channel_id, first_caught_subs::text, last_subs::text, growth_score::text, first_caught_at::text
         FROM growth_tracked_channels
        WHERE growth_score > 0
        ORDER BY growth_score DESC LIMIT 15`),
  ]);

  const cfgMap: Record<string, string> = {};
  for (const r of cfg.rows) cfgMap[r.key] = r.value;
  let alert: unknown = null;
  try { alert = cfgMap.growth_watcher_alert ? JSON.parse(cfgMap.growth_watcher_alert) : null; } catch { alert = null; }

  return NextResponse.json({
    enabled: (cfgMap.growth_watcher_enabled ?? 'true') !== 'false',
    alert,   // durable server-side health verdict {level,msg,at} — updated ~15min by runGrowthWatcherAlertTick
    tracked: { total: parseInt(tracked.rows[0]?.total ?? '0'), due: parseInt(tracked.rows[0]?.due ?? '0'), byStage: byStage.rows },
    snapshots: {
      total: parseInt(snaps.rows[0]?.total ?? '0'),
      today: parseInt(snaps.rows[0]?.today ?? '0'),
      distinctChannels: parseInt(snaps.rows[0]?.channels ?? '0'),
      lastCapturedAt: snaps.rows[0]?.last_at ?? null,
    },
    topGrowers: growers.rows.map(g => ({
      channelId: g.channel_id,
      caughtSubs: parseInt(g.first_caught_subs),
      currentSubs: parseInt(g.last_subs),
      subsGained: parseInt(g.growth_score),
      caughtAt: g.first_caught_at,
    })),
  });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { action?: string };
  if (body.action && body.action !== 'tick') {
    return NextResponse.json({ error: `unknown action '${body.action}'` }, { status: 400 });
  }
  // Runs one tick regardless of the enabled flag — the endpoint IS the controlled
  // test path before flipping the flag on. Bounded (ENROLL_BATCH + SCAN_BATCH).
  const r = await runGrowthWatcherTick({ force: true });
  return NextResponse.json({ ok: true, tick: r });
}
