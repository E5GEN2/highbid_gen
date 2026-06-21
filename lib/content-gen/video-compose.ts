/**
 * video_compose — final ffmpeg assembly.
 *
 * Input (passed by the producer):
 *   - slot_order: string[] (slot_id in playback order)
 *   - bag[slot_id].__compose__ : { bg, hold_s, layers[] }
 *       layers[] entries: { from, channel, fit?, ken_burns?, url, duration_s }
 *   - width / height / fps / default_bg
 *   - job_id (for output filename)
 *
 * Output: { file_url, duration_s, width, height }
 *
 * Strategy (minimum viable v1 — silent video, image-only):
 *   1. For each slot, resolve the "main" video layer to a local file.
 *      - YT capture (/api/.../yt-capture/file?id=N) → fetch from disk
 *      - stub://image_gen/... → render a Sharp/SVG placeholder card
 *      - stub://* (audio) → skipped, audio added when real tools land
 *   2. Build a per-slot width×height clip (default 1920×1080 16:9 long-form
 *      per the MG-decoded spec — see worked-example-mg-reverse-engineered.md):
 *        ffmpeg -loop 1 -i {image} -t {hold_s} -vf "scale + pad to canvas"
 *               -c:v libx264 -pix_fmt yuv420p -r {fps}
 *      Background is filled via pad= color = bg_mode.
 *   3. Concat all clips with concat demuxer (zero-recode).
 *   4. (TODO when audio real) mix narr + sfx as a second pass.
 *
 * The producer passes `__bag__` through the runTool args; this module
 * reads it directly. We deliberately keep a hard dependency on bag-shape
 * (slot_id → gem_id → output) rather than re-resolving refs.
 */

import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { spawn } from 'child_process';
import sharp from 'sharp';
import { CLIPS_DIR } from '../clips-dir';
import { createHash } from 'node:crypto';
import type { BBox } from './yt-capture';

const COMPOSE_DIR = path.join(CLIPS_DIR, 'producer_renders');

interface ComposeLayer {
  from: string;
  channel?: 'video' | 'voice' | 'fx' | 'overlay';
  fit?: 'contain' | 'cover' | 'fill';
  ken_burns?: 'none' | 'zoom_in_8pct' | 'zoom_out_8pct' | 'pan_left' | 'pan_right' | 'scroll_down' | 'zoom_in_to_target' | 'pan_to_target' | 'word_reveal';
  /** Index of target avatar (0–9) for ken_burns='zoom_in_to_target'/'pan_to_target'
   *  on a 2×5 channel_logos_montage. Maps to grid cell (col, row) and zoompan center. */
  target_idx?: number;
  /** Previous avatar cell for ken_burns='pan_to_target' (-1 = first reveal).
   *  Same row → steady L→R pan from this cell to target; -1 or row-change →
   *  zoom-in ramp instead (MG: zoom only on first + row changes). */
  from_idx?: number;
  /** ken_burns='word_reveal': word start times (seconds RELATIVE TO SLOT
   *  START) from the master-narration alignment. Frame k of local_paths
   *  shows during [word_times[k-1], word_times[k]). */
  word_times?: number[];
  /** Progressive PNG set for word_reveal (k=0 blank … k=N full text). */
  local_paths?: string[] | null;
  /** MG mini-player: scale the video into a centered ROUNDED player area
   *  on the dark canvas instead of full-bleed (recipe_demo b-roll). */
  player_frame?: boolean;
  /** Channel-name watermark drawn over the mini-player (MG reference:
   *  large translucent name top-left + small bottom-center). */
  watermark_text?: string;
  /** Mix the clip's own audio at ~-15dB under narration. */
  diegetic?: boolean;
  /** Highlight a stats row in about_panel — MG-style L→R yellow animation.
   *  An ARRAY boxes multiple rows sequentially in spoken order (G2 dual-row:
   *  e.g. ['videos','subscribers'] for "just N videos … {subs} subscribers").*/
  highlight_row?: 'subscribers' | 'videos' | 'views' | Array<'subscribers' | 'videos' | 'views'>;
  url: string | null;
  duration_s: number | null;
  /** When the upstream tool returned an on-disk path, the producer surfaces
   *  it here so we can read from disk without a self-loop HTTP call. */
  local_path?: string | null;
  /** Crop the source image to one of the yt-capture's named bboxes before
   *  Ken Burns. Closes the gap between "full channel page" vs MG-style
   *  close-up of the about modal stats box. Supported values mirror
   *  bboxKeyFor() in yt-crop.ts:
   *    subscriber_count | video_count | total_views | joined_date
   *    channel_name | channel_avatar
   *    top_video_card | top_video_views | top_video_thumb | top_video_title
   *    video_card_N | video_thumb_N | video_views_N | video_title_N
   *  When set AND the source is a yt_capture image, video-compose looks up
   *  the bbox via captureId, crops + pads, then proceeds normally. */
  crop_target?: string;
  /** Capture id (content_gen_yt_screens.id) — surfaces from the producer when
   *  crop_target is set so video-compose can fetch bboxes_jsonb without
   *  re-parsing the file_url. */
  capture_id?: number | null;
}
interface ResolvedCompose {
  bg: 'white' | 'dark_gray';
  hold_s: number;
  layers: ComposeLayer[];
}

interface ComposeArgs {
  slot_order: string[];
  width: number;
  height: number;
  fps: number;
  default_bg?: 'white' | 'dark_gray';
  /** Music bed token from audio-sfx-class-b registry. When set, video_compose
   *  runs a final pass that mixes the bed under voice+sfx with ducking.
   *  Default 'bed' = soft lofi backdrop per the spec. Set to null/'none' to
   *  skip the music bed (e.g. for tests). */
  music_token?: string | null;
  __bag__: Record<string, Record<string, Record<string, unknown>>>;
  __job_id__: number;
}

// dark_gray re-measured 2026-06-12 on MG frames: canvas = 60,60,60.
const BG_HEX = { white: '#FFFFFF', dark_gray: '#3C3C3C' } as const;

/** XML-escape for SVG text content (watermark names can contain & etc). */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Spawn ffmpeg, capture stderr, throw on non-zero exit. */
function ff(args: string[], timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, timeoutMs);
    p.on('close', c => { clearTimeout(t); c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err.slice(0, 600)}`)); });
    p.on('error', e => { clearTimeout(t); reject(e); });
  });
}

/** Fetch a yt-capture file: the route returns a real local file path from
 *  content_gen_yt_screens. We side-load it via DB rather than HTTP — faster
 *  and avoids self-loops in the same process. */
async function resolveYtCaptureUrl(url: string): Promise<string | null> {
  const m = url.match(/yt-capture\/file\?id=(\d+)/);
  if (!m) return null;
  const id = parseInt(m[1], 10);
  const { getPool } = await import('../db');
  const pool = await getPool();
  const r = await pool.query<{ local_path: string }>(
    `SELECT local_path FROM content_gen_yt_screens WHERE id=$1`, [id],
  );
  return r.rows[0]?.local_path ?? null;
}

/** Render an image_gen STUB into a real local placeholder PNG. We pull the
 *  composition + text out of the stub URL so each card looks distinct on
 *  the rendered timeline. */
async function renderStubImage(url: string, width: number, height: number, bg: 'white' | 'dark_gray'): Promise<string> {
  // Format: stub://image_gen/{composition}/{encoded_text}?bg=white
  const m = url.match(/^stub:\/\/image_gen\/([^/]+)\/([^?]+)/);
  const composition = m?.[1] ?? 'text_card';
  const text = m ? decodeURIComponent(m[2]) : '';
  const tmpPath = path.join(os.tmpdir(), `prod-stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  const fg = bg === 'white' ? '#111111' : '#FFFFFF';
  const fontSize = Math.min(120, Math.max(48, Math.floor(width / Math.max(8, text.length / 2))));
  const safeText = text.replace(/[<>&]/g, '');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${BG_HEX[bg]}"/>
  <text x="${width / 2}" y="${height / 2}" font-family="system-ui, -apple-system, Roboto, sans-serif"
        font-size="${fontSize}" font-weight="800" fill="${fg}" text-anchor="middle" dominant-baseline="middle">${safeText}</text>
  <text x="${width / 2}" y="${height - 80}" font-family="system-ui, -apple-system, sans-serif"
        font-size="24" fill="${fg}" opacity="0.5" text-anchor="middle">${composition}</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(tmpPath);
  return tmpPath;
}

/** Pick which `video_card_N` indices back `count` rapid-fire slots, given a
 *  capture's bboxes + screenshot height. SINGLE SOURCE OF TRUTH shared by the
 *  builder (which reads each chosen card's view count for the spoken line) and
 *  the compositor (which crops that exact card) — so the spoken number ALWAYS
 *  matches the card on screen (rapid-fire mismatch, user report 2026-06-14).
 *
 *  Per slot: prefer the same-ordinal card, else the next-higher usable card,
 *  else a lower one — but never REUSE a card already taken by an earlier slot
 *  (a duplicate would show the same video twice under different spoken counts).
 *  `cardFits` mirrors the compositor: a bbox whose bottom falls below the real
 *  screenshot is MISSING (it squashes to a pill), not clampable. */
export function resolveVideoCardIndices(
  bboxes: Record<string, { x: number; y: number; w: number; h: number } | undefined>,
  imgH: number,
  count: number,
): number[] {
  const fits = (i: number): boolean => {
    const b = bboxes[`video_card_${i}`];
    return !!b && b.y + Math.min(b.h, 80) <= imgH;
  };
  const used = new Set<number>();
  const out: number[] = [];
  for (let slot = 0; slot < count; slot++) {
    let chosen = -1;
    if (!used.has(slot) && fits(slot)) chosen = slot;
    if (chosen < 0) for (let i = slot + 1; i < 24; i++) { if (!used.has(i) && fits(i)) { chosen = i; break; } }
    if (chosen < 0) for (let i = slot - 1; i >= 0; i--) { if (!used.has(i) && fits(i)) { chosen = i; break; } }
    if (chosen < 0) break;  // no more usable cards — emit fewer slots
    used.add(chosen);
    out.push(chosen);
  }
  return out;
}

/** Resolve any layer.url to a local file path. Returns null when the layer
 *  is a stub we don't know how to render (audio stubs for now). Handles
 *  crop_target — when set on a yt_capture layer, looks up the bbox by name
 *  and extracts a tight crop instead of using the full PNG. */
async function resolveLayerToLocalFile(layer: ComposeLayer, bg: 'white' | 'dark_gray', width: number, height: number): Promise<{ kind: 'image' | 'video' | 'skip'; path: string | null }> {
  // Resolve to base path first, then optionally crop.
  let basePath: string | null = null;
  let captureId: number | null = layer.capture_id ?? null;
  let kindHint: 'image' | 'video' = 'image';

  if (layer.local_path) {
    basePath = layer.local_path;
    kindHint = (basePath.endsWith('.webm') || basePath.endsWith('.mp4')) ? 'video' : 'image';
  } else if (layer.url) {
    const url = layer.url;
    if (url.startsWith('/api/admin/content-gen/yt-capture/file')) {
      // Pull captureId from the URL if not already in layer
      if (captureId == null) {
        const m = url.match(/[?&]id=(\d+)/);
        if (m) captureId = parseInt(m[1], 10);
      }
      basePath = await resolveYtCaptureUrl(url);
      kindHint = basePath?.endsWith('.webm') ? 'video' : 'image';
    } else if (url.startsWith('stub://image_gen/')) {
      basePath = await renderStubImage(url, width, height, bg);
      kindHint = 'image';
    }
  }
  if (!basePath) return { kind: 'skip', path: null };

  // Apply crop if requested AND we have a captureId (so we can look up bboxes).
  // Crop only applies to images — webm/mp4 inputs are pass-through.
  if (layer.crop_target && captureId != null && kindHint === 'image') {
    try {
      const { loadBBoxes, bboxKeyFor, cropToBBox, compositeBBox } = await import('./yt-crop');
      const bboxes = await loadBBoxes(captureId);

      // about_panel: use the MG-style composer (crops modal content + places
      // it on a clean rounded dark card centered on white canvas). Produces
      // a 1920×1080 PNG ready to be the video frame — bypasses fit:contain.
      //
      // If layer.highlight_row is set, dynamically PIXEL-SCAN the composed
      // PNG to find the text row positions, pick by index, and stash on
      // the layer. Bbox math from joined_date was unreliable (extractor
      // returned wrong views.y from the channel-page header behind the
      // dimmed modal). Scanning the actual rendered canvas is robust:
      // it can't be off-by-a-row regardless of source layout shifts.
      // Anchor priority: joined_date (preferred — bisects the stats column)
      // → total_views (fallback for channels like MrBeast whose modal has
      //   no Joined date row; synthesize an anchor ~150px above views to
      //   center the crop on the stats column).
      //
      // Observed 2026-06-10 on job 111: MrBeast about_page modal returned
      // only { total_views, channel_name } — no joined_date — because his
      // modal doesn't render a join date. Without this fallback, the
      // composer skipped, video-compose fell through to fit:contain, and
      // the user saw a zoomed-in slice of the raw modal description.
      const anchorBbox = bboxes.joined_date
        ?? (bboxes.total_views
              ? { x: bboxes.total_views.x, y: bboxes.total_views.y - 150,
                  w: bboxes.total_views.w, h: bboxes.total_views.h }
              : undefined);
      if (layer.crop_target === 'about_panel' && anchorBbox) {
        const { composeAboutPanelMG } = await import('./yt-compose-mg');
        const { path: composed, map: panelMap } = await composeAboutPanelMG(basePath, anchorBbox);

        if (layer.highlight_row) {
          // Row targeting, two tiers:
          //  1. PREFERRED — transform the extracted row bbox (subscriber_
          //     count / video_count / total_views, modal coords) through
          //     the composer's crop+fit math (aboutPanelRowCanvasPos).
          //     Index-based row picking assumed a fixed URL/country/
          //     joined/subs/videos/views stack; channels missing rows or
          //     carrying links shifted every index (niches 4/5/8, job 171).
          //  2. FALLBACK — the original index pixel-scan, used when the
          //     bbox is absent or its band contains no text.
          // Scan the COMPOSED PNG (1920×1080) for text rows in the modal area.
          // Narrow scan column (x=650-760) catches every row — wider columns
          // miss short rows like "28 videos". Threshold > 50 = white text on
          // dark bg. 8 ≤ rowH < 30 to reject icons / button outlines.
          const sharp = (await import('sharp')).default;
          const { data, info } = await sharp(composed).raw().toBuffer({ resolveWithObject: true });
          const rows: Array<{ top: number; h: number }> = [];
          let inRow = false, startY = 0;
          for (let y = 200; y < 900; y++) {
            let bright = 0;
            for (let x = 650; x < 760; x++) {
              const off = (y * info.width + x) * info.channels;
              bright += (data[off] + data[off + 1] + data[off + 2]) / 3;
            }
            bright /= 110;
            if (bright > 50 && !inRow) { startY = y; inRow = true; }
            else if (bright <= 50 && inRow) {
              const h = y - startY;
              if (h >= 8 && h < 30) rows.push({ top: startY, h });
              inRow = false;
            }
          }
          // Row targeting: the modal's stack BELOW Joined is invariant —
          // subscribers, videos, views, [Share]. Absolute indexing from
          // the crop top broke whenever rows above Joined varied (links,
          // no-country channels), and the stats-row BBOXES proved junk-
          // prone (matched the dimmed page behind the modal — jobs
          // 171/173). The joined bbox is the one reliable anchor: map it
          // through the composer's placement map, then take the Nth
          // scanned text row BELOW it.
          const joinedCanvasY = panelMap.offY + (anchorBbox.y - panelMap.cropY) * panelMap.scale;
          // Number-column left boundary: stat numbers are left-aligned with the
          // Joined-date text, so map joined.x through the placement map (−8px
          // slack for anti-aliasing). Scanning the marker extent from here skips
          // the row-ICON column to its left. Most icons fall under the brightness
          // gate, but the "views" trending-up arrow has a bright arrowhead the
          // old scan grabbed, lunging the bar left into the arrow (user 2026-06-21
          // #1, niche_1/niche_9 proof_2). Icons always sit left of this x.
          const numColX = Math.round(panelMap.offX + (anchorBbox.x - panelMap.cropX) * panelMap.scale) - 8;
          // Containment match, not a y-threshold: the bbox top maps a few
          // px ABOVE the row's bright pixels (ascender offset x scale), so
          // ">,+6" included the joined row itself and every bar landed one
          // row above its target (job 174, all 10 niches). Find the
          // scanned row CONTAINING the joined center, slice after it.
          const joinedCenter = joinedCanvasY + (anchorBbox.h * panelMap.scale) / 2;
          const jIdx = rows.findIndex(rr => joinedCenter >= rr.top - 4 && joinedCenter <= rr.top + rr.h + 6);
          const below = jIdx >= 0 ? rows.slice(jIdx + 1) : rows.filter(rr => rr.top > joinedCenter);
          // G2 dual-row: highlight_row may be a single row OR an array
          // (box two stats in spoken order, e.g. ['videos','subscribers']
          // for "just N videos … {subs} subscribers"). Resolve EACH row
          // independently — own containment index + own horizontal text
          // scan — so a second row can never inherit the first row's
          // off-by-one or text extent. Bake ALL bands into ONE progressive
          // frame set, swept sequentially; never a second word_reveal layer
          // (separate overlays re-introduced the old alpha-stack flicker).
          const targets = (Array.isArray(layer.highlight_row) ? layer.highlight_row : [layer.highlight_row])
            .filter((t): t is 'subscribers' | 'videos' | 'views' => !!t);

          type Band = { X: number; Y: number; W: number; H: number };
          // Resolve one stat row to a baked-marker rectangle, or null if its
          // text can't be found (junk bbox / absent row → skip that band,
          // never abort the whole bake).
          const resolveBand = (target: 'subscribers' | 'videos' | 'views'): Band | null => {
            const belowIdx = target === 'subscribers' ? 0 : target === 'videos' ? 1 : 2;
            // Legacy absolute index, used only as a desperation fallback.
            const rowIdx   = target === 'subscribers' ? 3 : target === 'videos' ? 4 : 5;
            let r: { top: number; h: number } | undefined = below[belowIdx] ?? rows[rowIdx];
            if (!r) return null;
            // Scan the row band HORIZONTALLY for the text's actual extent.
            // A hardcoded TEXT_X (625, measured 2026-06-10) broke whenever
            // the composer geometry changed (2026-06-12: the tightened
            // about-panel crop rescaled content and the highlight started
            // past the "1" of "107K subscribers" — user report). Scanning
            // the rendered pixels survives geometry changes and sizes the
            // bar to the row's real width instead of a worst-case 300px.
            //
            // Two-step: (1) find the CARD's horizontal bounds on a quiet
            // line just above the row — the card is near-black (<50) while
            // the canvas is white 253 or gray 60, so the contiguous dark
            // run containing the frame center IS the card. Scanning the
            // raw band without this read the white canvas as "text" and
            // stretched the bar across the whole card.
            const quietY = Math.max(0, r.top - 12);
            const darkAt = (x: number) => {
              const off = (quietY * info.width + x) * info.channels;
              return (data[off] + data[off + 1] + data[off + 2]) / 3 < 50;
            };
            let cardX0 = Math.floor(info.width / 2), cardX1 = cardX0;
            while (cardX0 > 0 && darkAt(cardX0 - 1)) cardX0--;
            while (cardX1 < info.width - 1 && darkAt(cardX1 + 1)) cardX1++;
            // (2) text extent inside the card (white text on near-black).
            // Scan from the number column (numColX) rightward so a leading
            // row-icon is never part of the bar (fixes the "views" ↗ arrow,
            // #1). Gate at 90 (was 110) so a sparse leading glyph like the
            // lone "7" in "7 videos" registers — at 110 its column average
            // fell under the gate and the bar skipped the digit (user
            // 2026-06-21 #4). Verified via standalone bake on niche_1 (↗
            // arrow), niche_8 ("7 videos"), and a no-icon modal.
            const scanX = (band: { top: number; h: number }) => {
              const x0bound = Math.max(cardX0 + 12, numColX);
              let sx0 = -1, sx1 = -1;
              for (let x = x0bound; x < cardX1 - 12; x++) {
                let bright = 0;
                for (let y = band.top; y < band.top + band.h; y++) {
                  const off = (y * info.width + x) * info.channels;
                  bright += (data[off] + data[off + 1] + data[off + 2]) / 3;
                }
                bright /= Math.max(1, band.h);
                if (bright > 90) { if (sx0 < 0) sx0 = x; sx1 = x; }
              }
              return [sx0, sx1] as const;
            };
            let [x0, x1] = scanX(r);
            // Empty band = the bbox was junk (behind-the-modal element):
            // retry with the index-scan row before giving up.
            if (x0 < 0 && rows[rowIdx] && (rows[rowIdx].top !== r.top)) {
              r = rows[rowIdx];
              [x0, x1] = scanX(r);
            }
            if (x0 < 0) return null;
            const PAD = 6;
            // -10/+18 (were -6/+14): the leading digit's anti-aliased
            // left edge poked out of the bar on one row (job 178).
            return { X: x0 - 10, Y: Math.max(0, r.top - PAD), W: (x1 - x0) + 18, H: r.h + 2 * PAD };
          };

          const bands = targets.map(resolveBand).filter((b): b is Band => !!b);
          if (bands.length > 0) {
            // BAKE the highlight(s) into progressive stills (MG treatment,
            // verified on the OG niche_8 proof beat 2026-06-12): an OPAQUE
            // #E7F61A marker bar that hugs the text, with the covered text
            // flipped to DARK; the bar sweeps L->R over ~0.6s. The old
            // drawbox yellow@0.45 approach tinted the white text olive
            // (off-reference) and its 18 between() segments double-drew at
            // boundaries, stacking alpha into a visible flicker (user
            // report). Baking frames + the word_reveal concat path has
            // neither problem.
            const K = 13, RAMP_S = 0.6;
            // Inter-sweep gap: an already-boxed row HOLDS while we wait for
            // the next number to be spoken, then the next row sweeps. Synthetic
            // timing (like the single-row ramp) — the slot is short enough that
            // the concat path clamps to hold_s if narration runs tight.
            const GAP_S = 1.2;
            const MARKER = { r: 231, g: 246, b: 26 };   // sampled from the OG bar
            const DARK = 30;                             // covered-text tone
            // Fill one band's marker rect up to width wk into buf (soft-mix
            // keeps glyph anti-aliasing: dark strokes, yellow ground, blended edges).
            const fillBand = (buf: Buffer, b: Band, wk: number) => {
              const wEff = Math.min(b.W, Math.max(0, wk));
              for (let y = b.Y; y < Math.min(info.height, b.Y + b.H); y++) {
                for (let x = b.X; x < Math.min(info.width, b.X + wEff); x++) {
                  const off = (y * info.width + x) * info.channels;
                  const bright = (buf[off] + buf[off + 1] + buf[off + 2]) / 3;
                  const a = Math.max(0, Math.min(1, (bright - 60) / 120));
                  buf[off]     = Math.round(MARKER.r * (1 - a) + DARK * a);
                  buf[off + 1] = Math.round(MARKER.g * (1 - a) + DARK * a);
                  buf[off + 2] = Math.round(MARKER.b * (1 - a) + DARK * a);
                }
              }
            };
            const variants: string[] = [composed];
            const wordTimes: number[] = [];
            let phaseStart = 0;
            for (let bi = 0; bi < bands.length; bi++) {
              for (let k = 1; k <= K; k++) {
                const buf = Buffer.from(data);
                // Earlier bands stay FULLY boxed, the current band sweeps,
                // later bands are still empty — all baked into this one frame.
                for (let pj = 0; pj < bands.length; pj++) {
                  const wk = pj < bi ? bands[pj].W
                    : pj > bi ? 0
                    : Math.max(2, Math.round(bands[pj].W * k / K));
                  if (wk > 0) fillBand(buf, bands[pj], wk);
                }
                const vPath = path.join(os.tmpdir(), `mg-hl-${Date.now()}-${Math.random().toString(36).slice(2, 12)}-b${bi}k${k}.png`);
                await sharp(buf, { raw: { width: info.width, height: info.height, channels: info.channels as 3 | 4 } })
                  .png().toFile(vPath);
                variants.push(vPath);
                wordTimes.push(phaseStart + k * RAMP_S / K);
              }
              phaseStart += RAMP_S + GAP_S;   // hold this band through the gap, then sweep the next
            }
            layer.local_paths = variants;     // length = bands.length*K + 1
            layer.word_times = wordTimes;     // length = bands.length*K = variants.length - 1 (concat invariant)
            layer.ken_burns = 'word_reveal';
          }
        }

        return { kind: 'image', path: composed };
      }

      // channel_chip: MG-style channel identity card. Crops the chip area
      // (avatar + name + handle/subs/videos + description + Subscribe) from
      // a channel_page screenshot and places it inside a rounded dark card
      // on a white outer canvas. Anchored on subscriber_count bbox.
      if (layer.crop_target === 'channel_chip' && bboxes.subscriber_count) {
        const { composeChannelChipMG } = await import('./yt-compose-mg');
        const composed = await composeChannelChipMG(basePath, bboxes.subscriber_count,
          { canvas: bg, subscribeBtn: bboxes.subscribe_btn, channelName: bboxes.channel_name, tabsRow: bboxes.tabs_row, tabsHome: bboxes.tabs_home, gridTop: bboxes.video_card_0, tabsStrip: bboxes.tabs_strip });
        return { kind: 'image', path: composed };
      }

      // channel_page_full: MG-style full channel page (banner + chip + tabs
      // + grid). Crops YT sidebar away and places the page content in a
      // rounded dark card on the slot's canvas (white or the measured
      // 60,60,60 dark — both attested in the reference).
      if (layer.crop_target === 'channel_page_full') {
        const { composeChannelPageFullMG } = await import('./yt-compose-mg');
        const composed = await composeChannelPageFullMG(basePath, { canvas: bg });
        return { kind: 'image', path: composed };
      }

      // Card-bbox resolver with FALLBACK: the requested index, else the
      // lowest available card. Job 171 (niche_8 rapid_2): a missing
      // video_card_2 bbox silently fell through to the RAW screenshot —
      // full desktop page with masthead+sidebar in the final video. A
      // wrong-index card beats a raw page; raw is never acceptable.
      let cardImgH = Infinity;
      try {
        const sharpMeta = (await import('sharp')).default;
        cardImgH = (await sharpMeta(basePath).metadata()).height ?? Infinity;
      } catch { /* keep Infinity */ }
      const cardFits = (b: BBox | undefined): b is BBox =>
        !!b && b.y + Math.min(b.h, 80) <= cardImgH;  // bbox below the actual
        // screenshot bottom produced a squashed 40px pill card (job 173,
        // niche_1 payoff) — out-of-image bboxes are MISSING, not clampable.
      const pickCardBbox = (idx: number): { bbox: BBox; i: number } | undefined => {
        const exact = (bboxes as Record<string, BBox | undefined>)[`video_card_${idx}`];
        if (cardFits(exact)) return { bbox: exact, i: idx };
        // Prefer HIGHER indices first: falling back to card_0 duplicated
        // rapid_0's card under "And another." narration (job 173 niche_8).
        for (let i = idx + 1; i < 12; i++) {
          const b = (bboxes as Record<string, BBox | undefined>)[`video_card_${i}`];
          if (cardFits(b)) { console.warn(`[video-compose] video_card_${idx} unusable — falling back to video_card_${i}`); return { bbox: b, i }; }
        }
        for (let i = idx - 1; i >= 0; i--) {
          const b = (bboxes as Record<string, BBox | undefined>)[`video_card_${i}`];
          if (cardFits(b)) { console.warn(`[video-compose] video_card_${idx} unusable — falling back to video_card_${i}`); return { bbox: b, i }; }
        }
        return undefined;
      };
      // Some layouts' card bbox stops at the title — union in the views
      // bbox so the meta line ("2.1M views · ...") is inside the crop
      // (job 174: niche_1 payoff card had no views line to back the
      // narration claim).
      const withMetaLine = (pick: { bbox: BBox; i: number }): BBox => {
        const viewsB = (bboxes as Record<string, BBox | undefined>)[`video_views_${pick.i}`];
        if (viewsB && viewsB.y + viewsB.h > pick.bbox.y + pick.bbox.h) {
          return { ...pick.bbox, h: (viewsB.y + viewsB.h + 10) - pick.bbox.y };
        }
        return pick.bbox;
      };

      // top_video_card:N — the channel_b payoff card: ONE video card at
      // ~34% frame width on the slot canvas (MG niche_4 "1.3m views" lone
      // card). Same composer as rapid-fire, smaller card.
      if (typeof layer.crop_target === 'string' && layer.crop_target.startsWith('top_video_card:')) {
        const idx = parseInt(layer.crop_target.split(':')[1] ?? '0', 10);
        const pick = pickCardBbox(idx);
        if (pick) {
          const { composeThumbnailRapidFireMG } = await import('./yt-compose-mg');
          const composed = await composeThumbnailRapidFireMG(basePath, withMetaLine(pick), { canvas: bg, cardW: 660 });
          return { kind: 'image', path: composed };
        }
        const { composeChannelPageFullMG } = await import('./yt-compose-mg');
        return { kind: 'image', path: await composeChannelPageFullMG(basePath, { canvas: bg }) };
      }

      // videos_wall — header-less videos grid as a wide rounded card
      // (saturation Form B consistency wall; top row clips mid-thumbnail).
      if (layer.crop_target === 'videos_wall') {
        const wallBboxes: BBox[] = [];
        for (let i = 0; i < 12; i++) {
          const b = bboxes[`video_card_${i}`];
          if (b) wallBboxes.push(b);
        }
        if (wallBboxes.length >= 4) {
          const { composeGridWallMG } = await import('./yt-compose-mg');
          const composed = await composeGridWallMG(basePath, wallBboxes, { canvas: bg });
          return { kind: 'image', path: composed };
        }
      }

      // thumbnail_rapid_fire:N — MG-style single video card on dark
      // canvas (thumbnail + title + meta), used for BEAT 7 top-views
      // rapid-fire sequence. Anchored on video_card_N bbox of a
      // videos_tab capture. Per-niche flow emits 3 slots back-to-back
      // (idx 0,1,2 → top 3 videos by view count).
      if (typeof layer.crop_target === 'string' && layer.crop_target.startsWith('thumbnail_rapid_fire:')) {
        const idx = parseInt(layer.crop_target.split(':')[1] ?? '0', 10);
        const pick = pickCardBbox(idx);
        // EXACT-card only (user 2026-06-21 #3): the builder spoke
        // titles_texts[idx] for this slot, so showing ANY other card —
        // higher OR lower index — names one video while displaying another.
        // pickCardBbox returns i===idx only when the resolved card still
        // fits; any fallback (i!==idx) means the capture drifted out from
        // under the build, so fall back to the honest full page rather than
        // a mismatched card.
        if (pick && pick.i === idx) {
          const { composeThumbnailRapidFireMG } = await import('./yt-compose-mg');
          const composed = await composeThumbnailRapidFireMG(basePath, withMetaLine(pick));
          return { kind: 'image', path: composed };
        }
        const { composeChannelPageFullMG } = await import('./yt-compose-mg');
        return { kind: 'image', path: await composeChannelPageFullMG(basePath, { canvas: bg }) };
      }

      // videos_grid: MG-style 4×2 grid composer. Pulls the first 8
      // video_card_N bboxes, crops the grid + composites onto a near-
      // black rounded card on a dark-gray outer canvas (MG t182 style).
      if (layer.crop_target === 'videos_grid') {
        const cardBboxes: BBox[] = [];
        for (let i = 0; i < 8; i++) {
          const b = bboxes[`video_card_${i}`];
          if (b) cardBboxes.push(b);
        }
        if (cardBboxes.length >= 4) {
          const { composeTopVideosPanoMG } = await import('./yt-compose-mg');
          const composed = await composeTopVideosPanoMG(basePath, cardBboxes);
          return { kind: 'image', path: composed };
        }
      }

      // Try composite target first (videos_grid, etc.), then single-bbox key.
      const compositeBox = compositeBBox(layer.crop_target, bboxes);
      if (compositeBox) {
        // Composite crops use less padding — they're already padded internally.
        const cropped = await cropToBBox(basePath, compositeBox, { pad: 16 });
        return { kind: 'image', path: cropped };
      }
      const key = bboxKeyFor(layer.crop_target);
      if (key && bboxes[key]) {
        const cropped = await cropToBBox(basePath, bboxes[key], { pad: 32 });
        return { kind: 'image', path: cropped };
      }
      console.warn(`[video-compose] crop_target="${layer.crop_target}" not in bboxes for capture=${captureId} (keys: ${Object.keys(bboxes).slice(0, 5).join(',')}…)`);
    } catch (e) {
      console.warn(`[video-compose] crop failed: ${(e as Error).message}`);
    }
  }

  return { kind: kindHint, path: basePath };
}

/** Build a single width×height clip for one slot (default 1920×1080 16:9),
 *  with optional narration
 *  audio mixed in. */
async function buildSlotClip(slot_id: string, compose: ResolvedCompose, width: number, height: number, fps: number, outPath: string): Promise<void> {
  // Find the "video" channel layer — that's the main visual.
  const mainLayer = compose.layers.find(l => l.channel === 'video') ?? compose.layers[0];
  if (!mainLayer) throw new Error(`slot ${slot_id}: no video layer`);
  const bg = compose.bg;
  const hold_s = Math.max(0.3, compose.hold_s);

  const resolved = await resolveLayerToLocalFile(mainLayer, bg, width, height);
  if (!resolved.path) {
    const tmp = await renderStubImage(`stub://image_gen/missing/${encodeURIComponent(slot_id)}`, width, height, bg);
    resolved.kind = 'image';
    resolved.path = tmp;
  }

  // Voice + FX layers. We prefer local_path (real on-disk mp3) over file_url
  // so ffmpeg reads directly without an HTTP self-loop. SFX is mixed underneath
  // voice (no ducking yet — SFX are short transients so collision is rare).
  const voiceLayer = compose.layers.find(l => l.channel === 'voice');
  const voicePath = voiceLayer?.local_path ?? null;
  const fxLayer = compose.layers.find(l => l.channel === 'fx');
  const fxPath = fxLayer?.local_path ?? null;

  const padColor = BG_HEX[bg].replace('#', '0x');
  const totalFrames = Math.max(2, Math.round(hold_s * fps));
  const kenBurns = mainLayer.ken_burns ?? 'zoom_in_8pct';

  // scroll_down: source PNG is 1920×N (N > height). Pan the visible window
  // vertically from y=0 to y=(ih-height) over the slot duration. No zoom
  // — this is a pure scroll. Width is preserved at 1920.
  // Pad to at least the frame height BEFORE the sliding crop: a short
  // grid (channel with few videos) scales to ih < height and crop=W:H
  // then dies with "Invalid too big or non positive size" — killed the
  // first 10-channel render's final compose (job 170). With ih == height
  // the crop's y expression degenerates to 0 (static hold).
  const scrollDownVf =
    `scale=${width}:-2:flags=lanczos,` +
    `pad=${width}:'max(ih,${height})':(ow-iw)/2:0:color=${padColor},` +
    `crop=${width}:${height}:0:'min(ih-${height}, n/${Math.max(1, totalFrames - 1)}*(ih-${height}))',` +
    `setsar=1,fps=${fps}`;

  // zoom_in_to_target: zoompan from zoom=1 → 3 centered on target avatar
  // (cx,cy) in a 1920×1080 logos montage. mainLayer.target_idx (0–9) maps
  // to the 2×5 grid: cell_w=384 cell_h=540, center = (col*384+192, row*540+270).
  // Used by channel_logos_montage slots — MG's "Number N" niche reveal.
  let zoomToTargetVf: string | null = null;
  if (kenBurns === 'zoom_in_to_target' && typeof mainLayer.target_idx === 'number') {
    const idx = mainLayer.target_idx;
    const col = idx % 5;
    const row = Math.floor(idx / 5);
    // ANTI-JITTER: zoompan rounds the crop window x/y to whole INPUT pixels
    // per frame and samples without interpolation — at zoom 3 on a native-res
    // input that's up to ~3px of visible frame shake + edge shimmer (user
    // report 2026-06-11). Upsampling 4× with lanczos BEFORE zoompan makes
    // the rounding ¼-output-pixel and the sampling clean. Target center
    // coords scale by the same factor.
    const SS = 4; // supersample factor
    const cx = (col * 384 + 192) * SS;
    const cy = (row * 540 + 270) * SS;
    // zoompan x/y are in (upsampled) SOURCE coords: top-left of the visible
    // window. To center visible (iw/zoom × ih/zoom) on (cx,cy):
    //   x = cx - iw/(2*zoom),  y = cy - ih/(2*zoom)
    zoomToTargetVf =
      `scale=${width * SS}:${height * SS}:flags=lanczos,` +
      `zoompan=z='1+2*on/${Math.max(1, totalFrames - 1)}'` +
      `:x='${cx}-iw/(2*zoom)':y='${cy}-ih/(2*zoom)'` +
      `:d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
  }

  // pan_to_target (MG niche-reveal camera, user 2026-06-14 #15): icons are
  // placed in niche order; the camera pans STEADILY left→right at a constant
  // close zoom from the previous cell to this niche's cell, and only ZOOMS in
  // on the first reveal (from_idx=-1) and at a row change (different grid row)
  // — exactly MG's motion. Additive: leaves zoom_in_to_target untouched.
  if (kenBurns === 'pan_to_target' && typeof mainLayer.target_idx === 'number') {
    const SS = 4;            // same anti-jitter supersample as zoom_in_to_target
    const closeZ = 3;        // matches the established close-up zoom level
    const N = Math.max(1, totalFrames - 1);
    const cell = (i: number) => ({ cx: ((i % 5) * 384 + 192) * SS, cy: (Math.floor(i / 5) * 540 + 270) * SS });
    const tIdx = mainLayer.target_idx;
    const fIdx = typeof mainLayer.from_idx === 'number' ? mainLayer.from_idx : -1;
    const T = cell(tIdx);
    const sameRow = fIdx >= 0 && Math.floor(fIdx / 5) === Math.floor(tIdx / 5);
    const pre = `scale=${width * SS}:${height * SS}:flags=lanczos,`;
    const tail = `:d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
    if (sameRow) {
      // steady horizontal pan at constant zoom: prev cell → target cell
      const F = cell(fIdx);
      const cxE = `(${F.cx}+(${T.cx - F.cx})*on/${N})`;
      const cyE = `(${F.cy}+(${T.cy - F.cy})*on/${N})`;
      zoomToTargetVf = pre + `zoompan=z='${closeZ}':x='${cxE}-iw/(2*zoom)':y='${cyE}-ih/(2*zoom)'` + tail;
    } else {
      // first reveal OR row change → zoom-in ramp 1→closeZ centered on target
      zoomToTargetVf = pre + `zoompan=z='1+${closeZ - 1}*on/${N}':x='${T.cx}-iw/(2*zoom)':y='${T.cy}-ih/(2*zoom)'` + tail;
    }
  }

  // zoom_out_8pct: start tight (1.08), settle to full frame — the MG
  // thumbnail-grid reveal (decode i=233-234 "continues to zoom out").
  // Same 4x supersample anti-jitter treatment as the zoom-in.
  const zoomOutVf = `scale=${width * 4}:-2:flags=lanczos,` +
                  `zoompan=z='1.08-0.08*on/${totalFrames}':d=${totalFrames}:s=${width}x${height}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',` +
                  `scale=w=${width}:h=-2:force_original_aspect_ratio=decrease,` +
                  `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1,fps=${fps}`;

  // Default Ken Burns: subtle 8% zoom-in on the centered image.
  // 4× supersample before zoompan (was 2×) — same anti-jitter rationale as
  // zoom_in_to_target above: integer crop-window rounding at low supersample
  // shows as sub-pixel stepping on slow zooms.
  const stillVfDefault = `scale=${width * 4}:-2:flags=lanczos,` +
                  `zoompan=z='1+0.08*on/${totalFrames}':d=${totalFrames}:s=${width}x${height}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',` +
                  `scale=w=${width}:h=-2:force_original_aspect_ratio=decrease,` +
                  `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1,fps=${fps}`;

  // Static fit+pad, no zoompan — used by ken_burns:'none' slots and the
  // word_reveal concat path (incl. baked about-panel highlights: MG's
  // highlight beats play on a static panel; the L->R marker sweep baked
  // into the stills carries all the motion).
  const staticStillVf =
    `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1,fps=${fps}`;

  const stillVf =
    kenBurns === 'scroll_down' ? scrollDownVf
    : kenBurns === 'zoom_out_8pct' ? zoomOutVf
    : kenBurns === 'none' ? staticStillVf
    : (zoomToTargetVf ?? stillVfDefault);
  const videoVf = `scale=w='if(gt(a,${width}/${height}),${width},-2)':h='if(gt(a,${width}/${height}),-2,${height})':force_original_aspect_ratio=decrease,` +
                  `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1,fps=${fps}`;

  // Build the visual track first as a silent intermediate; then mux audio
  // in a second pass. Keeps the filtergraph simple and lets us pad audio
  // with silence to match hold_s exactly.
  const silentPath = path.join(path.dirname(outPath), `silent-${path.basename(outPath)}`);
  // word_reveal — MG-style VO-synced text pop: progressive stills (k=0
  // blank … k=N full) concatenated with per-word durations from the
  // master-narration alignment. Frame k holds from word_times[k-1] to
  // word_times[k] (relative to slot start); the final frame holds to
  // hold_s. Uses the concat demuxer (exact durations), then fit+pad.
  const wordTimes = mainLayer.word_times;
  const revealPaths = mainLayer.local_paths;
  if (kenBurns === 'word_reveal' && Array.isArray(revealPaths) && revealPaths.length >= 2 &&
      Array.isArray(wordTimes) && wordTimes.length === revealPaths.length - 1) {
    const minD = 1 / fps;
    // Boundaries: frame k ∈ [0..N] shows [b_k, b_{k+1}) where
    // b_0=0, b_k=wordTimes[k-1] (clamped monotonic), b_{N+1}=hold_s.
    const bounds: number[] = [0];
    for (const t of wordTimes) bounds.push(Math.min(Math.max(t, bounds[bounds.length - 1] + minD), hold_s));
    bounds.push(Math.max(hold_s, bounds[bounds.length - 1] + minD));
    const concatLines: string[] = [];
    for (let k = 0; k < revealPaths.length; k++) {
      const d = Math.max(minD, bounds[k + 1] - bounds[k]);
      concatLines.push(`file '${revealPaths[k].replace(/'/g, "'\\''")}'`);
      concatLines.push(`duration ${d.toFixed(4)}`);
    }
    // concat demuxer quirk: repeat the last file so its final duration sticks.
    concatLines.push(`file '${revealPaths[revealPaths.length - 1].replace(/'/g, "'\\''")}'`);
    const listPath = path.join(path.dirname(outPath), `reveal-${path.basename(outPath)}.txt`);
    await fs.writeFile(listPath, concatLines.join('\n'));
    await ff([
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-t', hold_s.toFixed(3),
      '-vf', staticStillVf,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-preset', 'medium', '-crf', '20',
      silentPath,
    ]);
  } else if (resolved.kind === 'image') {
    await ff([
      '-y', '-loop', '1', '-i', resolved.path,
      '-t', hold_s.toFixed(3),
      '-vf', stillVf,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-preset', 'medium', '-crf', '20',
      silentPath,
    ]);
  } else if (mainLayer.player_frame) {
    // MG mini-player (matched to the reference frame 2026-06-11): clip
    // cover-filled into a ROUNDED-corner player at ~58% width centered on
    // the dark canvas, channel-name watermark large-translucent top-left +
    // small bottom-center. Rounding via a Sharp-generated alpha mask
    // (alphamerge); watermark via a Sharp-generated transparent overlay —
    // no drawtext (font paths differ between mac dev and Railway).
    const PW = 1114, PH = 626, R = 30;
    // Canvas behind the mini-player: the MG reference frame uses a clearly
    // LIGHTER charcoal than the global #2A2A2A — without it, any dark clip
    // content bleeds into the canvas and the composition stops reading
    // (user reports 2026-06-11 x2). Sampled from the reference: ~#4A4A4D.
    const PLAYER_CANVAS = '0x4A4A4D';
    const PX = Math.round((width - PW) / 2), PY = Math.round((height - PH) / 2);
    const maskPath = path.join(path.dirname(outPath), `pmask-${path.basename(outPath)}.png`);
    const wmPath = path.join(path.dirname(outPath), `pwm-${path.basename(outPath)}.png`);
    await sharp(Buffer.from(
      `<svg width="${PW}" height="${PH}"><rect width="${PW}" height="${PH}" rx="${R}" fill="#FFFFFF"/></svg>`,
    )).png().toFile(maskPath);
    const wmName = esc(String(mainLayer.watermark_text ?? '').toUpperCase());
    // Hairline border keeps the player edge readable even when the clip's
    // own background is near-black and merges with the canvas (user report
    // 2026-06-11 — frame "disappeared" on dark-bg source videos).
    await sharp(Buffer.from(
      `<svg width="${PW}" height="${PH}">
        <rect x="1.5" y="1.5" width="${PW - 3}" height="${PH - 3}" rx="${R - 1}"
              fill="none" stroke="#FFFFFF" stroke-opacity="0.22" stroke-width="3"/>
        <text x="34" y="56" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="600"
              fill="#FFFFFF" fill-opacity="0.55" letter-spacing="3">${wmName}</text>
        <text x="${PW / 2}" y="${PH - 22}" font-family="Helvetica, Arial, sans-serif" font-size="17" font-weight="500"
              fill="#FFFFFF" fill-opacity="0.5" letter-spacing="2" text-anchor="middle">${wmName}</text>
      </svg>`,
    )).png().toFile(wmPath);
    await ff([
      '-y',
      '-stream_loop', '-1', '-i', resolved.path,
      '-i', maskPath, '-i', wmPath,
      '-filter_complex',
        `color=c=${PLAYER_CANVAS}:s=${width}x${height}:r=${fps}[bg];` +
        `[0:v]scale=${PW}:${PH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${PW}:${PH},` +
        `unsharp=5:5:0.4:5:5:0.0,setsar=1,format=rgba[clip];` +
        `[clip][1:v]alphamerge[rounded];` +
        `[bg][rounded]overlay=${PX}:${PY}:shortest=0[withclip];` +
        `[withclip][2:v]overlay=${PX}:${PY}[vout]`,
      '-map', '[vout]',
      '-t', hold_s.toFixed(3),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-an',
      '-preset', 'medium', '-crf', '20',
      silentPath,
    ]);
    await fs.unlink(maskPath).catch(() => {});
    await fs.unlink(wmPath).catch(() => {});
  } else {
    await ff([
      '-y', '-stream_loop', '-1', '-i', resolved.path,
      '-t', hold_s.toFixed(3),
      '-vf', videoVf,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-an',
      '-preset', 'medium', '-crf', '20',
      silentPath,
    ]);
  }

  // ── TECHNICAL MODE (HB_DEBUG_LABELS=1, render.mts --labels) ──
  // Stamp the slot_id in a pill at the top-right of every slot so frames
  // are referencable in review ("beat niche_1_mm_rpm, issue X"). Env-gated:
  // never active in production renders; video_compose is uncached so no
  // cache poisoning.
  if (process.env.HB_DEBUG_LABELS === '1') {
    const labelText = esc(slot_id);
    const fontSize = 26;
    const padX = 18, padY = 12;
    const labelW = Math.round(labelText.length * fontSize * 0.62) + padX * 2;
    const labelH = fontSize + padY * 2;
    const labelPath = path.join(path.dirname(outPath), `label-${path.basename(outPath)}.png`);
    await sharp(Buffer.from(
      `<svg width="${labelW}" height="${labelH}">
        <rect width="${labelW}" height="${labelH}" rx="9" fill="#000000" fill-opacity="0.62"/>
        <text x="${padX}" y="${padY + fontSize - 7}" font-family="Menlo, 'DejaVu Sans Mono', monospace"
              font-size="${fontSize}" font-weight="600" fill="#7CFC9B">${labelText}</text>
      </svg>`,
    )).png().toFile(labelPath);
    const labeledPath = path.join(path.dirname(outPath), `labeled-${path.basename(outPath)}`);
    await ff([
      '-y', '-i', silentPath, '-i', labelPath,
      '-filter_complex', `[0:v][1:v]overlay=W-w-24:24`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
      labeledPath,
    ]);
    await fs.rename(labeledPath, silentPath);
    await fs.unlink(labelPath).catch(() => {});
  }

  // Mux audio — generic N-input mixer. Inputs and weights:
  //   voice 1.0 · fx 0.7 · diegetic clip audio 0.18 (≈ -15dB under
  //   narration per the audio-sfx diegetic rule). No inputs → silent
  //   AAC stream so all slots concat with consistent audio.
  const audioInputs: Array<{ p: string; vol: number; loop?: boolean }> = [];
  if (voicePath) audioInputs.push({ p: voicePath, vol: 1.0 });
  if (fxPath) audioInputs.push({ p: fxPath, vol: 0.7 });
  if (mainLayer.diegetic && resolved.kind === 'video' && resolved.path) {
    // LOOPED — the clip visual loops via -stream_loop, so its audio must
    // too (otherwise a 4s clip leaves 6s of dead air in a 10s slot);
    // per-input atrim below caps the loop at hold_s.
    audioInputs.push({ p: resolved.path, vol: 0.18, loop: true });
  }
  if (audioInputs.length === 0) {
    await ff([
      '-y', '-i', silentPath,
      '-f', 'lavfi', '-t', hold_s.toFixed(3), '-i', 'anullsrc=cl=stereo:r=44100',
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest',
      outPath,
    ]);
  } else {
    const inputArgs = audioInputs.flatMap(a => a.loop ? ['-stream_loop', '-1', '-i', a.p] : ['-i', a.p]);
    const fmt = audioInputs.map((a, i) =>
      `[${i + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${a.vol}` +
      (a.loop ? `,atrim=0:${hold_s.toFixed(3)}` : '') + `[a${i}]`).join(';');
    const mix = audioInputs.length === 1
      ? `[a0]apad=pad_dur=${hold_s.toFixed(3)},atrim=0:${hold_s.toFixed(3)}[aout]`
      : `${audioInputs.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audioInputs.length}:duration=longest:dropout_transition=0:normalize=0,` +
        `apad=pad_dur=${hold_s.toFixed(3)},atrim=0:${hold_s.toFixed(3)}[aout]`;
    await ff([
      '-y', '-i', silentPath, ...inputArgs,
      '-filter_complex', `${fmt};${mix}`,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest',
      outPath,
    ]);
  }
  // Cleanup intermediate
  try { await fs.unlink(silentPath); } catch { /* ignore */ }
}

/** Top-level entry called by producer-tools.runVideoCompose. */
export async function videoCompose(args: ComposeArgs): Promise<{ file_url: string; duration_s: number; width: number; height: number; local_path: string }> {
  await fs.mkdir(COMPOSE_DIR, { recursive: true });
  const { slot_order, width, height, fps, __bag__: bag, __job_id__: jobId } = args;
  if (!slot_order || slot_order.length === 0) throw new Error('videoCompose: empty slot_order');

  // Tool_call emission — visible in the Execution drawer so users can see
  // ffmpeg's three stages (build slots → concat → music mix) instead of
  // a single 30s-90s black box. No-op when called outside a producer.
  const { emitToolCall, withToolCall } = await import('./exec-context');
  await emitToolCall('compose:start', { slot_count: slot_order.length, width, height, fps });

  const stageDir = path.join(os.tmpdir(), `producer-${jobId}-${Date.now()}`);
  await fs.mkdir(stageDir, { recursive: true });

  // Stage 1 — build per-slot clips. WORKER POOL, not a sequential loop: each
  // slot writes its own slot-NNN.mp4 (+ slot-keyed temp files) and the clips are
  // concatenated afterward in index order, so the encodes are independent. ff()
  // has no global ffmpeg semaphore, so a sequential loop pinned 1 core and made
  // a 254-slot render take ~30min on a 14-core box; this fans out to SLOT_CONC
  // concurrent encodes (~6× faster). totalDur/clipPaths writes are race-free in
  // JS (synchronous, no await between read and write).
  const clipPaths: string[] = new Array(slot_order.length);
  let totalDur = 0;
  const SLOT_CONC = Math.max(2, Math.min(8, os.cpus().length - 4));

  // W7 CHECKPOINT — content-addressed per-slot clip cache. A re-render reuses
  // unchanged slots' clips and re-encodes only changed ones, so a 1-beat fix
  // re-encodes ~1 of N clips instead of all N (the per-part progress the system
  // needs). Key = SLOT_COMPOSE_VERSION + the slot's compose config + every
  // referenced gem asset path + dims. Cached clips live OFF /tmp so they survive.
  // Gated behind HB_SLOT_CACHE until validated by a known 1-beat-change re-render.
  // IMPORTANT: bump SLOT_COMPOSE_VERSION on ANY change to buildSlotClip or the
  // composers it calls — otherwise a stale clip would be reused after a code change.
  const SLOT_CACHE_ON = process.env.HB_SLOT_CACHE === '1';
  const SLOT_CACHE_DIR = path.join(CLIPS_DIR, 'slot_clips');
  const SLOT_COMPOSE_VERSION = 'sc1';
  if (SLOT_CACHE_ON) await fs.mkdir(SLOT_CACHE_DIR, { recursive: true }).catch(() => {});
  const fileExists = async (p: string) => { try { await fs.access(p); return true; } catch { return false; } };
  let slotCacheHits = 0;
  const slotClipKey = (sid: string, compose: ResolvedCompose): string => {
    const c = compose as unknown as { hold_s?: number; layers?: ComposeLayer[] };
    const layers = (c.layers ?? []).map(layer => {
      const g = (layer.from ? (bag[sid] as Record<string, { local_path?: string; local_paths?: string[] | null; url?: string; word_times?: number[]; duration_s?: number } | undefined>)?.[layer.from] : undefined);
      return { cfg: layer, lp: g?.local_path, lps: g?.local_paths, url: g?.url, wt: g?.word_times, dur: g?.duration_s };
    });
    return createHash('sha256')
      .update(SLOT_COMPOSE_VERSION).update('|')
      .update(JSON.stringify({ hold: c.hold_s, layers }))
      .update(`|${width}x${height}@${fps}`)
      .digest('hex');
  };

  await withToolCall(`compose:build_slots (${slot_order.length}, conc=${SLOT_CONC}${SLOT_CACHE_ON ? ', cached' : ''})`, async () => {
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= slot_order.length) return;
        const sid = slot_order[i];
        const compose = bag[sid]?.__compose__ as unknown as ResolvedCompose | undefined;
        if (!compose) throw new Error(`slot ${sid}: missing resolved compose`);
        const cachedClip = SLOT_CACHE_ON ? path.join(SLOT_CACHE_DIR, slotClipKey(sid, compose) + '.mp4') : null;
        if (cachedClip && await fileExists(cachedClip)) {
          clipPaths[i] = cachedClip;   // checkpoint hit — slot unchanged, reuse the clip
          slotCacheHits++;
        } else {
          // RACE-SAFE publish: always encode to a UNIQUE temp, then atomically
          // rename into the content-addressed cache path. Two slots with the same
          // key (or parallel workers) thus never write the same file at once —
          // rename(2) is atomic and idempotent on the identical-content race.
          const tmp = path.join(stageDir, `slot-${String(i).padStart(3, '0')}.mp4`);
          await buildSlotClip(sid, compose, width, height, fps, tmp);
          if (cachedClip) {
            await fs.rename(tmp, cachedClip).catch(() => {});   // atomic publish (overwrites idempotently)
            clipPaths[i] = (await fileExists(cachedClip)) ? cachedClip : tmp;
          } else {
            clipPaths[i] = tmp;
          }
        }
        totalDur += compose.hold_s;
      }
    };
    await Promise.all(Array.from({ length: SLOT_CONC }, () => worker()));
  });
  if (SLOT_CACHE_ON) console.log(`[compose] slot-cache: ${slotCacheHits}/${slot_order.length} clips reused (only ${slot_order.length - slotCacheHits} re-encoded)`);

  // Stage 2 — concat with concat demuxer.
  const concatFile = path.join(stageDir, 'concat.txt');
  await fs.writeFile(concatFile, clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const concatPath = path.join(stageDir, 'concat.mp4');
  await withToolCall('compose:concat', async () => {
    await ff([
      '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-c', 'copy',
      concatPath,
    ]).catch(async () => {
      // First attempt failed (clips not stream-copy compatible) — re-encode.
      await ff([
        '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-r', String(fps),
        '-preset', 'medium', '-crf', '20',
        concatPath,
      ]);
    });
  });

  // Stage 3 — music bed pass. Generate a music track for the total duration,
  // mix UNDER voice+sfx with ducking. Per the audio-sfx spec the bed is
  // -6dB under voice with 200ms release. We use a simple amix with weights
  // (sidechain compress would be ideal but adds a lot of filter complexity).
  // music_token=null disables the bed entirely.
  const outName = `job-${jobId}-${Date.now()}.mp4`;
  const outPath = path.join(COMPOSE_DIR, outName);
  // OG-MG listicles use NO music bed. Default to none rather than 'bed' — a
  // null music_token degrades to undefined through the args pipeline and the
  // old default then 400'd on every >30s render (elevenlabs caps sfx at 30s).
  // An explicit music_token is still honoured.
  const musicToken = args.music_token || null;
  if (musicToken) {
    try {
      await withToolCall(`compose:music_bed (${musicToken})`, async () => {
        const { getSfx } = await import('./sfx');
        const music = await getSfx(musicToken, totalDur);
        // amix: [0]=concat audio (voice+sfx), [1]=music (dialed to ~0.25 vol).
        // We side-step true sidechaining by giving voice/sfx ~4x the weight of
        // music. Plus volume filter on the music itself for headroom.
        await ff([
          '-y', '-i', concatPath, '-i', music.local_path,
          '-filter_complex',
            `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.25,` +
            `apad=pad_dur=${totalDur.toFixed(3)},atrim=0:${totalDur.toFixed(3)}[bed];` +
            `[0:a][bed]amix=inputs=2:duration=longest:dropout_transition=0:weights='4 1'[aout]`,
          '-map', '0:v', '-map', '[aout]',
          '-c:v', 'copy',
          '-c:a', 'aac', '-b:a', '160k',
          outPath,
        ]);
      });
    } catch (e) {
      // Music bed is best-effort — log and fall back to concat without bed.
      console.warn(`[producer:music-bed] failed for token=${musicToken}: ${(e as Error).message}`);
      await fs.copyFile(concatPath, outPath);
    }
  } else {
    await fs.copyFile(concatPath, outPath);
  }

  await emitToolCall('compose:done', { duration_s: totalDur, output: outName });
  // Cleanup stage dir
  try { await fs.rm(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return {
    file_url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent(outName)}`,
    duration_s: Math.round(totalDur * 100) / 100,
    width,
    height,
    local_path: outPath,
  };
}
