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
  /** Telegram message_id(s) of the delivered message(s) — an album returns one
   *  per media item. Stored on the post row so a bad post can be deleted later
   *  via deleteMessage (there's no other way to unsend once it's out). */
  messageIds?: number[];
}

/** Pull message_id(s) from a Telegram send response body (result may be an
 *  object for photo/text or an array for a media group). */
function extractMessageIds(body: unknown): number[] {
  const r = (body as { result?: unknown })?.result;
  if (Array.isArray(r)) return r.map(m => (m as { message_id?: number })?.message_id).filter((n): n is number => typeof n === 'number');
  const one = (r as { message_id?: number })?.message_id;
  return typeof one === 'number' ? [one] : [];
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
    return res.ok
      ? { target: 'telegram', ok: true, via: 'text', messageIds: extractMessageIds(safeJson(body)) }
      : { target: 'telegram', ok: false, via: 'text', error: `HTTP ${res.status}: ${body.slice(0, 160)}` };
  } catch (err) {
    return { target: 'telegram', ok: false, error: (err as Error).message?.slice(0, 160) };
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/** Delete previously-sent Telegram messages (best-effort; used to remove a bad
 *  broadcast post). Telegram allows a bot to delete its own messages. */
export async function deleteTelegramMessages(botToken: string, chatId: string, messageIds: number[]): Promise<{ deleted: number; failed: number }> {
  let deleted = 0, failed = 0;
  for (const id of messageIds) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: id }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) deleted++; else failed++;
    } catch { failed++; }
  }
  return { deleted, failed };
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
      const txt = await res.text().catch(() => '');
      if (res.ok) return { target: 'telegram', ok: true, via: 'album', messageIds: extractMessageIds(safeJson(txt)) };
      console.warn('[broadcast] sendMediaGroup failed:', txt.slice(0, 200));
    } else if (imgs.length === 1) {
      const form = new FormData();
      form.append('chat_id', chatId); form.append('caption', captionHTML); form.append('parse_mode', 'HTML');
      form.append('photo', new Blob([new Uint8Array(imgs[0])], { type: 'image/png' }), 'img.png');
      const res = await fetch(api('sendPhoto'), { method: 'POST', body: form, signal: AbortSignal.timeout(40_000) });
      const txt = await res.text().catch(() => '');
      if (res.ok) return { target: 'telegram', ok: true, via: 'photo', messageIds: extractMessageIds(safeJson(txt)) };
      console.warn('[broadcast] sendPhoto failed:', txt.slice(0, 200));
    }
  } catch (err) {
    console.warn('[broadcast] media send threw:', (err as Error).message);
  }
  // Universal fallback — never drop a post.
  return sendTelegramText(botToken, chatId, captionHTML);
}

const comma = (n: number): string => (n ?? 0).toLocaleString('en-US');
const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 100) : 0);

export function renderTelegramHTML(r: BroadcastReport): string {
  const s = r.stats;
  const L: string[] = [];
  L.push(`⛏️ <b>ROFE.AI — MINING PULSE</b>`);
  L.push('');

  // New channels found, broken down by subscriber size (the tiny-channel KPI).
  L.push(`<b>🔭 New channels found</b>`);
  L.push(`   last 2h: <b>+${comma(s.chans2h)}</b>   ·   last 24h: <b>+${comma(s.chans24h)}</b>`);
  L.push(`   <i>by channel size (2h · 24h):</i>`);
  for (const b of s.discBySize) {
    L.push(`   ${b.emoji} ${b.label} — <code>+${comma(b.d2h)}</code> · <code>+${comma(b.d24h)}</code>`);
  }
  L.push('');
  L.push(`   🎬 <code>+${comma(s.vids2h)}</code> new videos analyzed (2h)`);
  L.push(`   🧭 <code>+${comma(s.edges2h)}</code> recommendations explored (2h)`);
  L.push('');

  // Growth-watch cohort in depth (size mix + how many already growing + history).
  L.push(`<b>🌱 Young channels we're tracking</b>`);
  L.push(`   👁 <b>${comma(s.tracked)}</b> channels watched every day`);
  L.push(`   📈 <b>${comma(s.trackedGrowing)}</b> (${pct(s.trackedGrowing, s.tracked)}%) already growing since we found them`);
  if (s.listenerChannels > 0) {
    // Listener health, reported daily so it never needs to be asked for.
    const ok = s.listenerOverdue === 0 ? '✅' : `⚠️ ${s.listenerOverdue} overdue`;
    L.push(`   🎧 <b>${comma(s.listenerVideos24h)}</b> new uploads heard across <b>${comma(s.listenerChannels)}</b> listened channels ${ok}`);
  }
  L.push('');
  // Genesis cohort in depth — growing / stalled / dropped, growth rate, videos.
  for (const g of s.tinyGroups) {
    L.push(`   ${g.emoji} <b>${g.label}</b> — <code>${comma(g.n)}</code> tracked`);
    L.push(`      📈 <code>${comma(g.growing)}</code> growing (${pct(g.growing, g.n)}%, avg +${g.avgGain} subs · ~${g.perDay}/day)  ·  😴 <code>${comma(g.flat)}</code> flat  ·  📉 <code>${comma(g.dropped)}</code> dropped`);
    L.push(`      🎬 by videos: <code>${comma(g.vids1_5)}</code> have 1–5 · <code>${comma(g.vids6_20)}</code> have 6–20 · <code>${comma(g.vids21)}</code> have 20+`);
  }
  L.push(`   <i>larger:</i> 🌱 100–1K <code>${comma(s.trk100_1k)}</code> · 🌿 1K–10K <code>${comma(s.trk1k_10k)}</code> · 📈 10K+ <code>${comma(s.trk10k)}</code>`);
  L.push(`   📅 <b>${s.historyDays}</b> days of daily history so far · avg <b>${s.historyAvgDepth}</b> per channel · <code>${comma(s.historyDeep)}</code> with 5+ days`);
  L.push('');

  L.push(`<b>🗄 Our database so far</b>`);
  L.push(`   🎬 <code>${esc(s.vidsTotal)}</code> videos  ·  📺 <code>${esc(s.chansTotal)}</code> channels`);
  L.push(`   📊 <code>${esc(s.edgesTotal)}</code> connections mapped  ·  📈 <code>${esc(s.measurementsTotal)}</code> growth measurements`);

  if (r.insight) {
    L.push('');
    L.push(`${r.insight.emoji} <b>${esc(r.insight.label.toUpperCase())}</b>`);
    L.push(`<blockquote>${esc(r.insight.text)}</blockquote>`);
  }
  return L.join('\n');
}

export function renderDiscordMarkdown(r: BroadcastReport): string {
  const s = r.stats;
  const L: string[] = [];
  L.push(`⛏️ **ROFE.AI — MINING PULSE**`);
  L.push('');
  L.push(`**🔭 New channels found** — last 2h: \`+${comma(s.chans2h)}\` · last 24h: \`+${comma(s.chans24h)}\``);
  for (const b of s.discBySize) {
    L.push(`> ${b.emoji} ${b.label} — \`+${comma(b.d2h)}\` (2h) · \`+${comma(b.d24h)}\` (24h)`);
  }
  L.push(`🎬 \`+${comma(s.vids2h)}\` new videos analyzed · 🧭 \`+${comma(s.edges2h)}\` recommendations explored (2h)`);
  L.push('');
  L.push(`**🌱 Young channels we're tracking** — 👁 \`${comma(s.tracked)}\` watched daily · 📈 \`${comma(s.trackedGrowing)}\` (${pct(s.trackedGrowing, s.tracked)}%) already growing`);
  for (const g of s.tinyGroups) {
    L.push(`> ${g.emoji} ${g.label}: \`${comma(g.n)}\` — 📈 \`${comma(g.growing)}\` (${pct(g.growing, g.n)}%, +${g.avgGain} avg · ~${g.perDay}/day) · 😴 \`${comma(g.flat)}\` flat · 📉 \`${comma(g.dropped)}\` dropped · 🎬 ${comma(g.vids1_5)}/${comma(g.vids6_20)}/${comma(g.vids21)} (1-5/6-20/20+)`);
  }
  L.push(`> larger: 🌱 100–1K \`${comma(s.trk100_1k)}\` · 🌿 1K–10K \`${comma(s.trk1k_10k)}\` · 📈 10K+ \`${comma(s.trk10k)}\``);
  L.push(`> 📅 \`${s.historyDays}\` days of history · avg \`${s.historyAvgDepth}\`/channel · \`${comma(s.historyDeep)}\` with 5+ days`);
  L.push('');
  L.push(`**🗄 Database** — 🎬 \`${s.vidsTotal}\` videos · 📺 \`${s.chansTotal}\` channels · 📊 \`${s.edgesTotal}\` connections · 📈 \`${s.measurementsTotal}\` measurements`);
  if (r.insight) {
    L.push('');
    L.push(`${r.insight.emoji} **${r.insight.label.toUpperCase()}**`);
    L.push(`> ${r.insight.text}`);
  }
  return L.join('\n').slice(0, 1990);
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
