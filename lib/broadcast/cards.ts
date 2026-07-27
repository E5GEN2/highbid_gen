/**
 * YouTube-style video cards for broadcast posts — composes each featured video
 * into an image that reads like a real YouTube result: thumbnail + duration
 * badge + title + "N views · X ago" metadata.
 *
 * Durations come from one videos.list?part=contentDetails call (≤50 ids, 1
 * quota unit) routed through a proxy like every other YT call. That single call
 * powers BOTH the duration badges and the shorts-vs-long-form classification
 * (our stored is_short is only ~4% filled, so it can't be relied on).
 */
import sharp from 'sharp';

export interface CardInput {
  ytId: string | null;
  thumbnail: string | null;
  title: string | null;
  viewCount: number | null;
  postedAt: Date | null;
}

const CARD_W = 500;          // thumbnail width; card is this wide
const THUMB_H = 281;         // 16:9
const META_H = 104;          // title + metadata strip

export function extractYtId(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|v=|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function human(n: number | null): string {
  if (n == null) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function agoStr(d: Date | null): string {
  if (!d) return '';
  const days = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 86_400_000));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  if (days < 30) { const w = Math.round(days / 7); return `${w} week${w > 1 ? 's' : ''} ago`; }
  if (days < 365) { const m = Math.round(days / 30); return `${m} month${m > 1 ? 's' : ''} ago`; }
  const y = (days / 365).toFixed(days >= 730 ? 0 : 1).replace(/\.0$/, '');
  return `${y} year${parseFloat(y) > 1 ? 's' : ''} ago`;
}

export function durStr(sec: number | null): string {
  if (sec == null || sec <= 0) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** ISO-8601 PT#H#M#S → seconds. */
export function parseIsoDuration(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return (parseInt(m[1] || '0') * 86400) + (parseInt(m[2] || '0') * 3600) + (parseInt(m[3] || '0') * 60) + parseInt(m[4] || '0');
}

/**
 * Proxied videos.list → Map<ytId, durationSeconds>.
 *
 * Resilient by design (the old single-attempt version silently returned an
 * empty map whenever the one key pair it asked for was busy — which stripped
 * BOTH the duration badges and the shorts/long-form label off a post): tries
 * up to 3 different key pairs, and logs loudly when resolution still fails so
 * an imageless/labelless post is always explained in the container logs.
 */
export async function fetchDurations(ytIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = ytIds.filter(Boolean).slice(0, 50);
  if (!ids.length) return out;
  const [{ getYtPairForThread }, { ytFetchViaProxy }] = await Promise.all([
    import('@/lib/yt-keys'), import('@/lib/yt-proxy-fetch'),
  ]);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const pair = await getYtPairForThread(attempt);
      if (!pair) { console.warn(`[cards] duration fetch attempt ${attempt + 1}: no key pair available`); continue; }
      const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids.join(',')}&key=${pair.key}`;
      const res = await ytFetchViaProxy(url, pair);
      const items = (res?.data as { items?: Array<{ id?: string; contentDetails?: { duration?: string } }> })?.items ?? [];
      for (const it of items) {
        const sec = parseIsoDuration(it.contentDetails?.duration);
        if (it.id && sec != null) out.set(it.id, sec);
      }
      if (out.size > 0) return out;
      console.warn(`[cards] duration fetch attempt ${attempt + 1}: 0 items for ${ids.length} ids`);
    } catch (err) {
      console.warn(`[cards] duration fetch attempt ${attempt + 1} failed:`, (err as Error).message);
    }
  }
  if (out.size === 0) console.warn(`[cards] duration resolution FAILED after 3 attempts (${ids.length} ids) — post will lack badges/format unless stored durations cover it`);
  return out;
}

/**
 * Format label from real durations (YouTube Shorts are ≤3min AND portrait, but
 * duration alone is the practical discriminator). Explicit about the evidence
 * so the reader knows what it means — the old label was silently absent
 * whenever is_short was unset.
 */
export function formatLabelFromDurations(durs: number[]): string {
  if (durs.length < 2) return '';
  const shorts = durs.filter(d => d > 0 && d <= 180).length;
  const frac = shorts / durs.length;
  if (frac >= 0.8) return `📱 <b>Shorts channel</b> — ${shorts}/${durs.length} recent uploads under 3 min`;
  if (frac <= 0.2) return `🎬 <b>Long-form channel</b> — ${durs.length - shorts}/${durs.length} recent uploads over 3 min`;
  return `🔀 <b>Mixed format</b> — ${shorts}/${durs.length} recent uploads are Shorts`;
}

async function fetchBuf(url: string, ms = 12_000): Promise<Buffer | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Ordered thumbnail-URL candidates for a video. The stored URL is almost always
 * `maxresdefault.jpg`, which is NOT generated for every video (Shorts, small/new
 * uploads) and 404s — hq720/hqdefault do exist whenever the video does. Try the
 * high-res ones first for crispness, then fall back to ones that always exist.
 */
function thumbUrls(v: CardInput): string[] {
  const urls: string[] = [];
  if (v.ytId) {
    urls.push(
      `https://i.ytimg.com/vi/${v.ytId}/hq720.jpg`,
      `https://i.ytimg.com/vi/${v.ytId}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${v.ytId}/hqdefault.jpg`,
      `https://i.ytimg.com/vi/${v.ytId}/mqdefault.jpg`,
      `https://i.ytimg.com/vi/${v.ytId}/sddefault.jpg`,
    );
  }
  if (v.thumbnail && !urls.includes(v.thumbnail)) urls.unshift(v.thumbnail);
  return [...new Set(urls)];
}

/**
 * Fetch a usable thumbnail, walking the resolution fallback chain with one retry
 * each. YouTube's "no thumbnail" response is a ~1KB placeholder, so anything
 * under ~2.5KB is treated as absent. i.ytimg.com rate-limits bursts (a parallel
 * fan-out of 4+ requests all 404), which is why the caller composes cards
 * sequentially — this function must never be run 4-wide in parallel.
 */
async function fetchThumb(v: CardInput): Promise<Buffer | null> {
  for (const url of thumbUrls(v)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const buf = await fetchBuf(url);
      if (buf && buf.length > 2500) return buf;
      if (attempt === 0) await sleep(120);   // transient 404 under throttle → retry once
    }
  }
  return null;
}

/** Wrap a title into ≤2 lines of ~42 chars, ellipsised. */
function wrapTitle(t: string): string[] {
  const words = t.split(/\s+/);
  const lines: string[] = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 42) { if (lines.length === 1) { cur = cur + '…'; break; } lines.push(cur.trim()); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur && lines.length < 2) lines.push(cur.trim());
  return lines.slice(0, 2);
}

/**
 * Compose one YouTube-style card: thumbnail (cover-cropped 16:9) + duration
 * badge + title + "N views · X ago" on a dark strip. Returns null if the
 * thumbnail can't be fetched.
 */
export async function composeVideoCard(v: CardInput, durationSec: number | null): Promise<Buffer | null> {
  if (!v.thumbnail && !v.ytId) return null;
  const raw = await fetchThumb(v);
  if (!raw) return null;
  try {
    const thumb = await sharp(raw).resize(CARD_W, THUMB_H, { fit: 'cover', position: 'centre' }).toBuffer();
    const title = wrapTitle(v.title ?? '');
    const metaBits = [v.viewCount != null ? `${human(v.viewCount)} views` : '', agoStr(v.postedAt)].filter(Boolean);
    const dur = durStr(durationSec);

    const svg = `<svg width="${CARD_W}" height="${THUMB_H + META_H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="${THUMB_H}" width="${CARD_W}" height="${META_H}" fill="#0f0f0f"/>
      ${dur ? `<rect x="${CARD_W - 14 - (dur.length * 11 + 14)}" y="${THUMB_H - 40}" rx="4"
            width="${dur.length * 11 + 14}" height="28" fill="#000000" fill-opacity="0.85"/>
        <text x="${CARD_W - 21}" y="${THUMB_H - 20}" text-anchor="end"
            font-family="Liberation Sans, DejaVu Sans, sans-serif" font-size="19" font-weight="700"
            fill="#ffffff">${xmlEsc(dur)}</text>` : ''}
      ${title.map((ln, i) => `<text x="16" y="${THUMB_H + 34 + i * 27}"
            font-family="Liberation Sans, DejaVu Sans, sans-serif" font-size="21" font-weight="600"
            fill="#f1f1f1">${xmlEsc(ln)}</text>`).join('')}
      <text x="16" y="${THUMB_H + 34 + title.length * 27 + 8}"
            font-family="Liberation Sans, DejaVu Sans, sans-serif" font-size="18"
            fill="#aaaaaa">${xmlEsc(metaBits.join('  ·  '))}</text>
    </svg>`;

    return await sharp({ create: { width: CARD_W, height: THUMB_H + META_H, channels: 3, background: '#0f0f0f' } })
      .composite([{ input: thumb, top: 0, left: 0 }, { input: Buffer.from(svg), top: 0, left: 0 }])
      .png().toBuffer();
  } catch (err) {
    console.warn('[cards] compose failed:', (err as Error).message);
    return null;
  }
}

/**
 * Crop the tall channel-grid screenshot to a WIDE hero banner. Telegram lays
 * album photos out by aspect ratio — a wide image takes its own full-width row,
 * which is what makes the grid the biggest element in the preview (the raw
 * 1700×2500 portrait capture got squeezed into a small corner tile).
 */
export async function heroCrop(shot: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(shot).metadata();
    const w = meta.width ?? 1700;
    const h = meta.height ?? 2500;
    const targetH = Math.min(h, Math.round(w * 9 / 16));   // 16:9 slice from the top (the grid itself)
    return await sharp(shot).extract({ left: 0, top: 0, width: w, height: targetH }).png().toBuffer();
  } catch {
    return shot;
  }
}
