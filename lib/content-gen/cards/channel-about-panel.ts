/**
 * channel_about_panel — composes the MG-style "About modal More info"
 * stats panel from channel data on a white canvas.
 *
 * MG reference (frame inspection of VES STICK source video):
 *   - Pure white background outside.
 *   - Single dark gray (#202020) rounded rectangle card, centered.
 *   - Card contains a stack of 6 stat rows:
 *       globe-icon + handle url (www.youtube.com/@HANDLE)
 *       globe-icon + country (e.g. "United States")
 *       info-i-icon + "Joined DD Mon YYYY"
 *       people-arc-icon + "Nk subscribers"
 *       play-icon + "N videos"
 *       chart-up-icon + "N,NNN,NNN views"
 *   - "Share channel" pill at the bottom (subtle mid-gray).
 *   - Yellow vertical HIGHLIGHT BAR (a tall thin rect, ~10px x ~50px,
 *     yellow #F4E04D) immediately to the LEFT of the called-out row's
 *     text (between the icon and the text). NOT a sharpie circle.
 *   - All text white, system-ui weight 600.
 *
 * Inputs:
 *   handle, country, joined_phrase, subscribers, video_count, total_views
 *   highlight: which row to mark with the yellow bar
 *     'subscribers' | 'videos' | 'views' | 'handle' | 'country' | 'joined' | null
 *
 * Output: 1920×1080 PNG, cached by SHA256.
 */

import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { CLIPS_DIR } from '../../clips-dir';

const CARD_DIR = path.join(CLIPS_DIR, 'producer_renders', 'cards');

export type AboutHighlight = 'handle' | 'country' | 'joined' | 'subscribers' | 'videos' | 'views' | null;

export interface ChannelAboutPanelArgs {
  handle: string;              // "@VESSTICK" (with or without leading @)
  country?: string;            // "United States"
  joined_phrase?: string;      // "Joined 18 Jan 2025"
  subscribers: string;         // "437k subscribers"
  video_count: string;         // "122 videos"
  total_views: string;         // "110,311,861 views"
  highlight?: AboutHighlight;
}

const BG = '#FFFFFF';
const CARD_BG = '#202020';
const TEXT = '#FFFFFF';
const HIGHLIGHT_COLOR = '#E8E84F';
const SHARE_BG = '#3A3A3A';

function hashArgs(args: ChannelAboutPanelArgs, w: number, h: number): string {
  return crypto.createHash('sha256').update(JSON.stringify({ ...args, w, h, v: 2 })).digest('hex').slice(0, 32);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * YT-style row icons as inline SVG path strings. Each icon is designed to
 * fit a 24×24 viewBox; we scale it via outer SVG <svg> sizing.
 *
 * Sources are deliberate approximations of YT's icon set — we don't
 * reproduce YT's actual SVG files (those are copyrighted), just shapes
 * that read as the same metaphor at a glance.
 */
const ICONS: Record<string, string> = {
  // Globe (handle URL + country use this; YT uses the same icon for both)
  globe: `
    <circle cx="12" cy="12" r="10" fill="none" stroke="white" stroke-width="1.6"/>
    <ellipse cx="12" cy="12" rx="4" ry="10" fill="none" stroke="white" stroke-width="1.6"/>
    <line x1="2" y1="12" x2="22" y2="12" stroke="white" stroke-width="1.6"/>
  `,
  // Info (i in a circle) — "Joined" row
  info: `
    <circle cx="12" cy="12" r="10" fill="none" stroke="white" stroke-width="1.6"/>
    <rect x="11" y="10" width="2" height="7" fill="white"/>
    <circle cx="12" cy="7.5" r="1.3" fill="white"/>
  `,
  // People with the bottom-arc "subscribed" indicator
  subs: `
    <circle cx="12" cy="9" r="3.4" fill="none" stroke="white" stroke-width="1.6"/>
    <path d="M 5 19 Q 5 15 12 15 Q 19 15 19 19" fill="none" stroke="white" stroke-width="1.6"/>
    <path d="M 14.5 5 Q 18 8 14.5 11" fill="none" stroke="white" stroke-width="1.4"/>
    <path d="M 17 4 Q 21 8 17 12" fill="none" stroke="white" stroke-width="1.4"/>
  `,
  // Play-button (videos)
  play: `
    <rect x="2.5" y="6" width="19" height="13" rx="2.5" fill="none" stroke="white" stroke-width="1.6"/>
    <polygon points="10.5,9.5 16,12.5 10.5,15.5" fill="white"/>
  `,
  // Chart-up (views)
  chart: `
    <path d="M 3 18 L 9 12 L 13 16 L 21 7" fill="none" stroke="white" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    <polyline points="16,7 21,7 21,12" fill="none" stroke="white" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
  `,
  // Share-arrow (share channel pill)
  share: `
    <path d="M 4 12 Q 4 6 12 7" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <polygon points="10,4 14,7 10,10" fill="white"/>
  `,
};

function rowIconSvg(name: keyof typeof ICONS, size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${ICONS[name]}</svg>`;
}

function normalizeHandle(h: string): string {
  if (!h) return '@channel';
  return h.startsWith('@') ? h : `@${h}`;
}

interface RowSpec {
  key: AboutHighlight;
  icon: keyof typeof ICONS;
  text: string;
}

export async function renderChannelAboutPanel(
  args: ChannelAboutPanelArgs,
  width = 1920,
  height = 1080,
): Promise<{ file_url: string; local_path: string; width: number; height: number }> {
  await fs.mkdir(CARD_DIR, { recursive: true });
  const hash = hashArgs(args, width, height);
  const outPath = path.join(CARD_DIR, `about_panel_${hash}.png`);
  try {
    const st = await fs.stat(outPath);
    if (st.size > 0) {
      return { file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('cards/about_panel_' + hash + '.png')}`, local_path: outPath, width, height };
    }
  } catch { /* cache miss */ }

  const handle = normalizeHandle(args.handle);
  const country = args.country || 'United States';
  const joined = args.joined_phrase || 'Joined 2025';

  // Compose row list. Skip empty ones if the caller omitted optionals.
  const rows: RowSpec[] = [
    { key: 'handle',      icon: 'globe', text: `www.youtube.com/${handle}` },
    { key: 'country',     icon: 'globe', text: country },
    { key: 'joined',      icon: 'info',  text: joined },
    { key: 'subscribers', icon: 'subs',  text: args.subscribers },
    { key: 'videos',      icon: 'play',  text: args.video_count },
    { key: 'views',       icon: 'chart', text: args.total_views },
  ];

  // Layout. Card occupies ~55% of canvas width and ~75% of height,
  // centered. Inside: 28px-side padding, 6 rows × ~85px row-height,
  // then Share-channel pill at bottom.
  const cardW = Math.round(width * 0.58);
  const cardH = Math.round(height * 0.78);
  const cardX = Math.round((width - cardW) / 2);
  const cardY = Math.round((height - cardH) / 2);
  const cardRadius = 28;

  const padX = 80;
  const rowGap = 92;
  const rowFontSize = 48;
  const iconSize = 56;
  const rowsTopOffset = 70;

  // Build SVG with everything in one go — easier than compositing many
  // small layers.
  const rowsSvg = rows.map((r, i) => {
    const cy = cardY + rowsTopOffset + i * rowGap + iconSize / 2;
    const iconX = cardX + padX;
    const iconY = cy - iconSize / 2;
    const textX = iconX + iconSize + 36;
    // Highlight bar BETWEEN the icon and the text — a thin vertical rect.
    const isHighlighted = args.highlight && args.highlight === r.key;
    const highlightSvg = isHighlighted ? `
      <rect x="${textX - 22}" y="${cy - rowFontSize / 2 - 4}"
            width="10" height="${rowFontSize + 8}"
            fill="${HIGHLIGHT_COLOR}"/>
    ` : '';
    // Embed the icon's inner shapes inside the outer SVG via a <g> with translate.
    return `
      <g transform="translate(${iconX}, ${iconY})">
        <svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" overflow="visible">
          ${ICONS[r.icon]}
        </svg>
      </g>
      ${highlightSvg}
      <text x="${textX}" y="${cy + 14}"
            font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            font-size="${rowFontSize}" font-weight="500" fill="${TEXT}">${esc(r.text)}</text>
    `;
  }).join('');

  // Share channel pill at the bottom of the card.
  const pillH = 78;
  const pillW = 360;
  const pillX = cardX + padX;
  const pillY = cardY + cardH - pillH - 80;
  const pillIconSize = 36;
  const sharePill = `
    <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" ry="${pillH / 2}" fill="${SHARE_BG}"/>
    <g transform="translate(${pillX + 32}, ${pillY + (pillH - pillIconSize) / 2})">
      <svg width="${pillIconSize}" height="${pillIconSize}" viewBox="0 0 24 24" overflow="visible">
        ${ICONS.share}
      </svg>
    </g>
    <text x="${pillX + 32 + pillIconSize + 22}" y="${pillY + pillH / 2 + 14}"
          font-family="system-ui, -apple-system, sans-serif"
          font-size="38" font-weight="500" fill="${TEXT}">Share channel</text>
  `;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${BG}"/>
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="${cardRadius}" ry="${cardRadius}" fill="${CARD_BG}"/>
  ${rowsSvg}
  ${sharePill}
</svg>`;

  await sharp(Buffer.from(svg)).png().toFile(outPath);

  return {
    file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('cards/about_panel_' + hash + '.png')}`,
    local_path: outPath,
    width,
    height,
  };
}
