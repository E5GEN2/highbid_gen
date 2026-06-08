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

const BG_HEX = { white: '#FFFFFF', dark_gray: '#2A2A2A' } as const;

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

function hashArgs(args: MostPopularCalloutArgs, w: number, h: number): string {
  return crypto.createHash('sha256').update(JSON.stringify({ ...args, w, h })).digest('hex').slice(0, 32);
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

/** Build the SVG overlay that sits on top of the white canvas (title +
 *  metadata + 3-dot menu + optional duration badge + watermark). */
function buildOverlaySvg(args: {
  width: number; height: number;
  cardX: number; cardY: number; cardW: number; thumbH: number;
  title: string; viewsAgeLine: string; durationBadge?: string;
  channelWatermark?: string; fg: string; mutedFg: string;
}): string {
  const { width, height, cardX, cardY, cardW, thumbH, title, viewsAgeLine, durationBadge, channelWatermark, fg, mutedFg } = args;

  // Title area starts just below the thumbnail.
  const titleY = cardY + thumbH + 60;
  const titleFontSize = 56;
  const titleLineHeight = titleFontSize * 1.18;
  // Wrap title to fit cardW. Heuristic: ~0.5em average char width at this weight.
  const maxCharsPerLine = Math.floor((cardW - 100) / (titleFontSize * 0.48));
  const lines = wrapTitle(title, Math.max(20, maxCharsPerLine));
  const titleTspans = lines.map((ln, i) =>
    `<text x="${cardX}" y="${titleY + i * titleLineHeight}"
           font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
           font-size="${titleFontSize}" font-weight="700" fill="${fg}">${esc(ln)}</text>`
  ).join('');

  // Metadata line (views • age) sits below the title.
  const metaY = titleY + lines.length * titleLineHeight + 36;
  const metaFontSize = 34;
  const metaText = `<text x="${cardX}" y="${metaY}"
                          font-family="system-ui, -apple-system, sans-serif"
                          font-size="${metaFontSize}" font-weight="400" fill="${mutedFg}">${esc(viewsAgeLine)}</text>`;

  // 3-dot vertical menu — far right of the card.
  const dotsX = cardX + cardW - 28;
  const dotsY = titleY - titleFontSize + 12;
  const dotsR = 6;
  const dots = `
    <circle cx="${dotsX}" cy="${dotsY}"      r="${dotsR}" fill="${mutedFg}"/>
    <circle cx="${dotsX}" cy="${dotsY + 22}" r="${dotsR}" fill="${mutedFg}"/>
    <circle cx="${dotsX}" cy="${dotsY + 44}" r="${dotsR}" fill="${mutedFg}"/>
  `;

  // Duration badge — sits inside the thumbnail, bottom-right.
  const durBadge = durationBadge ? `
    <rect x="${cardX + cardW - 130}" y="${cardY + thumbH - 50}" width="100" height="36" rx="4" fill="#000000" fill-opacity="0.78"/>
    <text x="${cardX + cardW - 80}" y="${cardY + thumbH - 24}"
          font-family="system-ui, sans-serif" font-size="22" font-weight="600"
          fill="#FFFFFF" text-anchor="middle">${esc(durationBadge)}</text>
  ` : '';

  // Channel watermark — bottom-left inside the thumbnail.
  const watermark = channelWatermark ? `
    <text x="${cardX + 18}" y="${cardY + thumbH - 22}"
          font-family="system-ui, sans-serif" font-size="20" font-weight="700"
          fill="#FFFFFF" stroke="#000000" stroke-width="3" paint-order="stroke fill"
          stroke-linejoin="round">${esc(channelWatermark)}</text>
  ` : '';

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

  const bg = args.bg ?? 'white';
  const bgHex = BG_HEX[bg];
  const fg = bg === 'dark_gray' ? '#FFFFFF' : '#0F0F0F';
  const mutedFg = bg === 'dark_gray' ? '#AAAAAA' : '#606060';

  // Card layout: thumbnail occupies ~52% of canvas width, centered. Title +
  // metadata wrap under it. Total card height ≈ thumb_h + title + meta + pad.
  const cardW = Math.round(width * 0.52);   // 1920 → ~1000px
  const thumbAspect = 16 / 9;
  const thumbH = Math.round(cardW / thumbAspect);  // 1000 → ~562px
  const totalCardH = thumbH + 60 /*gap*/ + 56 * 1.18 * 2 /*title 2 lines*/ + 36 /*meta*/ + 34 /*meta height*/;
  const cardX = Math.round((width - cardW) / 2);
  const cardY = Math.round((height - totalCardH) / 2);

  // 1. Render the white canvas.
  const canvas = sharp({
    create: { width, height, channels: 4, background: bgHex },
  });

  // 2. Fetch + size the thumbnail to thumbW × thumbH with rounded-corner mask.
  const thumbBuf = await fetchThumbnail(args.video_id);
  const radius = 12;
  // Create a rounded-rect mask
  const mask = Buffer.from(
    `<svg width="${cardW}" height="${thumbH}"><rect x="0" y="0" width="${cardW}" height="${thumbH}" rx="${radius}" ry="${radius}" fill="white"/></svg>`,
  );
  const thumbRendered = await sharp(thumbBuf)
    .resize(cardW, thumbH, { fit: 'cover', position: 'centre' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // 3. Build the SVG overlay (title + metadata + dots + badge + watermark).
  const overlaySvg = buildOverlaySvg({
    width, height, cardX, cardY, cardW, thumbH,
    title: args.title,
    viewsAgeLine: args.age_phrase ? `${humanizeViews(args.views)} • ${args.age_phrase}` : humanizeViews(args.views),
    durationBadge: args.duration_badge,
    channelWatermark: args.channel_watermark,
    fg, mutedFg,
  });

  // 4. Composite everything onto the canvas.
  await canvas
    .composite([
      { input: thumbRendered, left: cardX, top: cardY },
      { input: Buffer.from(overlaySvg), left: 0, top: 0 },
    ])
    .png()
    .toFile(outPath);

  return { file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('cards/' + hash + '.png')}`, local_path: outPath, width, height };
}
