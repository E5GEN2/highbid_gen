/**
 * Most-popular-callout card composer.
 *
 * Per the visual grammar's `most_popular_callout_card` primitive: a single
 * YT-style video card centered on a white canvas, composed from data
 * (thumbnail URL + title + view count + relative age + optional duration).
 * NOT a screenshot crop — explicitly a composed layout per
 * visual-packaging-class-b.json:83-95 and confirmed by frame inspection
 * of the source MG video.
 *
 * Inputs:
 *   video_id (used to fetch the thumbnail from YT's CDN)
 *   title
 *   views (number; rendered as "12M views")
 *   age_phrase (e.g. "7 months ago")
 *   duration_badge? (e.g. "34:32" — bottom-right corner overlay)
 *   channel_watermark? (e.g. "NoFL" — bottom-left text inside the thumbnail)
 *
 * Output: 1920×1080 PNG with a centered card. Background = white.
 *
 * Caches by SHA256 of inputs.
 */

import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { CLIPS_DIR } from '../../clips-dir';

const CARD_DIR = path.join(CLIPS_DIR, 'producer_renders', 'cards');

export interface MostPopularCalloutArgs {
  video_id: string;
  title: string;
  views: number;
  age_phrase?: string;
  duration_badge?: string;
  channel_watermark?: string;
  bg?: 'white' | 'dark_gray';
}

function humanizeViews(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K views`;
  return `${n} views`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Bump when the card LAYOUT changes so old cached PNGs are invalidated (the
// cache key is args-only, so a layout change with identical args would
// otherwise serve a stale render). v2: dark card on white page (2026-06-20).
const COMPOSER_VERSION = 2;
function hashArgs(args: MostPopularCalloutArgs, w: number, h: number): string {
  return crypto.createHash('sha256').update(JSON.stringify({ ...args, w, h, v: COMPOSER_VERSION })).digest('hex').slice(0, 32);
}

/** Soft word wrap title into 2 lines. */
function wrapTitle(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const tentative = cur ? `${cur} ${w}` : w;
    if (tentative.length <= maxCharsPerLine) cur = tentative;
    else { if (cur) lines.push(cur); cur = w; if (lines.length >= 2) break; }
  }
  if (cur && lines.length < 2) lines.push(cur);
  // Truncate-with-ellipsis if 3+ lines would have been needed
  if (lines.length === 2 && words.length > lines.join(' ').split(/\s+/).length) {
    lines[1] = lines[1].replace(/\s*\S+\s*$/, '') + '…';
  }
  return lines.slice(0, 2);
}

async function fetchThumbnail(video_id: string): Promise<Buffer> {
  // Try maxresdefault first, fall back to hqdefault (always available).
  const urls = [
    `https://i.ytimg.com/vi/${video_id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${video_id}/hqdefault.jpg`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      return Buffer.from(await res.arrayBuffer());
    } catch { /* try next */ }
  }
  throw new Error(`failed to fetch thumbnail for ${video_id}`);
}

/** SVG overlay for the dark callout card: the title + meta + 3-dot menu sit
 *  INSIDE the card below the thumbnail (white text on the dark card); the
 *  duration badge + channel watermark sit ON the thumbnail. Drawn as the top
 *  layer, AFTER the card rect and the thumbnail. The OG MG renders this beat
 *  as a near-black rounded card floating on a WHITE page (frame-measured
 *  2026-06-20: page #FFF, card #0E0E0E). */
function buildOverlaySvg(g: {
  width: number; height: number;
  cardX: number; cardY: number; cardW: number; pad: number;
  thumbW: number; thumbH: number;
  lines: string[]; viewsAgeLine: string;
  titleFontSize: number; titleLH: number; metaFontSize: number; titleGap: number;
  durationBadge?: string; channelWatermark?: string;
}): string {
  const { width, height, cardX, cardY, cardW, pad, thumbW, thumbH, lines,
          viewsAgeLine, titleFontSize, titleLH, metaFontSize, titleGap, durationBadge, channelWatermark } = g;
  const fg = '#F1F1F1', mutedFg = '#AAAAAA';
  const FONT = `'Roboto','Segoe UI',system-ui,-apple-system,sans-serif`;
  const thumbX = cardX + pad, thumbY = cardY + pad;
  const textX = thumbX;  // title/meta align with the thumbnail's left edge

  // Title — white, below the thumbnail, inside the card.
  const titleTop = thumbY + thumbH + titleGap;
  const titleTspans = lines.map((ln, i) =>
    `<text x="${textX}" y="${titleTop + titleFontSize + i * titleLH}"
           font-family="${FONT}" font-size="${titleFontSize}" font-weight="600"
           fill="${fg}">${esc(ln)}</text>`
  ).join('');

  // Metadata (views • age) — muted gray, below the title.
  const metaY = titleTop + titleFontSize + lines.length * titleLH + 8;
  const metaText = `<text x="${textX}" y="${metaY + metaFontSize}"
      font-family="${FONT}" font-size="${metaFontSize}" font-weight="400"
      fill="${mutedFg}">${esc(viewsAgeLine)}</text>`;

  // 3-dot kebab menu — in the reserved right gutter, aligned with line 1. The
  // title column is wrapped narrower (renderMostPopularCallout reserves
  // kebabGutter) so the title can never collide with these dots.
  const dr = Math.max(5, Math.round(cardW * 0.0085));
  const dgap = Math.round(dr * 2.8);
  const dotsX = thumbX + thumbW - dr;
  const dotsY = titleTop + Math.round(titleFontSize * 0.30);
  const dots = `
    <circle cx="${dotsX}" cy="${dotsY}"            r="${dr}" fill="${mutedFg}"/>
    <circle cx="${dotsX}" cy="${dotsY + dgap}"     r="${dr}" fill="${mutedFg}"/>
    <circle cx="${dotsX}" cy="${dotsY + dgap * 2}" r="${dr}" fill="${mutedFg}"/>`;

  // Duration badge — bottom-right corner of the thumbnail (scales with card).
  const bw = Math.round(cardW * 0.112), bh = Math.round(cardW * 0.044), bm = Math.round(cardW * 0.017);
  const badgeFont = Math.round(cardW * 0.030);
  const durBadge = durationBadge ? `
    <rect x="${thumbX + thumbW - bw - bm}" y="${thumbY + thumbH - bh - bm}" width="${bw}" height="${bh}" rx="5" fill="#000000" fill-opacity="0.82"/>
    <text x="${thumbX + thumbW - bm - bw / 2}" y="${thumbY + thumbH - bm - bh / 2 + badgeFont * 0.35}"
          font-family="${FONT}" font-size="${badgeFont}" font-weight="500"
          fill="#FFFFFF" text-anchor="middle">${esc(durationBadge)}</text>` : '';

  // Channel watermark — bottom-CENTER of the thumbnail, large, drop-shadowed
  // (matches OG: "VES STICK" centered low on the thumbnail).
  const wmFont = Math.round(cardW * 0.047);
  const wmX = thumbX + thumbW / 2, wmY = thumbY + thumbH - Math.round(cardW * 0.042);
  const watermark = channelWatermark ? `
    <text x="${wmX + 2}" y="${wmY + 3}" text-anchor="middle" font-family="${FONT}"
          font-size="${wmFont}" font-weight="700" fill="#000000" fill-opacity="0.5">${esc(channelWatermark)}</text>
    <text x="${wmX}" y="${wmY}" text-anchor="middle" font-family="${FONT}"
          font-size="${wmFont}" font-weight="700" fill="#FFFFFF">${esc(channelWatermark)}</text>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${durBadge}
  ${watermark}
  ${titleTspans}
  ${metaText}
  ${dots}
</svg>`;
}

export async function renderMostPopularCallout(
  args: MostPopularCalloutArgs,
  width = 1920,
  height = 1080,
): Promise<{ file_url: string; local_path: string; width: number; height: number }> {
  await fs.mkdir(CARD_DIR, { recursive: true });
  const hash = hashArgs(args, width, height);
  const outPath = path.join(CARD_DIR, `${hash}.png`);
  try {
    const st = await fs.stat(outPath);
    if (st.size > 0) {
      return { file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('cards/' + hash + '.png')}`, local_path: outPath, width, height };
    }
  } catch { /* cache miss */ }

  // The OG MG renders this beat as a near-black rounded CARD floating on a
  // WHITE page (the `bg` arg is the PAGE bg — default white; the card is
  // always dark with white text). frame-measured 2026-06-20.
  const pageBg = args.bg === 'dark_gray' ? '#3C3C3C' : '#FFFFFF';
  const CARD_HEX = '#0F0F0F';

  // Card geometry: a centered dark card. Thumbnail inset at the top with even
  // padding; title (2 lines) + meta stacked below it inside the card. Sizing
  // is OG-measured (2026-06-20): card ≈ 0.345 of frame width, aspect ≈ 1.16,
  // thumbnail ≈ 0.61 of card height. Fonts scale with cardW so the card stays
  // self-consistent.
  const cardW = Math.round(width * 0.36);          // ~691px (OG 0.345, +slack for legibility)
  const pad = Math.round(cardW * 0.032);           // thumbnail inset / card padding
  const thumbW = cardW - 2 * pad;
  const thumbH = Math.round(thumbW * 9 / 16);
  const titleFontSize = Math.round(cardW * 0.052);
  const titleLH = Math.round(titleFontSize * 1.18);
  const metaFontSize = Math.round(cardW * 0.036);
  const titleGap = Math.round(cardW * 0.035);
  // Reserve a right-hand gutter for the 3-dot kebab so the title wraps before
  // it and never collides (the OG keeps the title in a narrower column).
  const kebabGutter = Math.round(titleFontSize * 1.5);
  const lines = wrapTitle(args.title, Math.max(16, Math.floor((thumbW - kebabGutter) / (titleFontSize * 0.50))));
  const cardH = pad + thumbH + titleGap + titleFontSize + lines.length * titleLH
              + 8 + metaFontSize + Math.round(cardW * 0.040) /*bottom pad*/;
  const cardX = Math.round((width - cardW) / 2);
  const cardY = Math.round((height - cardH) / 2);

  // 1. White page canvas.
  const canvas = sharp({ create: { width, height, channels: 4, background: pageBg } });

  // 2. Dark rounded card.
  const cardSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="26" ry="26" fill="${CARD_HEX}"/></svg>`,
  );

  // 3. Thumbnail — inset at the top of the card, rounded corners.
  const thumbBuf = await fetchThumbnail(args.video_id);
  const radius = 14;
  const mask = Buffer.from(
    `<svg width="${thumbW}" height="${thumbH}"><rect width="${thumbW}" height="${thumbH}" rx="${radius}" ry="${radius}" fill="white"/></svg>`,
  );
  const thumbRendered = await sharp(thumbBuf)
    .resize(thumbW, thumbH, { fit: 'cover', position: 'centre' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // 4. Text + badge overlay (white title/meta inside the card).
  const overlaySvg = buildOverlaySvg({
    width, height, cardX, cardY, cardW, pad, thumbW, thumbH, lines,
    viewsAgeLine: args.age_phrase ? `${humanizeViews(args.views)} • ${args.age_phrase}` : humanizeViews(args.views),
    titleFontSize, titleLH, metaFontSize, titleGap,
    durationBadge: args.duration_badge,
    channelWatermark: args.channel_watermark,
  });

  // 5. Composite: white page → dark card → thumbnail → text overlay.
  await canvas
    .composite([
      { input: cardSvg, left: 0, top: 0 },
      { input: thumbRendered, left: cardX + pad, top: cardY + pad },
      { input: Buffer.from(overlaySvg), left: 0, top: 0 },
    ])
    .png()
    .toFile(outPath);

  return { file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('cards/' + hash + '.png')}`, local_path: outPath, width, height };
}
