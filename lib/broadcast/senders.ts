/**
 * Broadcast senders — render a BroadcastReport per platform and deliver it.
 * Telegram: Bot API sendMessage (HTML). Discord: incoming webhook (markdown).
 * Both are plain fetch with tight timeouts; a failed target never throws out
 * of the tick — the caller gets per-target results for logging.
 *
 * These calls go DIRECT (no xgodo proxy): the proxies-mandatory rule covers
 * Gemini + YouTube surfaces; Telegram/Discord are our own outbound channels.
 */
import type { BroadcastReport } from './report';

export interface SendResult { target: 'telegram' | 'discord'; ok: boolean; error?: string }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderTelegramHTML(r: BroadcastReport): string {
  const lines: string[] = [];
  lines.push(`⛏️ <b>${esc(r.title)}</b>`);
  lines.push('');
  for (const l of r.statLines) lines.push(esc(l));
  if (r.insight) {
    lines.push('');
    lines.push(`${r.insight.emoji} <b>${esc(r.insight.label)}:</b> ${esc(r.insight.text)}`);
  }
  return lines.join('\n');
}

export function renderDiscordMarkdown(r: BroadcastReport): string {
  const lines: string[] = [];
  lines.push(`⛏️ **${r.title}**`);
  lines.push('');
  for (const l of r.statLines) lines.push(l);
  if (r.insight) {
    lines.push('');
    lines.push(`${r.insight.emoji} **${r.insight.label}:** ${r.insight.text}`);
  }
  // Discord hard limit 2000 chars.
  return lines.join('\n').slice(0, 1990);
}

export async function sendTelegram(botToken: string, chatId: string, r: BroadcastReport): Promise<SendResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: renderTelegramHTML(r),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) return { target: 'telegram', ok: false, error: `HTTP ${res.status}: ${body.slice(0, 160)}` };
    return { target: 'telegram', ok: true };
  } catch (err) {
    return { target: 'telegram', ok: false, error: (err as Error).message?.slice(0, 160) };
  }
}

export async function sendDiscord(webhookUrl: string, r: BroadcastReport): Promise<SendResult> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: renderDiscordMarkdown(r) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.text().catch(() => '');
      return { target: 'discord', ok: false, error: `HTTP ${res.status}: ${body.slice(0, 160)}` };
    }
    return { target: 'discord', ok: true };
  } catch (err) {
    return { target: 'discord', ok: false, error: (err as Error).message?.slice(0, 160) };
  }
}
