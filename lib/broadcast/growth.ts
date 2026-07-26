/**
 * Growth-story spotlight — EVENT-triggered broadcast fired when the Growth
 * Watcher catches a tracked channel exploding (big subscriber jump over a short
 * window). Same rich treatment as the eligible spotlight (stats + thumbnails +
 * best-effort screenshot), growth-framed copy.
 *
 * Dedup is a per-channel COOLDOWN (not once-ever like the spotlight): a channel
 * can earn another growth story later if it makes a fresh jump, but not more
 * than once every broadcast_growth_cooldown_days. Bounded per tick.
 *
 * No high-water mark needed: the query only looks at the last 8 days of
 * snapshots, so it naturally surfaces channels growing *right now*.
 */
import type { Pool } from 'pg';
import { fmt } from './report';
import { esc, type SendResult } from './senders';
import { gatherChannel, sendRichChannelPost, type ChannelPostConfig, type ChannelRow, type VideoRow } from './spotlight';

interface GrowthConfig extends ChannelPostConfig { perTick: number; cooldownDays: number; minMult: number; minSubs0: number }

async function loadConfig(pool: Pool): Promise<GrowthConfig> {
  const r = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config WHERE key IN
       ('broadcast_telegram_token','broadcast_telegram_chat','broadcast_growth_per_tick',
        'broadcast_growth_cooldown_days','broadcast_growth_min_mult','broadcast_growth_min_subs0')`,
  );
  const c: Record<string, string> = {};
  for (const row of r.rows) c[row.key] = row.value;
  return {
    token: c.broadcast_telegram_token || '',
    chat: c.broadcast_telegram_chat || '',
    perTick: parseInt(c.broadcast_growth_per_tick) || 1,
    cooldownDays: parseInt(c.broadcast_growth_cooldown_days) || 5,
    minMult: parseFloat(c.broadcast_growth_min_mult) || 1.5,
    minSubs0: parseInt(c.broadcast_growth_min_subs0) || 200,
  };
}

export function buildGrowthCaption(ch: ChannelRow, vids: VideoRow[], subs0: number, subs1: number, days: number): string {
  const name = ch.channel_name ?? ch.channel_id;
  const url = `https://www.youtube.com/channel/${ch.channel_id}`;
  const x = (subs1 / Math.max(subs0, 1)).toFixed(1);
  const lines: string[] = [];
  lines.push(`🚀 <b>EXPLODING RIGHT NOW</b>`);
  lines.push('');
  lines.push(`<a href="${esc(url)}"><b>${esc(name)}</b></a>`);
  lines.push(`📈 ${fmt(subs0)} → <b>${fmt(subs1)}</b> subscribers in ${days} day${days > 1 ? 's' : ''}  ·  ×${x} bigger`);
  lines.push(`We caught it early and have been tracking its growth daily.`);
  if (vids.length) {
    lines.push('');
    lines.push(`<b>Popular uploads:</b>`);
    for (const v of vids.slice(0, 3)) {
      const t = (v.title ?? '').slice(0, 70);
      const vv = v.view_count != null ? ` — ${fmt(v.view_count)} views` : '';
      lines.push(`• ${esc(t)}${vv}`);
    }
  }
  return lines.join('\n').slice(0, 1024);
}

export async function sendGrowthFor(
  pool: Pool, cfg: ChannelPostConfig, channelId: string,
  gd: { subs0: number; subs1: number; days: number }, dedupKey: string | null,
): Promise<SendResult> {
  const g = await gatherChannel(pool, channelId);
  if (!g) return { target: 'telegram', ok: false, error: 'channel not found' };
  const caption = buildGrowthCaption(g.ch, g.vids, gd.subs0, gd.subs1, gd.days);
  return sendRichChannelPost(pool, cfg, channelId, caption, g.vids, dedupKey, 'growth_story');
}

export interface GrowthTickResult { ran: boolean; reason?: string; sent: number }

/** Event tick — surfaces channels with a big recent subscriber jump (cooldown-deduped). */
export async function runGrowthStoryTick(): Promise<GrowthTickResult> {
  const { getPool } = await import('@/lib/db');
  const pool = await getPool();
  const cfg = await loadConfig(pool);
  if (!cfg.token || !cfg.chat) return { ran: false, reason: 'no_telegram', sent: 0 };

  const todo = await pool.query<{ channel_id: string; days: number; subs0: string; subs1: string }>(
    `WITH win AS (
       SELECT channel_id, MIN(day) d0, MAX(day) d1
         FROM channel_growth_snapshots
        WHERE day > CURRENT_DATE - 8 AND subscriber_count IS NOT NULL
        GROUP BY channel_id
       HAVING COUNT(DISTINCT day) >= 2 AND MAX(day) > MIN(day)
     ), pairs AS (
       SELECT w.channel_id, (w.d1 - w.d0) AS days,
         (SELECT s.subscriber_count FROM channel_growth_snapshots s
           WHERE s.channel_id = w.channel_id AND s.day = w.d0 ORDER BY s.captured_at ASC LIMIT 1) AS subs0,
         (SELECT s.subscriber_count FROM channel_growth_snapshots s
           WHERE s.channel_id = w.channel_id AND s.day = w.d1 ORDER BY s.captured_at DESC LIMIT 1) AS subs1
         FROM win w
     )
     SELECT p.channel_id, p.days, p.subs0::text AS subs0, p.subs1::text AS subs1
       FROM pairs p
      WHERE p.subs0 >= $1 AND p.subs1 > p.subs0 * $2
        AND NOT EXISTS (
          SELECT 1 FROM broadcast_posts b
           WHERE b.featured_key = 'growth:'||p.channel_id
             AND b.posted_at > NOW() - ($3 || ' days')::interval)
      ORDER BY p.subs1::float / GREATEST(p.subs0::float, 1) DESC
      LIMIT $4`,
    [cfg.minSubs0, cfg.minMult, String(cfg.cooldownDays), cfg.perTick],
  );

  let sent = 0;
  for (const r of todo.rows) {
    const res = await sendGrowthFor(pool, cfg, r.channel_id,
      { subs0: parseInt(r.subs0), subs1: parseInt(r.subs1), days: r.days }, `growth:${r.channel_id}`);
    if (res.ok) sent++;
  }
  return { ran: true, sent };
}
