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

// dark_gray re-measured 2026-06-12 on MG frames: text-card bg = 60,60,60.
const BG_HEX = { white: '#FFFFFF', dark_gray: '#3C3C3C' } as const;

/** Sanity-cap text length so we don't render an unreadable wall. */
const MAX_TEXT_LEN = 80;

/** Hash the args → cache key. */
// Renderer version — salts the PNG disk cache so restyled compositions
// regenerate (args alone missed the 2026-06-11 chalkboard restyle).
const RENDERER_VERSION = 'r7'; // r5: white fg on dark cards (r4: MG dark #3C3C3C + italic builds)

function cacheKey(args: ImageGenArgs, width: number, height: number): string {
  const key = JSON.stringify({ v: RENDERER_VERSION, ...args, width, height });
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
  // MG text cards render at a MODEST, near-fixed size — measured 2026-06-14
  // on the OG: cap-height ~6-8% of frame for EVERY card type (niche name,
  // money figure, age fragment). They are NOT scaled up to fill the width;
  // a short phrase like "only 2 months ago" sits at ~38% width, ~7% cap.
  // Our old scale-to-fill ballooned short phrases to ~175px (≈56% cap) —
  // the #1 reason our cards didn't match (user 2026-06-14). Start from an
  // MG-calibrated base (~9.5% of height ≈ 7% cap-height) and shrink only
  // if the text can't fit maxLines at the target width.
  const base = Math.round(height * 0.082);   // ~89px on 1080 → ~7% cap-height (MG)
  const targetWidth = width * 0.82;
  const len = Math.max(1, text.replace(/\s+/g, ' ').trim().length);
  let fontSize = base;
  while (fontSize > 44) {
    const charsPerLine = Math.max(1, Math.floor(targetWidth / (fontSize * 0.55)));
    const lines = Math.ceil(len / charsPerLine);
    if (lines <= maxLines) break;
    fontSize -= 4;
  }
  return fontSize;
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
  // Neutral black flips to white on the dark canvas (MG dark cards are
  // white-on-#3C3C3C; un-flipped this was the dark-on-dark contrast bug).
  const fg = (bg === 'dark_gray' && colors.fg === '#111111') ? '#FFFFFF' : colors.fg;
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
          font-size="${baseFont}" font-weight="${fontWeight}"${args.italic ? ' font-style="italic"' : ''}
          fill="${fg}" text-anchor="middle">${esc(ln)}</text>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${BG_HEX[bg]}"/>
  ${highlightBar}
  ${tspans}
</svg>`;
}

/** text_card_reveal — variant k of a progressive word reveal (MG style:
 *  each word pops in as it's spoken). LAYOUT STABILITY: every variant
 *  renders the FULL text (identical wrap/centering); words beyond k are
 *  painted with fill-opacity 0. k=0 → blank card, k=wordCount → full. */
const MAX_WORDS_PER_SCREEN = 6;  // MG never prints more than 6 words per text screen

/** Split words into pages of <= MAX_WORDS_PER_SCREEN, preferring to break
 *  right after punctuation (, . — ;) like MG does ("are probably" /
 *  "from the US."). Returns the page index of each word. */
function pageOfWords(words: string[]): number[] {
  const pages: number[] = [];
  let page = 0, count = 0, lastPunct = -1;
  for (let i = 0; i < words.length; i++) {
    pages[i] = page; count++;
    if (/[,.;:—–!?]$/.test(words[i])) lastPunct = i;
    if (count >= MAX_WORDS_PER_SCREEN && i < words.length - 1) {
      if (/\d$/.test(words[i]) && /^(million|thousand|billion)\b/i.test(words[i + 1])) {
        // Never strand a number from its unit ("7.9" | "million views"): push
        // the number onto the next page so "7.9 million" reads as one views
        // count on a single frame (user 2026-06-21 #2). Highest priority — a
        // split views count looks worse than a non-punctuation break.
        pages[i] = page + 1;
        count = 1;
      } else if (lastPunct > i - count && lastPunct < i) {
        // If a recent punctuation break exists inside this page, retro-split
        // there so the page ends on a natural boundary.
        for (let j = lastPunct + 1; j <= i; j++) pages[j] = page + 1;
        count = i - lastPunct;
      } else {
        count = 0;
      }
      page++;
      lastPunct = -1;
    }
  }
  return pages;
}

function renderTextCardRevealVariant(args: ImageGenArgs, width: number, height: number, revealCount: number): string {
  const text = String(args.text ?? '').slice(0, MAX_TEXT_LEN);
  const bg = (args.bg_mode === 'dark_gray') ? 'dark_gray' : 'white';
  const ct = (args.color_treatment ?? 'neutral') as ColorTreatment;
  const colors = COLOR_HEX[ct] ?? COLOR_HEX.neutral;
  const fontWeight = ct === 'money_shot_green' ? 900 : 800;
  // Same dark-canvas flip as renderTextCard (the reveal variant missed it
  // — saturation verdict builds rendered #111 on #3C3C3C, job 157).
  const fg = (bg === 'dark_gray' && colors.fg === '#111111') ? '#FFFFFF' : colors.fg;

  // PAGING (MG rule, user-verified 2026-06-11): only the CURRENT page's
  // words are on screen; earlier pages clear. Variant k shows the page
  // containing word k-1, revealed up to k.
  const allWords = text.split(/\s+/).filter(Boolean);
  const pages = pageOfWords(allWords);
  const curPage = revealCount > 0 ? pages[Math.min(revealCount, allWords.length) - 1] : 0;
  const pageWordIdx: number[] = [];
  for (let i = 0; i < allWords.length; i++) if (pages[i] === curPage) pageWordIdx.push(i);
  const pageText = pageWordIdx.map(i => allWords[i]).join(' ');

  const baseFont = fitFontSize(pageText || ' ', width, height, 3);
  const lines = wrap(pageText, Math.max(6, Math.floor((width * 0.85) / (baseFont * 0.55))), 3);
  const lineHeight = baseFont * 1.18;
  const totalH = lines.length * lineHeight;
  const startY = height / 2 - totalH / 2 + baseFont * 0.85;

  let cursor = 0;
  const texts = lines.map((ln, i) => {
    const tspans = ln.split(/\s+/).filter(Boolean).map((w, wi) => {
      const globalIdx = pageWordIdx[cursor];
      cursor++;
      const visible = globalIdx < revealCount;
      const lead = wi > 0 ? ' ' : '';
      return `<tspan fill-opacity="${visible ? 1 : 0}">${lead}${esc(w)}</tspan>`;
    }).join('');
    return `
    <text x="${width / 2}" y="${startY + i * lineHeight}" xml:space="preserve"
          font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
          font-size="${baseFont}" font-weight="${fontWeight}"${args.italic ? ' font-style="italic"' : ''}
          fill="${fg}" text-anchor="middle">${tspans}</text>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${BG_HEX[bg]}"/>
  ${texts}
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

  // MG reference (decoded timeline t=271): "Dark gray background. A black
  // chalk board GRAPHIC appears with white text" — the board is an OBJECT
  // on the canvas, not a full-bleed slate (user feedback 2026-06-11).
  const BW = Math.round(width * 0.62), BH = Math.round(height * 0.58);
  const BX = Math.round((width - BW) / 2), BY = Math.round((height - BH) / 2);
  const boardFont = Math.min(fitFontSize(text, BW, BH, 2), 150);
  const bLines = wrap(text, Math.max(6, Math.floor((BW * 0.8) / (boardFont * 0.55))), 2);
  const bLineH = boardFont * 1.15;
  const bStartY = BY + BH / 2 - (bLines.length * bLineH) / 2 + boardFont * 0.85;

  const tspans = bLines.map((ln, i) => `
    <text x="${width / 2}" y="${bStartY + i * bLineH}"
          font-family="'Caveat', 'Comic Sans MS', cursive, sans-serif"
          font-size="${boardFont}" font-weight="700"
          fill="#F5EFD9" text-anchor="middle">${esc(ln)}</text>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="chalk-noise" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0.96  0 0 0 0 0.94  0 0 0 0 0.85  0 0 0 0.05 0"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="${BG_HEX.dark_gray}"/>
  <g transform="rotate(${rotation} ${width / 2} ${height / 2})">
    <rect x="${BX - 14}" y="${BY - 14}" width="${BW + 28}" height="${BH + 28}" rx="10" fill="#5a4632"/>
    <rect x="${BX}" y="${BY}" width="${BW}" height="${BH}" rx="4" fill="#141414"/>
    <rect x="${BX}" y="${BY}" width="${BW}" height="${BH}" rx="4" filter="url(#chalk-noise)"/>
    ${tspans}
  </g>
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
  // MG rule (user-verified 2026-06-11): icons get a DEDICATED screen —
  // no text alongside (reference: lone warning triangle on white). The
  // one sanctioned combo is the RPM-assumption card (shrug + "$3 RPM"),
  // which passes text explicitly.
  if (!text.trim()) {
    const iconSize = Math.round(Math.min(width, height) * 0.42); // bigger when alone
    const iconSvg = iconSvgAt(icon, width / 2, Math.round(height * 0.5), iconSize, iconStroke, iconAccent);
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${BG_HEX[bg]}"/>
  ${iconSvg}
</svg>`;
  }
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
export async function imageGenerate(args: ImageGenArgs, width = 1920, height = 1080): Promise<ImageGenOutput & { local_path: string; local_paths?: string[] }> {
  await fs.mkdir(IMG_DIR, { recursive: true });
  const hash = cacheKey(args, width, height);
  const outPath = path.join(IMG_DIR, `${hash}.png`);

  // thumb_mosaic — dense 4x3 grid of the channel's video thumbnails on
  // dark_gray. The skeleton's mascot_mosaic beat (silent 2.0s abundance
  // proof — reference signature: grids/mosaics at i=104/216/233/240).
  // Cells cycle through available ids when fewer than 12.
  if (args.composition === 'thumb_mosaic') {
    const ids = (args.video_ids ?? []).filter(Boolean);
    if (ids.length === 0) throw new Error('thumb_mosaic: video_ids required');
    // MG reference (i=233-234): thumbnails as DISCRETE tiles with gaps on
    // a WHITE background, camera zooming OUT to reveal more (user feedback
    // 2026-06-11 — edge-to-edge dark bands read nothing like it).
    const COLS = 5, ROWS = 4, GUT = 14;
    const cellW = Math.floor((width - GUT * (COLS + 1)) / COLS);
    const cellH = Math.floor(cellW * 9 / 16);
    const gridH = ROWS * cellH + (ROWS + 1) * GUT;
    const topPad = Math.round((height - gridH) / 2);
    const fetchThumb = async (vid: string): Promise<Buffer | null> => {
      for (const u of [`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`]) {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(8_000) });
          if (r.ok) return Buffer.from(await r.arrayBuffer());
        } catch { /* try next */ }
      }
      return null;
    };
    const unique = [...new Set(ids)];
    const bufs = (await Promise.all(unique.map(fetchThumb)));
    const good = bufs.filter((b): b is Buffer => b != null);
    if (good.length === 0) throw new Error('thumb_mosaic: no thumbnails fetchable');
    const composites: sharp.OverlayOptions[] = [];
    for (let i = 0; i < COLS * ROWS; i++) {
      const col = i % COLS, row = Math.floor(i / COLS);
      const buf = good[i % good.length];
      const cell = await sharp(buf)
        .resize(cellW, cellH, { fit: 'cover' })
        .toBuffer();
      composites.push({
        input: cell,
        left: GUT + col * (cellW + GUT),
        top: topPad + row * (cellH + GUT),
      });
    }
    await sharp({ create: { width, height, channels: 3, background: BG_HEX.white } })
      .composite(composites).png().toFile(outPath);
    return {
      file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('images/' + hash + '.png')}`,
      width, height,
      local_path: outPath,
    };
  }

  // text_card_reveal — progressive word-pop set for MG-style VO-synced
  // reveal. Renders N+1 variants (k=0 blank … k=N full); identical layout,
  // unspoken words at fill-opacity 0. Returns local_paths for video-compose
  // word_reveal mode; local_path/file_url point at the FULL-text frame.
  // Handled before the single-file cache check (multi-file cache).
  if (args.composition === 'text_card_reveal') {
    const words = String(args.text ?? '').trim().split(/\s+/).filter(Boolean);
    const paths: string[] = [];
    for (let k = 0; k <= words.length; k++) {
      const vp = path.join(IMG_DIR, `${hash}-w${String(k).padStart(2, '0')}.png`);
      const okCached = await fs.stat(vp).then(s => s.size > 0).catch(() => false);
      if (!okCached) {
        const vsvg = renderTextCardRevealVariant(args, width, height, k);
        await sharp(Buffer.from(vsvg)).png().toFile(vp);
      }
      paths.push(vp);
    }
    await fs.copyFile(paths[paths.length - 1], outPath).catch(() => {});
    return {
      file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('images/' + hash + '.png')}`,
      width, height,
      local_path: outPath,
      local_paths: paths,
    };
  }

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
