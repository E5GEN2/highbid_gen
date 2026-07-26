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
  const body = await req.json().catch(() => ({})) as {
    dryRun?: boolean; force?: boolean; spotlight?: string; spotlightDry?: string;
    growth?: string; subs0?: number; subs1?: number; days?: number;
  };

  // Spotlight test: compose (+optionally send) a rich eligible-channel post for
  // a specific channel_id, WITHOUT the dedup high-water mark. spotlightDry
  // returns the caption without sending; spotlight actually sends it.
  if (body.spotlight || body.spotlightDry) {
    const pool = await getPool();
    const cid = (body.spotlight || body.spotlightDry)!;
    const cfgRes = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM admin_config WHERE key IN ('broadcast_telegram_token','broadcast_telegram_chat')`);
    const c: Record<string, string> = {};
    for (const r of cfgRes.rows) c[r.key] = r.value;
    if (body.spotlightDry) {
      const { buildSpotlightCaption } = await import('@/lib/broadcast/spotlight');
      const ch = await pool.query(`SELECT channel_id, channel_name, subscriber_count, channel_created_at, video_count FROM niche_spy_channels WHERE channel_id=$1`, [cid]);
      if (!ch.rows[0]) return NextResponse.json({ error: 'channel not found' }, { status: 404 });
      const vids = await pool.query(`SELECT title, thumbnail, view_count FROM niche_spy_videos WHERE channel_id=$1 AND thumbnail IS NOT NULL ORDER BY view_count DESC NULLS LAST LIMIT 4`, [cid]);
      return NextResponse.json({ dryRun: true, caption: buildSpotlightCaption(ch.rows[0], vids.rows), thumbs: vids.rows.map(v => v.thumbnail) });
    }
    const { sendSpotlightFor } = await import('@/lib/broadcast/spotlight');
    const res = await sendSpotlightFor(pool, { token: c.broadcast_telegram_token || '', chat: c.broadcast_telegram_chat || '', since: null, perTick: 1 }, cid, null);
    return NextResponse.json({ spotlight: cid, ...res });
  }

  // Growth-story test: send a growth post for a channel using its real snapshot
  // window if present, else a caller-supplied {subs0, subs1, days}.
  if (body.growth) {
    const pool = await getPool();
    const cfgRes = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM admin_config WHERE key IN ('broadcast_telegram_token','broadcast_telegram_chat')`);
    const c: Record<string, string> = {};
    for (const r of cfgRes.rows) c[r.key] = r.value;
    const { sendGrowthFor } = await import('@/lib/broadcast/growth');
    let gd = { subs0: body.subs0 ?? 0, subs1: body.subs1 ?? 0, days: body.days ?? 0 };
    if (!gd.subs1) {
      const w = await pool.query<{ d0: string; d1: string; s0: string; s1: string }>(
        `SELECT MIN(day)::text d0, MAX(day)::text d1,
           (SELECT subscriber_count FROM channel_growth_snapshots x WHERE x.channel_id=$1 ORDER BY day ASC, captured_at ASC LIMIT 1)::text s0,
           (SELECT subscriber_count FROM channel_growth_snapshots x WHERE x.channel_id=$1 ORDER BY day DESC, captured_at DESC LIMIT 1)::text s1
         FROM channel_growth_snapshots WHERE channel_id=$1 AND day > CURRENT_DATE - 30`, [body.growth]);
      const row = w.rows[0];
      if (row?.s0 && row?.s1) gd = { subs0: parseInt(row.s0), subs1: parseInt(row.s1),
        days: Math.max(1, Math.round((Date.parse(row.d1) - Date.parse(row.d0)) / 86400000)) };
    }
    const res = await sendGrowthFor(pool, { token: c.broadcast_telegram_token || '', chat: c.broadcast_telegram_chat || '' }, body.growth, gd, null);
    return NextResponse.json({ growth: body.growth, gd, ...res });
  }

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
