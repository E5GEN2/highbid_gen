/**
 * Broadcast tick — posts the periodic mining pulse to every configured
 * channel (Telegram / Discord). Runs from the 60s runAll loop; self-gated:
 *
 *   broadcast_enabled            'true' to run (ships OFF)
 *   broadcast_interval_minutes   default 120 (every other hour)
 *   broadcast_telegram_token / broadcast_telegram_chat
 *   broadcast_discord_webhook
 *
 * No configured targets → no-op even when enabled. Every attempt is logged
 * to broadcast_posts (payload + per-target outcome), and featured channels
 * carry featured_key so insights don't repeat within 14 days.
 */
import { getPool } from '@/lib/db';
import { buildBroadcastReport } from './report';
import { sendTelegram, sendDiscord, renderTelegramHTML, type SendResult } from './senders';

export interface BroadcastTickResult {
  ran: boolean;
  reason?: string;
  kind?: string;
  results?: SendResult[];
}

export async function runBroadcastTick(force = false): Promise<BroadcastTickResult> {
  const pool = await getPool();
  const cfgRes = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config WHERE key IN
       ('broadcast_enabled','broadcast_interval_minutes','last_broadcast_at',
        'broadcast_telegram_token','broadcast_telegram_chat','broadcast_discord_webhook',
        'broadcast_rotation_idx')`,
  );
  const c: Record<string, string> = {};
  for (const r of cfgRes.rows) c[r.key] = r.value;

  if (!force && c.broadcast_enabled !== 'true') return { ran: false, reason: 'disabled' };

  const intervalMin = parseInt(c.broadcast_interval_minutes) || 120;
  if (!force && c.last_broadcast_at) {
    const elapsed = Date.now() - new Date(c.last_broadcast_at).getTime();
    if (elapsed < intervalMin * 60 * 1000) return { ran: false, reason: 'not_due' };
  }

  const targets: Array<'telegram' | 'discord'> = [];
  if (c.broadcast_telegram_token && c.broadcast_telegram_chat) targets.push('telegram');
  if (c.broadcast_discord_webhook) targets.push('discord');
  if (targets.length === 0) return { ran: false, reason: 'no_targets_configured' };

  // Stamp BEFORE sending so a slow/failed send can't double-post on the next tick.
  await pool.query(
    `INSERT INTO admin_config (key, value) VALUES ('last_broadcast_at', NOW()::text)
       ON CONFLICT (key) DO UPDATE SET value = NOW()::text`,
  ).catch(() => {});

  const rotationIdx = parseInt(c.broadcast_rotation_idx) || 0;
  const report = await buildBroadcastReport(pool, rotationIdx);
  await pool.query(
    `INSERT INTO admin_config (key, value) VALUES ('broadcast_rotation_idx', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
    [String((rotationIdx + 1) % 3)],
  ).catch(() => {});

  const results: SendResult[] = [];
  if (targets.includes('telegram')) results.push(await sendTelegram(c.broadcast_telegram_token, c.broadcast_telegram_chat, report));
  if (targets.includes('discord'))  results.push(await sendDiscord(c.broadcast_discord_webhook, report));

  const anyOk = results.some(r => r.ok);
  await pool.query(
    `INSERT INTO broadcast_posts (kind, featured_key, ok, targets, payload, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      report.kind,
      // Only burn the featured-dedup key if at least one target actually got the post.
      anyOk ? report.featuredKey : null,
      anyOk,
      results.map(r => `${r.target}:${r.ok ? 'ok' : 'fail'}`).join(','),
      renderTelegramHTML(report).slice(0, 4000),
      results.filter(r => !r.ok).map(r => `${r.target}: ${r.error}`).join(' | ').slice(0, 500) || null,
    ],
  ).catch(err => console.error('[broadcast] post log failed:', (err as Error).message));

  console.log(`[broadcast] kind=${report.kind} targets=${results.map(r => `${r.target}:${r.ok ? 'ok' : 'FAIL'}`).join(',')}`);
  return { ran: true, kind: report.kind, results };
}
