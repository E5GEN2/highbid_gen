/**
 * Real image_gen — renders text_card / chalkboard_card / icon_card / title-
 * sequence card to disk via Sharp/SVG.
 *
 * Caches by SHA256 of the input args, so the same (composition + text +
 * bg_mode + color_treatment + icon) → same file. Re-renders are free.
 *
 * Renders at 1080×1920 (matches the producer's canvas) so video-compose
 * can use them without scaling artifacts.
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
  // Icon assets aren't in repo yet (task #1 still in flight). Render a
  // labeled placeholder that names which icon was requested — so the
  // pipeline runs end-to-end and the GUI shows what the composition
  // would have looked like.
  const text = String(args.text ?? '').slice(0, MAX_TEXT_LEN);
  const icon = String(args.icon ?? '?');
  const bg = (args.bg_mode === 'dark_gray') ? 'dark_gray' : 'white';
  // Text color comes from color_treatment (matches text_card behaviour).
  // Icon outline stays neutral (white/black per bg_mode) so it reads as a
  // separate placeholder marker, not as part of the styled text token.
  const ct = (args.color_treatment ?? 'neutral') as ColorTreatment;
  const textColor = COLOR_HEX[ct]?.fg ?? COLOR_HEX.neutral.fg;
  const iconStroke = bg === 'dark_gray' ? '#FFFFFF' : '#111111';
  // Push the icon above center, text below — so they don't overlap on
  // longer text strings. Icon area = upper third; text area = lower third.
  const textFont = fitFontSize(text, width, height, 2);
  const iconY = Math.round(height * 0.34);
  const textY = Math.round(height * 0.62);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${BG_HEX[bg]}"/>
  <circle cx="${width / 2}" cy="${iconY}" r="180" fill="none" stroke="${iconStroke}" stroke-width="8" opacity="0.35"/>
  <text x="${width / 2}" y="${iconY + 16}"
        font-family="system-ui, sans-serif" font-size="38" font-weight="600"
        fill="${iconStroke}" text-anchor="middle" opacity="0.5">[icon: ${esc(icon)}]</text>
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

export async function imageGenerate(args: ImageGenArgs, width = 1080, height = 1920): Promise<ImageGenOutput & { local_path: string }> {
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
