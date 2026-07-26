/**
 * Eligible-channel spotlight — EVENT-triggered broadcast (distinct from the
 * time-triggered mining pulse). Fires when a channel newly passes the
 * content-gen bar, with a rich per-channel post: stats + top video titles +
 * top thumbnails + a live channel-page screenshot (best-effort).
 *
 * Freshness: a high-water mark (broadcast_spotlight_since, stamped on first
 * run) means we only post channels DISCOVERED after the feature turned on —
 * never the historical backlog of already-eligible channels. Each channel is
 * posted at most once (broadcast_posts.featured_key = 'chan:<id>'). Bounded
 * per tick so a post-backfill surge drains steadily instead of flooding.
 */
import type { Pool } from 'pg';
import { fmt } from './report';
import { esc, sendTelegramSpotlight, type SendResult } from './senders';

interface SpotlightConfig { token: string; chat: string; since: string | null; perTick: number }

async function loadConfig(pool: Pool): Promise<SpotlightConfig> {
  const r = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config WHERE key IN
       ('broadcast_telegram_token','broadcast_telegram_chat','broadcast_spotlight_since','broadcast_spotlight_per_tick')`,
  );
  const c: Record<string, string> = {};
  for (const row of r.rows) c[row.key] = row.value;
  return {
    token: c.broadcast_telegram_token || '',
    chat: c.broadcast_telegram_chat || '',
    since: c.broadcast_spotlight_since || null,
    perTick: parseInt(c.broadcast_spotlight_per_tick) || 1,
  };
}

function ageStr(created: Date | null): string {
  if (!created) return 'age unknown';
  const days = Math.max(1, Math.round((Date.now() - new Date(created).getTime()) / 86_400_000));
  if (days < 45) return `${days} days old`;
  const months = Math.round(days / 30);
  if (months < 18) return `~${months} months old`;
  return `~${(months / 12).toFixed(1)} years old`;
}

interface ChannelRow { channel_id: string; channel_name: string | null; subscriber_count: number | null; channel_created_at: Date | null; video_count: number | null }
interface VideoRow { title: string | null; thumbnail: string | null; view_count: number | null }

export function buildSpotlightCaption(ch: ChannelRow, vids: VideoRow[]): string {
  const name = ch.channel_name ?? ch.channel_id;
  const url = `https://www.youtube.com/channel/${ch.channel_id}`;
  const lines: string[] = [];
  lines.push(`🎯 <b>NEW CHANNEL ON OUR RADAR</b>`);
  lines.push('');
  lines.push(`<a href="${esc(url)}"><b>${esc(name)}</b></a>`);
  const bits: string[] = [];
  if (ch.subscriber_count != null) bits.push(`👥 ${fmt(ch.subscriber_count)} subscribers`);
  bits.push(`📅 ${ageStr(ch.channel_created_at)}`);
  if (ch.video_count != null) bits.push(`🎬 ${fmt(ch.video_count)} videos`);
  lines.push(bits.join('  ·  '));
  if (vids.length) {
    lines.push('');
    lines.push(`<b>Popular uploads:</b>`);
    for (const v of vids.slice(0, 4)) {
      const t = (v.title ?? '').slice(0, 70);
      const vv = v.view_count != null ? ` — ${fmt(v.view_count)} views` : '';
      lines.push(`• ${esc(t)}${vv}`);
    }
  }
  // Telegram media-caption hard limit is 1024 chars.
  return lines.join('\n').slice(0, 1024);
}

/** Best-effort channel-page screenshot → PNG bytes, or null on any failure. */
async function captureChannelShot(channelId: string): Promise<Buffer | null> {
  try {
    const [{ captureYtScreen }, fs] = await Promise.all([
      import('@/lib/content-gen/yt-capture'),
      import('fs/promises'),
    ]);
    const res = await Promise.race([
      captureYtScreen(channelId, { kind: 'videos_tab_popular', mode: 'static' }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('capture timeout')), 40_000)),
    ]);
    const p = (res as { local_path?: string })?.local_path;
    if (!p) return null;
    const buf = await fs.readFile(p);
    return buf.length > 1000 ? buf : null;
  } catch (err) {
    console.warn(`[spotlight] screenshot skipped for ${channelId}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Compose + send one spotlight for a specific channel. `dedupKey` is stamped
 * on the broadcast_posts row (pass 'chan:<id>' for real posts so the channel
 * never repeats; pass null for test sends so they don't suppress the real one).
 */
export async function sendSpotlightFor(
  pool: Pool, cfg: SpotlightConfig, channelId: string, dedupKey: string | null,
): Promise<SendResult> {
  const chRes = await pool.query<ChannelRow>(
    `SELECT channel_id, channel_name, subscriber_count, channel_created_at, video_count
       FROM niche_spy_channels WHERE channel_id = $1`, [channelId],
  );
  const ch = chRes.rows[0];
  if (!ch) return { target: 'telegram', ok: false, error: 'channel not found' };

  const vidsRes = await pool.query<VideoRow>(
    `SELECT title, thumbnail, view_count FROM niche_spy_videos
      WHERE channel_id = $1 AND thumbnail IS NOT NULL
      ORDER BY view_count DESC NULLS LAST LIMIT 4`, [channelId],
  );
  const vids = vidsRes.rows;
  const caption = buildSpotlightCaption(ch, vids);
  const thumbs = vids.map(v => v.thumbnail!).filter(Boolean);
  const shot = await captureChannelShot(channelId);

  const res = await sendTelegramSpotlight(cfg.token, cfg.chat, caption, shot, thumbs);

  await pool.query(
    `INSERT INTO broadcast_posts (kind, featured_key, ok, targets, payload, error)
     VALUES ('eligible_spotlight', $1, $2, 'telegram', $3, $4)`,
    [dedupKey, res.ok, caption.slice(0, 4000), res.ok ? null : res.error ?? null],
  ).catch(err => console.error('[spotlight] post log failed:', (err as Error).message));

  console.log(`[spotlight] chan=${channelId} shot=${shot ? 'yes' : 'no'} thumbs=${thumbs.length} -> ${res.ok ? 'ok' : 'FAIL:' + res.error}`);
  return res;
}

export interface SpotlightTickResult { ran: boolean; reason?: string; sent: number }

/** Event tick — posts newly-eligible, un-broadcast channels (oldest first). */
export async function runEligibleSpotlightTick(): Promise<SpotlightTickResult> {
  const pool = await getPoolLocal();
  const cfg = await loadConfig(pool);
  if (!cfg.token || !cfg.chat) return { ran: false, reason: 'no_telegram', sent: 0 };

  // First run: stamp the high-water mark and post nothing (skip the backlog).
  if (!cfg.since) {
    await pool.query(
      `INSERT INTO admin_config (key, value) VALUES ('broadcast_spotlight_since', NOW()::text)
         ON CONFLICT (key) DO UPDATE SET value = NOW()::text`,
    ).catch(() => {});
    return { ran: true, reason: 'high_water_mark_set', sent: 0 };
  }

  const todo = await pool.query<{ channel_id: string }>(
    `SELECT s.channel_id
       FROM channel_cg_status s
      WHERE s.cg_eligible = true
        AND s.discovered_at > $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM broadcast_posts b WHERE b.featured_key = 'chan:'||s.channel_id)
      ORDER BY s.cg_evaluated_at ASC
      LIMIT $2`,
    [cfg.since, cfg.perTick],
  );
  if (todo.rows.length === 0) return { ran: true, sent: 0 };

  let sent = 0;
  for (const row of todo.rows) {
    const res = await sendSpotlightFor(pool, cfg, row.channel_id, `chan:${row.channel_id}`);
    if (res.ok) sent++;
  }
  return { ran: true, sent };
}

// Lazy pool import to keep this module's import graph small.
async function getPoolLocal(): Promise<Pool> {
  const { getPool } = await import('@/lib/db');
  return getPool();
}
