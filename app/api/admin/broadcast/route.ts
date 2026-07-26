import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { buildBroadcastReport } from '@/lib/broadcast/report';
import { renderTelegramHTML, renderDiscordMarkdown } from '@/lib/broadcast/senders';
import { runBroadcastTick } from '@/lib/broadcast';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/admin/broadcast          — status: flags, last post, recent posts
 * POST /api/admin/broadcast          — body {dryRun?:true, force?:true}
 *   dryRun: compose the next post and return the rendered text WITHOUT sending
 *   force:  send now regardless of interval (still requires enabled+targets
 *           unless dryRun)
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const cfg = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config WHERE key IN
       ('broadcast_enabled','broadcast_interval_minutes','last_broadcast_at','broadcast_rotation_idx',
        'broadcast_telegram_chat','broadcast_discord_webhook','broadcast_telegram_token')`,
  );
  const c: Record<string, string> = {};
  for (const r of cfg.rows) c[r.key] = r.value;
  const recent = await pool.query(
    `SELECT id, posted_at, kind, featured_key, ok, targets, error FROM broadcast_posts ORDER BY id DESC LIMIT 10`,
  );
  return NextResponse.json({
    enabled: c.broadcast_enabled === 'true',
    intervalMinutes: parseInt(c.broadcast_interval_minutes) || 120,
    lastBroadcastAt: c.last_broadcast_at ?? null,
    rotationIdx: parseInt(c.broadcast_rotation_idx) || 0,
    targets: {
      telegram: !!(c.broadcast_telegram_token && c.broadcast_telegram_chat),
      discord: !!c.broadcast_discord_webhook,
    },
    recentPosts: recent.rows,
  });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { dryRun?: boolean; force?: boolean };
  if (body.dryRun) {
    const pool = await getPool();
    const cfg = await pool.query<{ value: string }>(`SELECT value FROM admin_config WHERE key='broadcast_rotation_idx'`);
    const idx = parseInt(cfg.rows[0]?.value) || 0;
    const report = await buildBroadcastReport(pool, idx);
    return NextResponse.json({
      dryRun: true,
      kind: report.kind,
      featuredKey: report.featuredKey,
      telegram: renderTelegramHTML(report),
      discord: renderDiscordMarkdown(report),
    });
  }
  const r = await runBroadcastTick(body.force === true);
  return NextResponse.json(r);
}
