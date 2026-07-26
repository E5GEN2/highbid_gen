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
  const s = r.stats;
  const lines: string[] = [];
  lines.push(`⛏️ <b>ROFE.AI — MINING PULSE</b>`);
  lines.push('');
  lines.push(`<b>📡 Last 2 hours</b>`);
  lines.push(`   🆕 <code>+${esc(s.chans2h)}</code> channels discovered`);
  lines.push(`   🎬 <code>+${esc(s.vids2h)}</code> videos ingested`);
  lines.push(`   🕸 <code>${esc(s.edges2h)}</code> suggestion edges mapped`);
  lines.push('');
  lines.push(`<b>📅 Last 24 hours</b>`);
  lines.push(`   ✨ <code>+${esc(s.chans24h)}</code> new channels found`);
  lines.push('');
  lines.push(`<b>🗄 Total corpus</b>`);
  lines.push(`   🎬 <code>${esc(s.vidsTotal)}</code> videos  ·  📺 <code>${esc(s.chansTotal)}</code> channels`);
  lines.push(`   🔗 <code>${esc(s.edgesTotal)}</code> crawl events`);
  lines.push('');
  lines.push(`<b>🌱 Growth watch</b>`);
  lines.push(`   👁 <code>${esc(s.tracked)}</code> young channels tracked daily`);
  lines.push(`   📸 <code>${esc(s.snapshots)}</code> growth snapshots`);
  if (r.insight) {
    lines.push('');
    lines.push(`${r.insight.emoji} <b>${esc(r.insight.label.toUpperCase())}</b>`);
    lines.push(`<blockquote>${esc(r.insight.text)}</blockquote>`);
  }
  return lines.join('\n');
}

export function renderDiscordMarkdown(r: BroadcastReport): string {
  const s = r.stats;
  const lines: string[] = [];
  lines.push(`⛏️ **ROFE.AI — MINING PULSE**`);
  lines.push('');
  lines.push(`**📡 Last 2 hours**`);
  lines.push(`> 🆕 \`+${s.chans2h}\` channels discovered`);
  lines.push(`> 🎬 \`+${s.vids2h}\` videos ingested`);
  lines.push(`> 🕸 \`${s.edges2h}\` suggestion edges mapped`);
  lines.push('');
  lines.push(`**📅 Last 24h** — ✨ \`+${s.chans24h}\` new channels found`);
  lines.push('');
  lines.push(`**🗄 Corpus** — 🎬 \`${s.vidsTotal}\` videos · 📺 \`${s.chansTotal}\` channels · 🔗 \`${s.edgesTotal}\` crawl events`);
  lines.push(`**🌱 Growth watch** — 👁 \`${s.tracked}\` young channels daily · 📸 \`${s.snapshots}\` snapshots`);
  if (r.insight) {
    lines.push('');
    lines.push(`${r.insight.emoji} **${r.insight.label.toUpperCase()}**`);
    lines.push(`> ${r.insight.text}`);
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
