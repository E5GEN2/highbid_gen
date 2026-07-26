/**
 * Growth-story spotlight — EVENT-triggered broadcast fired when the Growth
 * Watcher catches a tracked channel exploding. Data-rich: subscriber velocity,
 * total-views growth, videos added, recent average views, age — all from
 * channel_growth_snapshots — plus thumbnails + best-effort screenshot (shared
 * rich-post machinery).
 *
 * Dedup is a per-channel COOLDOWN (not once-ever): a channel can earn another
 * growth story later if it makes a fresh jump. Bounded per tick. No high-water
 * mark — the query only looks at the last 8 days, so it surfaces what's growing
 * right now.
 */
import type { Pool } from 'pg';
import { fmt } from './report';
import { esc, type SendResult } from './senders';
import { gatherChannel, sendRichChannelPost, type ChannelPostConfig, type ChannelRow, type VideoRow } from './spotlight';

interface GrowthConfig extends ChannelPostConfig { perTick: number; cooldownDays: number; minMult: number; minSubs0: number }

export interface GrowthData {
  subs0: number; subs1: number; days: number;
  views0: number; views1: number;
  videos0: number; videos1: number;
  recentAvg: number;
}

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

function ageStr(created: Date | null): string {
  if (!created) return '';
  const days = Math.max(1, Math.round((Date.now() - new Date(created).getTime()) / 86_400_000));
  if (days < 45) return `${days} days old`;
  const months = Math.round(days / 30);
  if (months < 18) return `~${months} months old`;
  return `~${(months / 12).toFixed(1)} years old`;
}

/** Pull the full growth window (subs/views/videos/recent-avg at both ends) for a channel. */
export async function gatherGrowthData(pool: Pool, channelId: string): Promise<GrowthData | null> {
  const bounds = await pool.query<{ d0: string | null; d1: string | null }>(
    `SELECT MIN(day)::text d0, MAX(day)::text d1 FROM channel_growth_snapshots
      WHERE channel_id = $1 AND day > CURRENT_DATE - 8 AND subscriber_count IS NOT NULL`, [channelId]);
  const d0 = bounds.rows[0]?.d0, d1 = bounds.rows[0]?.d1;
  if (!d0 || !d1 || d0 === d1) return null;
  const pick = async (day: string, order: 'ASC' | 'DESC') => (await pool.query<{ subs: string; views: string; videos: string; recent: string }>(
    `SELECT subscriber_count subs, total_views views, video_count videos, recent_avg_views recent
       FROM channel_growth_snapshots WHERE channel_id = $1 AND day = $2 ORDER BY captured_at ${order} LIMIT 1`, [channelId, day])).rows[0];
  const a = await pick(d0, 'ASC'); const b = await pick(d1, 'DESC');
  if (!a || !b) return null;
  return {
    subs0: parseInt(a.subs) || 0, subs1: parseInt(b.subs) || 0,
    days: Math.max(1, Math.round((Date.parse(d1) - Date.parse(d0)) / 86_400_000)),
    views0: parseInt(a.views) || 0, views1: parseInt(b.views) || 0,
    videos0: parseInt(a.videos) || 0, videos1: parseInt(b.videos) || 0,
    recentAvg: parseInt(b.recent) || 0,
  };
}

export function buildGrowthCaption(ch: ChannelRow, vids: VideoRow[], gd: GrowthData, format = ''): string {
  const name = ch.channel_name ?? ch.channel_id;
  const url = `https://www.youtube.com/channel/${ch.channel_id}`;
  const x = (gd.subs1 / Math.max(gd.subs0, 1)).toFixed(1);
  const perDay = Math.round((gd.subs1 - gd.subs0) / Math.max(gd.days, 1));
  const lines: string[] = [];
  lines.push(`🚀 <b>EXPLODING RIGHT NOW</b>`);
  lines.push('');
  lines.push(`<a href="${esc(url)}"><b>${esc(name)}</b></a>`);
  if (format) lines.push(format);
  lines.push(`📈 <b>${fmt(gd.subs0)} → ${fmt(gd.subs1)}</b> subscribers in ${gd.days} day${gd.days > 1 ? 's' : ''}  ·  ×${x}  (+${fmt(perDay)}/day)`);
  if (gd.views1 >= gd.views0 && gd.views1 > 0) {
    const dv = gd.views1 - gd.views0;
    lines.push(`👁 ${fmt(gd.views1)} total views${dv > 0 ? `  (+${fmt(dv)} in ${gd.days}d)` : ''}`);
  }
  if (gd.videos1 > 0) {
    const nv = gd.videos1 - gd.videos0;
    lines.push(`🎬 ${fmt(gd.videos1)} videos${nv > 0 ? `  (+${nv} new)` : ''}`);
  }
  if (gd.recentAvg > 0) lines.push(`⚡ recent uploads averaging ${fmt(gd.recentAvg)} views each`);
  const age = ageStr(ch.channel_created_at);
  if (age) lines.push(`📅 ${age}`);
  lines.push('');
  lines.push(`We caught it early and have been tracking its growth daily.`);
  if (vids.length) {
    lines.push('');
    lines.push(`<b>Popular uploads:</b>`);
    for (const v of vids.slice(0, 2)) {
      const t = (v.title ?? '').slice(0, 60);
      const vv = v.view_count != null ? ` — ${fmt(v.view_count)} views` : '';
      lines.push(`• ${esc(t)}${vv}`);
    }
  }
  return lines.join('\n').slice(0, 1024);
}

export async function sendGrowthFor(
  pool: Pool, cfg: ChannelPostConfig, channelId: string, gd: GrowthData, dedupKey: string | null,
): Promise<SendResult> {
  const g = await gatherChannel(pool, channelId);
  if (!g) return { target: 'telegram', ok: false, error: 'channel not found' };
  const caption = buildGrowthCaption(g.ch, g.vids, gd, g.format);
  return sendRichChannelPost(pool, cfg, channelId, caption, g.vids, dedupKey, 'growth_story', g.durations);
}

export interface GrowthTickResult { ran: boolean; reason?: string; sent: number }

export async function runGrowthStoryTick(): Promise<GrowthTickResult> {
  const { getPool } = await import('@/lib/db');
  const pool = await getPool();
  const cfg = await loadConfig(pool);
  if (!cfg.token || !cfg.chat) return { ran: false, reason: 'no_telegram', sent: 0 };

  // Candidate channels: big recent jump, past cooldown.
  const cand = await pool.query<{ channel_id: string }>(
    `WITH win AS (
       SELECT channel_id, MIN(day) d0, MAX(day) d1 FROM channel_growth_snapshots
        WHERE day > CURRENT_DATE - 8 AND subscriber_count IS NOT NULL
        GROUP BY channel_id HAVING COUNT(DISTINCT day) >= 2 AND MAX(day) > MIN(day)
     ), pairs AS (
       SELECT w.channel_id,
         (SELECT s.subscriber_count FROM channel_growth_snapshots s WHERE s.channel_id=w.channel_id AND s.day=w.d0 ORDER BY s.captured_at ASC LIMIT 1) subs0,
         (SELECT s.subscriber_count FROM channel_growth_snapshots s WHERE s.channel_id=w.channel_id AND s.day=w.d1 ORDER BY s.captured_at DESC LIMIT 1) subs1
       FROM win w
     )
     SELECT channel_id FROM pairs
      WHERE subs0 >= $1 AND subs1 > subs0 * $2
        AND NOT EXISTS (SELECT 1 FROM broadcast_posts b
                         WHERE b.featured_key = 'growth:'||channel_id
                           AND b.posted_at > NOW() - ($3 || ' days')::interval)
      ORDER BY subs1::float / GREATEST(subs0::float, 1) DESC
      LIMIT $4`,
    [cfg.minSubs0, cfg.minMult, String(cfg.cooldownDays), cfg.perTick],
  );

  let sent = 0;
  for (const row of cand.rows) {
    const gd = await gatherGrowthData(pool, row.channel_id);
    if (!gd || gd.subs1 <= gd.subs0 * cfg.minMult) continue;
    const res = await sendGrowthFor(pool, cfg, row.channel_id, gd, `growth:${row.channel_id}`);
    if (res.ok) sent++;
  }
  return { ran: true, sent };
}
