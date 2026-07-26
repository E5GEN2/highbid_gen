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
  // Debug feed: recent posts WITH their diagnostics blob, plus rolled-up
  // health per kind (failures + degraded posts in the last 24h) so a problem
  // is visible without digging through container logs.
  const recent = await pool.query(
    `SELECT id, posted_at, kind, channel_id, featured_key, ok, targets, error, meta
       FROM broadcast_posts ORDER BY id DESC LIMIT 20`,
  );
  const health = await pool.query(
    `SELECT kind,
            COUNT(*)                                             AS posts_24h,
            COUNT(*) FILTER (WHERE NOT ok)                       AS failed,
            COUNT(*) FILTER (WHERE (meta->>'degraded')::bool)    AS degraded,
            COUNT(*) FILTER (WHERE meta->>'via' = 'text')        AS text_fallback,
            ROUND(AVG((meta->>'total_ms')::numeric))             AS avg_ms
       FROM broadcast_posts
      WHERE posted_at > NOW() - INTERVAL '24 hours'
      GROUP BY kind ORDER BY kind`,
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
    health24h: health.rows,
    recentPosts: recent.rows,
  });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    dryRun?: boolean; force?: boolean; spotlight?: string; spotlightDry?: string; growth?: string;
    deletePost?: number;
  };

  // Delete a delivered post from Telegram by its broadcast_posts id — reads the
  // stored message_ids and calls deleteMessage for each. The only way to unsend.
  if (body.deletePost) {
    const pool = await getPool();
    const row = await pool.query<{ meta: { message_ids?: number[] } | null; channel_id: string | null }>(
      `SELECT meta, channel_id FROM broadcast_posts WHERE id = $1`, [body.deletePost]);
    if (!row.rows[0]) return NextResponse.json({ error: 'post not found' }, { status: 404 });
    const ids = row.rows[0].meta?.message_ids ?? [];
    if (!ids.length) return NextResponse.json({ error: 'no message_ids stored for this post (sent before capture was added)' }, { status: 409 });
    const cfgRes = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM admin_config WHERE key IN ('broadcast_telegram_token','broadcast_telegram_chat')`);
    const c: Record<string, string> = {};
    for (const r of cfgRes.rows) c[r.key] = r.value;
    const { deleteTelegramMessages } = await import('@/lib/broadcast/senders');
    const del = await deleteTelegramMessages(c.broadcast_telegram_token || '', c.broadcast_telegram_chat || '', ids);
    await pool.query(`UPDATE broadcast_posts SET meta = meta || '{"deleted":true}'::jsonb WHERE id = $1`, [body.deletePost]).catch(() => {});
    return NextResponse.json({ deletePost: body.deletePost, messageIds: ids, ...del });
  }

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
      const { gatherChannel, buildSpotlightCaption } = await import('@/lib/broadcast/spotlight');
      const g = await gatherChannel(pool, cid);
      if (!g) return NextResponse.json({ error: 'channel not found' }, { status: 404 });
      return NextResponse.json({ dryRun: true, caption: buildSpotlightCaption(g.ch, g.vids, g.format, g.firstPostedAt), thumbs: g.vids.map(v => v.thumbnail) });
    }
    const { sendSpotlightFor } = await import('@/lib/broadcast/spotlight');
    const res = await sendSpotlightFor(pool, { token: c.broadcast_telegram_token || '', chat: c.broadcast_telegram_chat || '', since: null, perTick: 1 }, cid, null);
    return NextResponse.json({ spotlight: cid, ...res });
  }

  // Growth-story test: send a growth post for a channel using its real snapshot
  // window (last 8 days). 404 if the channel has no 2-point growth window.
  if (body.growth) {
    const pool = await getPool();
    const cfgRes = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM admin_config WHERE key IN ('broadcast_telegram_token','broadcast_telegram_chat')`);
    const c: Record<string, string> = {};
    for (const r of cfgRes.rows) c[r.key] = r.value;
    const { sendGrowthFor, gatherGrowthData } = await import('@/lib/broadcast/growth');
    const gd = await gatherGrowthData(pool, body.growth);
    if (!gd) return NextResponse.json({ error: 'no growth-snapshot window for this channel' }, { status: 404 });
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
