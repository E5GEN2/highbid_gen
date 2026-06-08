/**
 * Real image_gen — renders text_card / chalkboard_card / icon_card / title-
 * sequence card to disk via Sharp/SVG.
 *
 * Caches by SHA256 of the input args, so the same (composition + text +
 * bg_mode + color_treatment + icon) → same file. Re-renders are free.
 *
 * Renders at 1920×1080 by default (long-form 16:9 — MG videos are ~14-min
 * YT long-form, not Shorts). Caller can override per call.
 *
 *   text_card:  big bold center-set text on solid bg. The "highlighted"
 *               token (matched by color_treatment) gets a colored span.
 *   chalkboard: dark slate bg + chalk_cream text + slight rotation
 *               (-1.5°) + a subtle "chalk noise" overlay.
 *   icon_card:  uses an SVG from the canonical icon library (named via
 *               args.icon). Centered, monochrome (white on dark, black
 *               on white) per bg_mode. NOTE: icon library assets aren't
 *               in repo yet — for now uses a labeled placeholder so the
 *               compositor doesn't crash; real assets land with task #1.
 *   title_seq:  same as text_card but with a different layout — animated
 *               feel left to the producer's Ken Burns step.
 */

import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { CLIPS_DIR } from '../clips-dir';
import type { ImageGenArgs, ImageGenOutput, ColorTreatment } from './tools';
import { iconSvgAt, type IconId } from './icon-library';

// Live inside producer_renders/ so the existing /producer/file endpoint can
// serve them without per-route safety overhead.
const IMG_DIR = path.join(CLIPS_DIR, 'producer_renders', 'images');

/** Color token → hex code (visual-packaging-class-b). Yellow is highlight-
 *  only — never inline text color (so we map it to neutral text + a yellow
 *  underline highlight). */
const COLOR_HEX: Record<ColorTreatment, { fg: string; highlight?: string }> = {
  neutral:           { fg: '#111111' },                          // black
  money_shot_green:  { fg: '#22C55E' },                          // green
  inline_green:      { fg: '#22C55E' },
  inline_red:        { fg: '#EF4444' },
  chalk_cream:       { fg: '#F5EFD9' },
  yellow_ring:       { fg: '#111111', highlight: '#FACC15' },    // highlight via underline
};

const BG_HEX = { white: '#FFFFFF', dark_gray: '#2A2A2A' } as const;

/** Sanity-cap text length so we don't render an unreadable wall. */
const MAX_TEXT_LEN = 80;

/** Hash the args → cache key. */
function cacheKey(args: ImageGenArgs, width: number, height: number): string {
  const key = JSON.stringify({ ...args, width, height });
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** Escape XML-special chars so user text doesn't break the SVG. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Estimate font size that fits the text within the canvas without wrapping
 *  more than 4 lines. Heuristic: ~0.55em average char width at sans-serif. */
function fitFontSize(text: string, width: number, height: number, maxLines = 3): number {
  const targetWidth = width * 0.85;
  const targetHeight = height * 0.55;
  // First pass: pick font size by width (one line fits).
  let fontSize = Math.floor(targetWidth / (Math.max(1, text.length) * 0.55));
  // Cap by height (4 lines max).
  const heightCap = Math.floor(targetHeight / maxLines);
  fontSize = Math.min(fontSize, heightCap);
  // Floor / ceiling: 48-200px.
  return Math.max(48, Math.min(200, fontSize));
}

/** Soft word wrap — splits text into <= maxLines lines of ~maxCharsPerLine
 *  characters each. Doesn't break words. */
function wrap(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const tentative = cur ? cur + ' ' + w : w;
    if (tentative.length <= maxCharsPerLine) {
      cur = tentative;
    } else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines);
}

// ───────────────────────────────────────────────────────────────────
// Composition renderers
// ───────────────────────────────────────────────────────────────────

function renderTextCard(args: ImageGenArgs, width: number, height: number): string {
  const text = String(args.text ?? '').slice(0, MAX_TEXT_LEN);
  const bg = (args.bg_mode === 'dark_gray') ? 'dark_gray' : 'white';
  const ct = (args.color_treatment ?? 'neutral') as ColorTreatment;
  const colors = COLOR_HEX[ct] ?? COLOR_HEX.neutral;
  const baseFont = fitFontSize(text, width, height, 3);
  const lines = wrap(text, Math.max(6, Math.floor((width * 0.85) / (baseFont * 0.55))), 3);
  const lineHeight = baseFont * 1.18;
  const totalH = lines.length * lineHeight;
  const startY = height / 2 - totalH / 2 + baseFont * 0.85;

  const fontWeight = ct === 'money_shot_green' ? 900 : 800;
  const fg = colors.fg;
  const highlight = colors.highlight;

  // Optional yellow-underline highlight bar behind text (yellow_ring on
  // text_card — uncommon but per slot-rendering's color enum).
  const highlightBar = highlight ? `
    <rect x="${width * 0.075}" y="${startY - baseFont * 0.92}"
          width="${width * 0.85}" height="${baseFont * 1.05}"
          fill="${highlight}" opacity="0.45"/>` : '';

  const tspans = lines.map((ln, i) => `
    <text x="${width / 2}" y="${startY + i * lineHeight}"
          font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
          font-size="${baseFont}" font-weight="${fontWeight}"
          fill="${fg}" text-anchor="middle">${esc(ln)}</text>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${BG_HEX[bg]}"/>
  ${highlightBar}
  ${tspans}
</svg>`;
}

function renderChalkboardCard(args: ImageGenArgs, width: number, height: number): string {
  const text = String(args.text ?? '').slice(0, MAX_TEXT_LEN);
  const baseFont = fitFontSize(text, width, height, 2);
  const lines = wrap(text, Math.max(6, Math.floor((width * 0.85) / (baseFont * 0.55))), 2);
  const lineHeight = baseFont * 1.15;
  const totalH = lines.length * lineHeight;
  const startY = height / 2 - totalH / 2 + baseFont * 0.85;

  // Slight rotation for hand-drawn chalkboard feel.
  const rotation = -1.5;

  const tspans = lines.map((ln, i) => `
    <text x="${width / 2}" y="${startY + i * lineHeight}"
          font-family="'Caveat', 'Comic Sans MS', cursive, sans-serif"
          font-size="${baseFont}" font-weight="700"
          fill="#F5EFD9" text-anchor="middle">${esc(ln)}</text>`).join('');

  // Background: dark slate + a soft noise texture via a filter.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="chalk-noise" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0.96  0 0 0 0 0.94  0 0 0 0 0.85  0 0 0 0.06 0"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="#1F2A2F"/>
  <rect width="${width}" height="${height}" filter="url(#chalk-noise)"/>
  <g transform="rotate(${rotation} ${width / 2} ${height / 2})">${tspans}</g>
</svg>`;
}

function renderIconCard(args: ImageGenArgs, width: number, height: number): string {
  const text = String(args.text ?? '').slice(0, MAX_TEXT_LEN);
  const icon = (args.icon ?? 'shrug_emoji') as IconId;
  const bg = (args.bg_mode === 'dark_gray') ? 'dark_gray' : 'white';
  // Text color comes from color_treatment (matches text_card behaviour).
  const ct = (args.color_treatment ?? 'neutral') as ColorTreatment;
  const textColor = COLOR_HEX[ct]?.fg ?? COLOR_HEX.neutral.fg;
  const iconStroke = bg === 'dark_gray' ? '#FFFFFF' : '#111111';
  // Money-shot greens — both inline and money_shot — use the bright green
  // accent for icon fill so dollar/check icons feel cohesive with the text.
  const iconAccent = (ct === 'money_shot_green' || ct === 'inline_green')
    ? '#22C55E'
    : (ct === 'inline_red' ? '#EF4444' : '#22C55E');
  // Push the icon above center, text below — so they don't overlap on
  // longer text strings. Icon size scales with canvas (300px on a 1080p canvas).
  const textFont = fitFontSize(text, width, height, 2);
  const iconY = Math.round(height * 0.36);
  const iconSize = Math.round(Math.min(width, height) * 0.32); // ~340px at 1080p
  const textY = Math.round(height * 0.74);
  const iconSvg = iconSvgAt(icon, width / 2, iconY, iconSize, iconStroke, iconAccent);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${BG_HEX[bg]}"/>
  ${iconSvg}
  <text x="${width / 2}" y="${textY}"
        font-family="system-ui, -apple-system, sans-serif" font-size="${textFont}" font-weight="800"
        fill="${textColor}" text-anchor="middle">${esc(text)}</text>
</svg>`;
}

function renderTitleSequenceCard(args: ImageGenArgs, width: number, height: number): string {
  // Same shape as text_card but with a stronger top-line emphasis — for the
  // optional video_intro preamble. We bias bigger fonts + tighter letters.
  return renderTextCard({ ...args, color_treatment: args.color_treatment ?? 'neutral' }, width, height);
}

// ───────────────────────────────────────────────────────────────────
// Top-level entry — called by producer-tools.runImageGen
// ───────────────────────────────────────────────────────────────────

// Default 16:9 long-form (1920×1080). Money Groot videos are ~14-min YT
// long-form, not Shorts. Per-call override via args (width/height).
export async function imageGenerate(args: ImageGenArgs, width = 1920, height = 1080): Promise<ImageGenOutput & { local_path: string }> {
  await fs.mkdir(IMG_DIR, { recursive: true });
  const hash = cacheKey(args, width, height);
  const outPath = path.join(IMG_DIR, `${hash}.png`);

  try {
    const st = await fs.stat(outPath);
    if (st.size > 0) {
      return {
        file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('images/' + hash + '.png')}`,
        width, height,
        local_path: outPath,
      };
    }
  } catch { /* cache miss → render */ }

  // Special composition: most_popular_callout has its own renderer
  // (composes a YT-card-shaped layout from thumbnail + title + view count
  // metadata; not SVG-only — pulls the thumbnail image).
  if (args.composition === 'most_popular_callout') {
    if (!args.video_id) throw new Error('most_popular_callout: video_id required');
    const { renderMostPopularCallout } = await import('./cards/most-popular-callout');
    const r = await renderMostPopularCallout({
      video_id: args.video_id,
      title: args.text,
      views: args.views ?? 0,
      age_phrase: args.age_phrase,
      duration_badge: args.duration_badge,
      channel_watermark: args.channel_watermark,
      bg: args.bg_mode,
    }, width, height);
    // Mirror the cached file into our own cache slot so the rest of the
    // pipeline doesn't see a different file_url scheme.
    await fs.copyFile(r.local_path, outPath);
    return {
      file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('images/' + hash + '.png')}`,
      width, height,
      local_path: outPath,
    };
  }

  // Special composition: top_videos_pano — composes MG-style 4×2 grid of
  // the channel's videos on a dark gray rounded card / white outer canvas.
  // Each cell is a YT-style thumbnail card (thumbnail + title + meta).
  if (args.composition === 'top_videos_pano') {
    if (!args.videos || args.videos.length === 0) {
      throw new Error('top_videos_pano: videos[] required');
    }
    const { renderTopVideosPano } = await import('./cards/top-videos-pano');
    const r = await renderTopVideosPano({
      videos: args.videos,
      channel_watermark: args.channel_watermark,
      bg: args.bg_mode,
    }, width, height);
    await fs.copyFile(r.local_path, outPath);
    return {
      file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('images/' + hash + '.png')}`,
      width, height,
      local_path: outPath,
    };
  }

  // Special composition: channel_about_panel — composes the MG-style
  // "More info" stats card on white from channel data (handle, country,
  // joined, subscribers, videos, views). Highlight is a thin yellow
  // vertical bar next to the called-out row.
  if (args.composition === 'channel_about_panel') {
    if (!args.subscribers_text || !args.video_count_text || !args.total_views_text) {
      throw new Error('channel_about_panel: subscribers_text, video_count_text, total_views_text required');
    }
    const { renderChannelAboutPanel } = await import('./cards/channel-about-panel');
    const r = await renderChannelAboutPanel({
      handle: args.handle ?? '@channel',
      country: args.country,
      joined_phrase: args.joined_phrase,
      subscribers: args.subscribers_text,
      video_count: args.video_count_text,
      total_views: args.total_views_text,
      highlight: args.highlight_row ?? null,
    }, width, height);
    await fs.copyFile(r.local_path, outPath);
    return {
      file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('images/' + hash + '.png')}`,
      width, height,
      local_path: outPath,
    };
  }

  let svg: string;
  switch (args.composition) {
    case 'text_card':                    svg = renderTextCard(args, width, height); break;
    case 'chalkboard_card':              svg = renderChalkboardCard(args, width, height); break;
    case 'icon_card':                    svg = renderIconCard(args, width, height); break;
    case 'text_card_in_title_sequence':  svg = renderTitleSequenceCard(args, width, height); break;
    default:                             svg = renderTextCard(args, width, height);
  }

  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return {
    file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('images/' + hash + '.png')}`,
    width, height,
    local_path: outPath,
  };
}
