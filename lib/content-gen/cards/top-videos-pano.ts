/**
 * top_videos_pano — MG-style "channel videos tab" panorama composer.
 *
 * MG reference (frame inspection of VES STICK source):
 *   - White outer canvas.
 *   - Centered dark gray (#202020) rounded card.
 *   - Inside: a 4×2 grid of 8 video cards (cols × rows).
 *   - Each video card:
 *       - 16:9 thumbnail with rounded corners.
 *       - Channel watermark "VES STICK" centered at the bottom of the
 *         thumbnail (white text with black stroke).
 *       - Dark pill duration badge at bottom-right of the thumbnail.
 *       - Title (white) wrapping 2 lines below the thumbnail.
 *       - 3-dot vertical menu (gray) at the right of the title row.
 *       - Metadata line below: "29m views · 7 months ago" (muted gray).
 *
 * Inputs:
 *   videos: up to 8 entries with {video_id, title, views, posted_at, duration_badge}
 *   channel_watermark: short text overlaid on each thumbnail (e.g. "VES STICK")
 *
 * Output: 1920×1080 PNG.
 *
 * The composer ALWAYS fetches thumbnails from YT's public CDN
 * (i.ytimg.com) — these are not copyrighted MG content; they're the
 * actual channel's video thumbnails. Same approach as
 * `most-popular-callout.ts`. If a thumbnail fails, that cell is left
 * blank (dark gray) so the layout doesn't collapse.
 */

import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { CLIPS_DIR } from '../../clips-dir';

const CARD_DIR = path.join(CLIPS_DIR, 'producer_renders', 'cards');

export interface TopVideosPanoItem {
  video_id: string;
  title: string;
  views: number;
  age_phrase?: string;     // pre-formatted "7 months ago"
  duration_badge?: string; // "34:32" — optional
}

export interface TopVideosPanoArgs {
  videos: TopVideosPanoItem[];
  channel_watermark?: string;
  bg?: 'white' | 'dark_gray';
  cols?: number; // default 4
  rows?: number; // default 2
}

const BG_WHITE = '#FFFFFF';
const CARD_BG = '#202020';
const CELL_BG = '#3A3A3A'; // empty thumb fallback
const TEXT = '#FFFFFF';
const MUTED = '#AAAAAA';

function hashArgs(args: TopVideosPanoArgs, w: number, h: number): string {
  return crypto.createHash('sha256').update(JSON.stringify({ ...args, w, h, v: 1 })).digest('hex').slice(0, 32);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function humanizeViews(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k views`;
  return `${n} views`;
}

function wrapTitle(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const tentative = cur ? `${cur} ${w}` : w;
    if (tentative.length <= maxCharsPerLine) cur = tentative;
    else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length >= 2) break;
    }
  }
  if (cur && lines.length < 2) lines.push(cur);
  if (lines.length === 2 && words.length > lines.join(' ').split(/\s+/).length) {
    lines[1] = lines[1].replace(/\s*\S+\s*$/, '') + '…';
  }
  return lines.slice(0, 2);
}

async function fetchThumbnail(video_id: string): Promise<Buffer | null> {
  const urls = [
    `https://i.ytimg.com/vi/${video_id}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${video_id}/maxresdefault.jpg`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 1000) return buf;
    } catch { /* try next */ }
  }
  return null;
}

/** Build a single video card's overlay SVG (title + dots + meta + watermark
 *  + duration badge). The thumbnail itself is composited separately. */
function buildCellOverlaySvg(args: {
  width: number; height: number;
  x: number; y: number; w: number; thumbH: number;
  title: string; metaText: string;
  durationBadge?: string;
  channelWatermark?: string;
}): string {
  const { x, y, w, thumbH, title, metaText, durationBadge, channelWatermark } = args;

  const titleFontSize = 28;
  const lineHeight = titleFontSize * 1.18;
  const titleY = y + thumbH + 34;
  const maxChars = Math.floor((w - 60) / (titleFontSize * 0.5));
  const lines = wrapTitle(title, Math.max(20, maxChars));
  const titleTspans = lines.map((ln, i) =>
    `<text x="${x}" y="${titleY + i * lineHeight}"
           font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
           font-size="${titleFontSize}" font-weight="600" fill="${TEXT}">${esc(ln)}</text>`
  ).join('');

  const metaY = titleY + lines.length * lineHeight + 22;
  const metaFontSize = 22;
  const metaSvg = `<text x="${x}" y="${metaY}"
                          font-family="system-ui, -apple-system, sans-serif"
                          font-size="${metaFontSize}" font-weight="400" fill="${MUTED}">${esc(metaText)}</text>`;

  const dotsX = x + w - 14;
  const dotsY = titleY - titleFontSize + 6;
  const dotsR = 3;
  const dots = `
    <circle cx="${dotsX}" cy="${dotsY}"      r="${dotsR}" fill="${MUTED}"/>
    <circle cx="${dotsX}" cy="${dotsY + 11}" r="${dotsR}" fill="${MUTED}"/>
    <circle cx="${dotsX}" cy="${dotsY + 22}" r="${dotsR}" fill="${MUTED}"/>
  `;

  const durBadge = durationBadge ? `
    <rect x="${x + w - 76}" y="${y + thumbH - 32}" width="62" height="22" rx="3" fill="#000000" fill-opacity="0.82"/>
    <text x="${x + w - 76 + 31}" y="${y + thumbH - 16}"
          font-family="system-ui, sans-serif" font-size="16" font-weight="700"
          fill="#FFFFFF" text-anchor="middle">${esc(durationBadge)}</text>
  ` : '';

  const watermark = channelWatermark ? `
    <text x="${x + w / 2}" y="${y + thumbH - 14}"
          font-family="system-ui, sans-serif" font-size="22" font-weight="800"
          fill="#FFFFFF" stroke="#000000" stroke-width="3" paint-order="stroke fill"
          stroke-linejoin="round" text-anchor="middle">${esc(channelWatermark)}</text>
  ` : '';

  return `${durBadge}${watermark}${titleTspans}${metaSvg}${dots}`;
}

export async function renderTopVideosPano(
  args: TopVideosPanoArgs,
  width = 1920,
  height = 1080,
): Promise<{ file_url: string; local_path: string; width: number; height: number }> {
  await fs.mkdir(CARD_DIR, { recursive: true });
  const hash = hashArgs(args, width, height);
  const outPath = path.join(CARD_DIR, `top_videos_pano_${hash}.png`);
  try {
    const st = await fs.stat(outPath);
    if (st.size > 0) {
      return {
        file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('cards/top_videos_pano_' + hash + '.png')}`,
        local_path: outPath, width, height,
      };
    }
  } catch { /* miss */ }

  const cols = args.cols ?? 4;
  const rows = args.rows ?? 2;
  const cells = cols * rows;
  // Pad or truncate the video list so layout is always full.
  const videos = args.videos.slice(0, cells);

  // Card occupies ~92% of canvas; outer white canvas leaves a small margin.
  const cardMargin = 40;
  const cardW = width - 2 * cardMargin;
  const cardH = height - 2 * cardMargin;
  const cardX = cardMargin;
  const cardY = cardMargin;
  const cardRadius = 32;

  // Inner padding inside the card.
  const innerPadX = 50;
  const innerPadY = 40;
  const innerW = cardW - 2 * innerPadX;
  const innerH = cardH - 2 * innerPadY;

  // Gaps between cells.
  const gapX = 28;
  const gapY = 40;

  const cellW = Math.floor((innerW - gapX * (cols - 1)) / cols);
  const thumbH = Math.floor(cellW * 9 / 16);
  // Each cell: thumbnail + title (2 lines) + meta + bottom pad.
  // Compute total cell height. (matches buildCellOverlaySvg layout above)
  const titleFontSize = 28;
  const lineHeight = titleFontSize * 1.18;
  const titleBlock = lineHeight * 2;     // 2 lines max
  const metaBlock = 22 + 12;              // meta font + gap
  const cellH = thumbHFor(cellW) + 34 + titleBlock + metaBlock;
  // If 2 rows make us overflow, shrink cellW.
  // (left as-is — cellH should fit; if not we trim title to 1 line via wrapTitle.)

  // Origin of the grid inside the card.
  const gridX = cardX + innerPadX;
  const gridY = cardY + innerPadY;

  // 1. Render outer canvas + dark card via SVG.
  const baseSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${BG_WHITE}"/>
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="${cardRadius}" ry="${cardRadius}" fill="${CARD_BG}"/>
</svg>`;

  const canvas = sharp(Buffer.from(baseSvg)).png();

  // 2. Fetch all thumbnails in parallel.
  const thumbs = await Promise.all(videos.map(v => fetchThumbnail(v.video_id)));

  // 3. Build per-cell composite layers (thumbnail image + overlay SVG).
  const composites: sharp.OverlayOptions[] = [];
  let cellOverlaySvgInner = '';
  for (let i = 0; i < cells; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = Math.round(gridX + col * (cellW + gapX));
    const y = Math.round(gridY + row * (cellH + (gapY - 24))); // adjust gapY contribution
    const video = videos[i];
    if (!video) {
      // empty cell — render a dim placeholder rect for the thumbnail.
      const filler = await sharp({
        create: { width: cellW, height: thumbH, channels: 4, background: CELL_BG },
      }).png().toBuffer();
      composites.push({ input: filler, left: x, top: y });
      continue;
    }
    const thumb = thumbs[i];
    const radius = 10;
    const mask = Buffer.from(
      `<svg width="${cellW}" height="${thumbH}"><rect x="0" y="0" width="${cellW}" height="${thumbH}" rx="${radius}" ry="${radius}" fill="white"/></svg>`,
    );
    let thumbBuf: Buffer;
    if (thumb) {
      thumbBuf = await sharp(thumb)
        .resize(cellW, thumbH, { fit: 'cover', position: 'centre' })
        .composite([{ input: mask, blend: 'dest-in' }])
        .png().toBuffer();
    } else {
      thumbBuf = await sharp({ create: { width: cellW, height: thumbH, channels: 4, background: CELL_BG } })
        .composite([{ input: mask, blend: 'dest-in' }])
        .png().toBuffer();
    }
    composites.push({ input: thumbBuf, left: x, top: y });

    const metaText = video.age_phrase
      ? `${humanizeViews(video.views)} · ${video.age_phrase}`
      : humanizeViews(video.views);
    cellOverlaySvgInner += buildCellOverlaySvg({
      width, height, x, y, w: cellW, thumbH,
      title: video.title,
      metaText,
      durationBadge: video.duration_badge,
      channelWatermark: args.channel_watermark,
    });
  }

  const overlaySvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${cellOverlaySvgInner}</svg>`;
  composites.push({ input: Buffer.from(overlaySvg), left: 0, top: 0 });

  await canvas.composite(composites).png().toFile(outPath);

  return {
    file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('cards/top_videos_pano_' + hash + '.png')}`,
    local_path: outPath, width, height,
  };
}

function thumbHFor(cellW: number): number {
  return Math.floor(cellW * 9 / 16);
}
