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
  const body = await req.json().catch(() => ({})) as { dryRun?: boolean; force?: boolean; spotlight?: string; spotlightDry?: string };

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
