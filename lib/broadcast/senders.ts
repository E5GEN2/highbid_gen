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

export interface SendResult {
  target: 'telegram' | 'discord';
  ok: boolean;
  error?: string;
  /** Which delivery path actually ran — album / photo / plain text fallback.
   *  Recorded on the post row so a degraded post is diagnosable after the fact. */
  via?: 'album' | 'photo' | 'text';
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain sendMessage (HTML) — the universal text fallback for any post. */
export async function sendTelegramText(botToken: string, chatId: string, html: string): Promise<SendResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html.slice(0, 4096), parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text().catch(() => '');
    return res.ok ? { target: 'telegram', ok: true, via: 'text' } : { target: 'telegram', ok: false, via: 'text', error: `HTTP ${res.status}: ${body.slice(0, 160)}` };
  } catch (err) {
    return { target: 'telegram', ok: false, error: (err as Error).message?.slice(0, 160) };
  }
}

/**
 * Rich spotlight sender with graceful degradation:
 *   screenshot(bytes) + thumbnail URLs → sendMediaGroup (caption on first)
 *   1 image                            → sendPhoto
 *   0 images OR any media send fails   → sendTelegramText (always posts something)
 * Caption is HTML, capped to Telegram's 1024-char media-caption limit by caller.
 */
export async function sendTelegramSpotlight(
  botToken: string, chatId: string, captionHTML: string,
  images: Buffer[],
): Promise<SendResult> {
  const api = (m: string) => `https://api.telegram.org/bot${botToken}/${m}`;
  const imgs = images.filter(Boolean).slice(0, 10);
  // Caption rides the FIRST image, so pass images hero-first — Telegram lays an
  // album out by aspect ratio and gives a wide leading image its own full-width
  // row (that's what makes the channel grid the biggest element).
  const media = imgs.map((_, i) => {
    const m: Record<string, unknown> = { type: 'photo', media: `attach://img${i}` };
    if (i === 0) { m.caption = captionHTML; m.parse_mode = 'HTML'; }
    return m;
  });

  try {
    if (imgs.length >= 2) {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('media', JSON.stringify(media));
      imgs.forEach((b, i) => form.append(`img${i}`, new Blob([new Uint8Array(b)], { type: 'image/png' }), `img${i}.png`));
      const res = await fetch(api('sendMediaGroup'), { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return { target: 'telegram', ok: true, via: 'album' };
      console.warn('[broadcast] sendMediaGroup failed:', (await res.text().catch(() => '')).slice(0, 200));
    } else if (imgs.length === 1) {
      const form = new FormData();
      form.append('chat_id', chatId); form.append('caption', captionHTML); form.append('parse_mode', 'HTML');
      form.append('photo', new Blob([new Uint8Array(imgs[0])], { type: 'image/png' }), 'img.png');
      const res = await fetch(api('sendPhoto'), { method: 'POST', body: form, signal: AbortSignal.timeout(40_000) });
      if (res.ok) return { target: 'telegram', ok: true, via: 'photo' };
      console.warn('[broadcast] sendPhoto failed:', (await res.text().catch(() => '')).slice(0, 200));
    }
  } catch (err) {
    console.warn('[broadcast] media send threw:', (err as Error).message);
  }
  // Universal fallback — never drop a post.
  return sendTelegramText(botToken, chatId, captionHTML);
}

export function renderTelegramHTML(r: BroadcastReport): string {
  const s = r.stats;
  const lines: string[] = [];
  lines.push(`⛏️ <b>ROFE.AI — MINING PULSE</b>`);
  lines.push('');
  lines.push(`<b>📡 Last 2 hours</b>`);
  lines.push(`   🆕 <code>+${esc(s.chans2h)}</code> YouTube channels discovered`);
  lines.push(`   🎬 <code>+${esc(s.vids2h)}</code> new videos analyzed`);
  lines.push(`   🧭 <code>${esc(s.edges2h)}</code> recommendations explored`);
  lines.push('');
  lines.push(`<b>📅 Last 24 hours</b>`);
  lines.push(`   ✨ <code>+${esc(s.chans24h)}</code> new channels found`);
  lines.push('');
  lines.push(`<b>🗄 Our database so far</b>`);
  lines.push(`   🎬 <code>${esc(s.vidsTotal)}</code> videos  ·  📺 <code>${esc(s.chansTotal)}</code> channels`);
  lines.push(`   📊 <code>${esc(s.edgesTotal)}</code> data points collected`);
  lines.push('');
  lines.push(`<b>🌱 Growth watch</b>`);
  lines.push(`   👁 <code>${esc(s.tracked)}</code> young channels checked daily`);
  lines.push(`   📈 <code>${esc(s.snapshots)}</code> growth measurements taken`);
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
  lines.push(`> 🆕 \`+${s.chans2h}\` YouTube channels discovered`);
  lines.push(`> 🎬 \`+${s.vids2h}\` new videos analyzed`);
  lines.push(`> 🧭 \`${s.edges2h}\` recommendations explored`);
  lines.push('');
  lines.push(`**📅 Last 24h** — ✨ \`+${s.chans24h}\` new channels found`);
  lines.push('');
  lines.push(`**🗄 Database** — 🎬 \`${s.vidsTotal}\` videos · 📺 \`${s.chansTotal}\` channels · 📊 \`${s.edgesTotal}\` data points`);
  lines.push(`**🌱 Growth watch** — 👁 \`${s.tracked}\` young channels checked daily · 📈 \`${s.snapshots}\` measurements`);
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
