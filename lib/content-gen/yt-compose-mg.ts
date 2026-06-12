/**
 * MG-style composition primitives.
 *
 * Takes a raw YT capture screenshot + bbox info and produces a 1920×1080
 * PNG ready to be the video frame for a slot. The composition includes
 * MG-style framing — the cropped content from the real YT dark-mode
 * screenshot placed inside a clean dark-gray rounded card on a white
 * outer canvas.
 *
 * Crop bounds + card dimensions were dialed in via local Sharp iteration
 * against the actual captured PNG (see /tmp/iter/crop_test.mjs) and
 * verified frame-by-frame against the source MG video.
 */

import path from 'path';
import os from 'os';
import sharp from 'sharp';
import type { BBox } from './yt-capture';

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const CANVAS_BG = { r: 255, g: 255, b: 255 };  // white outer canvas (MG style)
const CARD_BG = { r: 32, g: 32, b: 32 };        // matches YT dark-mode modal
const CARD_RADIUS = 40;                          // rounded card corners

// Centered card dimensions — ~52% of canvas width, ~72% of canvas height.
// Both axes have ~150px white margin on all sides, MG-style balanced.
const CARD_W = 1000;
const CARD_H = 780;
const CARD_INNER_PAD_X = 50;
const CARD_INNER_PAD_Y = 40;

/**
 * Compose an MG-style "channel about panel" frame.
 *
 * Crops the "More info" stats column + Share button from the about-page
 * screenshot using joined_date as the deterministic anchor, then
 * composites it inside a centered rounded card on a white canvas.
 *
 * Crop bounds (relative to joined_date, dialed in 2026-06-08):
 *   xLeft  = joined.x - 44              // just left of row icons
 *   yTop   = joined.y - 110             // includes URL+Country above
 *                                       //   excludes "More info" heading
 *   xRight = joined.x + joined.w + 264  // past row text right edge
 *   yBot   = joined.y + 262             // includes views row + Share button
 *
 * Output: 1920×1080 PNG at a temp path the caller can pipe to ffmpeg.
 */
/** Placement metadata so the highlight pass can map SOURCE coords to the
 *  composed canvas without duplicating the crop/fit math. */
export interface AboutPanelMap { cropX: number; cropY: number; scale: number; offX: number; offY: number }

/** Find the bottom of the about modal from PIXELS: the "Share channel"
 *  pill is a wide mid-gray rounded button below the stats rows — the one
 *  reliable landmark on every modal variant. Stats-row bboxes proved
 *  junk-prone (matched the dimmed page behind the modal) and a fixed
 *  joined.y+222 both bled past short modals AND cut long ones (jobs
 *  171/173). Fallback: joined.y + 222. */
async function findShareBottom(srcPath: string, joined: BBox): Promise<number | null> {
  const { data, info } = await sharp(srcPath).raw().toBuffer({ resolveWithObject: true });
  const x0 = Math.max(0, joined.x - 24), x1 = Math.min(info.width - 1, joined.x + 240);
  const yStart = joined.y + 110, yEnd = Math.min(info.height - 1, joined.y + 430);
  let pillTop = -1;
  for (let y = yStart; y < yEnd; y++) {
    let run = 0, best = 0;
    for (let x = x0; x < x1; x++) {
      const off = (y * info.width + x) * info.channels;
      const b = (data[off] + data[off + 1] + data[off + 2]) / 3;
      if (b > 52 && b < 165) { run++; if (run > best) best = run; } else run = 0;
    }
    if (best >= 110) { pillTop = y; break; }
  }
  if (pillTop < 0) return null;
  // walk to the pill's bottom edge
  let y = pillTop;
  for (; y < Math.min(info.height - 1, pillTop + 70); y++) {
    let run = 0, best = 0;
    for (let x = x0; x < x1; x++) {
      const off = (y * info.width + x) * info.channels;
      const b = (data[off] + data[off + 1] + data[off + 2]) / 3;
      if (b > 52 && b < 165) { run++; if (run > best) best = run; } else run = 0;
    }
    if (best < 60) break;
  }
  return y + 20;
}

export async function composeAboutPanelMG(srcPath: string, joined: BBox): Promise<{ path: string; map: AboutPanelMap }> {
  const cropX = Math.max(0, joined.x - 44);
  const cropY = Math.max(0, joined.y - 96);
  // 296 (was 308): narrow modals leaked a ~6px page sliver at the card's
  // right edge (job 178, niche_10 proofs).
  const cropW = joined.w + 296;
  const shareBottom = await findShareBottom(srcPath, joined).catch(() => null);
  const cropH = Math.max(160, (shareBottom ?? joined.y + 222) - cropY);

  // Clamp to source dimensions.
  const meta = await sharp(srcPath).metadata();
  const srcW = meta.width ?? 1440;
  const srcH = meta.height ?? 900;
  const safeW = Math.min(cropW, srcW - cropX);
  const safeH = Math.min(cropH, srcH - cropY);

  // 2. Extract the cropped content from the source screenshot.
  const cropped = await sharp(srcPath)
    .extract({ left: cropX, top: cropY, width: safeW, height: safeH })
    .png()
    .toBuffer();

  // 3. Build a clean dark-gray card with rounded corners via SVG.
  const cardSvg = `<svg width="${CARD_W}" height="${CARD_H}">
    <rect x="0" y="0" width="${CARD_W}" height="${CARD_H}"
          rx="${CARD_RADIUS}" ry="${CARD_RADIUS}"
          fill="rgb(${CARD_BG.r},${CARD_BG.g},${CARD_BG.b})"/>
  </svg>`;
  const cardBase = await sharp(Buffer.from(cardSvg)).png().toBuffer();

  // 4. Resize the cropped content to fit INSIDE the card (preserve aspect).
  const innerW = CARD_W - 2 * CARD_INNER_PAD_X;
  const innerH = CARD_H - 2 * CARD_INNER_PAD_Y;
  const cropAspect = safeW / safeH;
  const innerAspect = innerW / innerH;
  let fitW: number, fitH: number;
  if (cropAspect > innerAspect) {
    fitW = innerW;
    fitH = Math.round(innerW / cropAspect);
  } else {
    fitH = innerH;
    fitW = Math.round(innerH * cropAspect);
  }
  const fitted = await sharp(cropped).resize(fitW, fitH).png().toBuffer();

  // 5. Composite content onto card — centered both axes.
  const innerLeft = Math.round((CARD_W - fitW) / 2);
  const innerTop = Math.round((CARD_H - fitH) / 2);
  const cardWithContent = await sharp(cardBase)
    .composite([{ input: fitted, left: innerLeft, top: innerTop }])
    .png()
    .toBuffer();

  // 6. Place card on white 1920×1080 canvas — centered both axes.
  const cardX = Math.round((CANVAS_W - CARD_W) / 2);
  const cardY = Math.round((CANVAS_H - CARD_H) / 2);
  const outPath = path.join(os.tmpdir(), `mg-about-panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: CANVAS_BG },
  })
    .composite([{ input: cardWithContent, left: cardX, top: cardY }])
    .png()
    .toFile(outPath);
  return {
    path: outPath,
    map: {
      cropX, cropY,
      scale: fitW / safeW,
      offX: cardX + innerLeft,
      offY: cardY + innerTop,
    },
  };
}


/**
 * Compose an MG-style "top videos pano" frame — 4×2 grid of channel videos.
 *
 * MG reference (frames2/t182.png) measurements:
 *   Outer canvas: dark gray rgb(60,60,60), NOT white
 *   Inner card: near-black rgb(13,13,13), aspect ~2.31 (landscape)
 *   Card occupies ~78.6% × ~60.6% of canvas, centered with balanced margins
 *
 * Inputs:
 *   srcPath: path to the videos_tab capture PNG (taken at 1700×1500 viewport
 *            so YT renders 4 cards/row and at least 2 rows fit)
 *   cardBboxes: array of video_card_N bboxes (first 8 used). Union forms the
 *               grid bounds. Must come from the same capture as srcPath.
 */
// MG pano reference (frame VES STICK "Best Falls" grid scroll):
//   Outer gray border around a big rounded dark card containing the grid.
//   ~2 rows of cards visible per frame (cards are large — titles legible).
//   Card extends past canvas top/bottom during mid-scroll.
const PANO_OUTER_BG = { r: 60, g: 60, b: 60 };    // measured MG dark canvas (job-173 verify: 95 drifted vs every adjacent dark beat)
const PANO_CARD_BG  = { r: 22, g: 22, b: 22 };    // dark inner card (was 13)
const PANO_CARD_W = 1800;                          // ~94% of 1920 — big card
const PANO_CARD_RADIUS = 36;
const PANO_CARD_MARGIN_X = (CANVAS_W - PANO_CARD_W) / 2;  // 60px
const PANO_CARD_MARGIN_Y_TOP = 100;
const PANO_CARD_MARGIN_Y_BOT = 100;
const PANO_INNER_PAD = 30;

/**
 * Compose an MG-style "channel chip" frame — the channel identity card
 * (avatar + name + handle/subs/videos + description preview + Subscribe).
 *
 * MG reference (frame VES STICK at t≈1-4 of the source video, plus the
 * user-shared image 1): a wide chip rendered inside a rounded dark card
 * on a white outer canvas, centered. The chip is cropped from a real
 * channel_page screenshot (YT dark mode) using subscriber_count as the
 * deterministic anchor.
 *
 * Crop bounds (verified locally — see /tmp/iter/out_chip_h.png):
 *   yTop  = subs.y - 86   → just below the channel banner
 *   yBot  = subs.y + 124  → past the Subscribe button
 *   xLeft = subs.x - 366  → past the avatar's left edge
 *   xRight = subs.x + subs.w + 340 → past the description's right edge
 *
 * Revised 2026-06-10 after user feedback: previous crop included visual
 * trash (banner sliver, partial Subscribe text on left, excess padding).
 * Tighter bounds + landscape card aspect (~3.4:1) to match MG framing —
 * verified locally via /tmp/iter/out_chip_tight_b.png.
 *   Banner ends at y=227 in dark-mode capture → cropY = subs.y-68 = 228
 *   xLeft = subs.x-356 → x=240 (past Subscribe button gutter)
 *   Card 1500×440 (was 1500×700) with 20px inner pad (was 40)
 */
// Reference geometry from the transcript-aligned frame study (2026-06-12,
// MG niche_1 channel_b "MAX STICK" chip): chip card ~48% of frame width,
// aspect ~3:1, dark chip on a canvas that is WHITE (253,253,253) or DARK
// (60,60,60) depending on the niche's canvas run. Card wraps its content
// TIGHTLY (no letterbox bands) with generous inner padding.
const CHIP_CONTENT_W = 840;   // 930px card minus padding ≈ 48% of 1920
const CHIP_CARD_RADIUS = 36;
const CHIP_INNER_PAD = 44;
// Card fill = YT page black (#0D0D0D) so the cropped chip content blends
// seamlessly into the card (reference chips are one continuous tone; the
// 32,32,32 modal gray left a visible two-tone band — Prumhy test).
const CHIP_CARD_BG = { r: 13, g: 13, b: 13 };

export type MgCanvas = 'white' | 'dark_gray';
const MG_CANVAS_RGB: Record<MgCanvas, { r: number; g: number; b: number }> = {
  white: { r: 253, g: 253, b: 253 },     // #FDFDFD — measured on MG frames
  dark_gray: { r: 60, g: 60, b: 60 },    // #3C3C3C — measured on MG frames
};

/** Pixel-detect the WHITE Subscribe pill below the stats line — the one
 *  reliable chip landmark on every layout (same technique as the about
 *  modal's Share pill). Fixed offsets sliced three different layouts:
 *  +110 cut buttons (Prumhy), +150 caught tabs (Size Cipher), the +118
 *  floor cut mid-button (niche_9 B, job 177). */
async function findSubscribePillBottom(srcPath: string, subs: BBox): Promise<number | null> {
  const { data, info } = await sharp(srcPath).raw().toBuffer({ resolveWithObject: true });
  const x0 = Math.max(0, subs.x - 8), x1 = Math.min(info.width - 1, subs.x + 280);
  // Window to +300: extra bio-link rows push the buttons low (niche_10's
  // forms.gle row, job 178). Thresholds 185/56 (were 200/80): narrow
  // Subscribe pills on Join+Community layouts ran ~80px and missed
  // marginally — three chips fell back to the broken offset chain.
  const yStart = subs.y + 40, yEnd = Math.min(info.height - 1, subs.y + 300);
  const rowBest = (y: number): number => {
    let run = 0, best = 0;
    for (let x = x0; x < x1; x++) {
      const off = (y * info.width + x) * info.channels;
      const b = (data[off] + data[off + 1] + data[off + 2]) / 3;
      if (b > 185) { run++; if (run > best) best = run; } else run = 0;
    }
    return best;
  };
  let pillTop = -1;
  for (let y = yStart; y < yEnd; y++) {
    // Multi-row confirmation: a real pill is ~36px tall — reject bright
    // hairlines by requiring the run to persist 12 and 20 rows down.
    if (rowBest(y) >= 56 && rowBest(y + 12) >= 56 && rowBest(y + 20) >= 40) { pillTop = y; break; }
  }
  if (pillTop < 0) return null;
  let y = pillTop;
  for (; y < Math.min(info.height - 1, pillTop + 60); y++) {
    if (rowBest(y) < 36) break;
  }
  return y + 14;
}

export async function composeChannelChipMG(srcPath: string, subs: BBox, opts: { canvas?: MgCanvas; subscribeBtn?: BBox; channelName?: BBox; tabsRow?: BBox; tabsHome?: BBox; gridTop?: BBox; tabsStrip?: BBox } = {}): Promise<string> {
  // 1. Compute crop bounds from subscriber_count anchor.
  //    Banner ends at y=227 in YT dark mode → cropY = subs.y - 68 = 228.
  //    Bottom: just below the Subscribe button when its bbox is known
  //    (reference chips END at the button row — never the tabs row);
  //    fallback +150 covers the button row even with a links line above
  //    (+110 half-cut the buttons on channels with links — Prumhy test).
  // -336 (was -356): the extra 20px caught the page's separator hairlines
  // left of the avatar (Prumhy test); reference chips are clean black.
  const cropX = Math.max(0, subs.x - 336);
  // Top: just above the channel-name row when its bbox is known (the
  // fixed -68 caught a banner sliver on channels whose banner ends low).
  const nameOk = opts.channelName && opts.channelName.y < subs.y && opts.channelName.y > subs.y - 90;
  const cropY = Math.max(0, nameOk ? opts.channelName!.y - 14 : subs.y - 68);
  // +344 (was +320): the bio's '...more' link clipped mid-glyph at the
  // card edge on long-bio channels (job 173, niches 3/7).
  const cropW = subs.x + subs.w + 344 - cropX;
  // Bottom: trust the Subscribe-button bbox only when it sits BELOW the
  // stats line and within chip range — the page can contain other
  // "Subscribe" texts (job 157: a wrong match cut the bio + button off).
  const pillBottom = await findSubscribePillBottom(srcPath, subs).catch(() => null);
  const btnOk = opts.subscribeBtn && opts.subscribeBtn.y > subs.y + 10 && opts.subscribeBtn.y < subs.y + 240;
  // Tabs candidates (Videos and/or Home label) — take the TOPMOST valid
  // one; the chip ends just above the tabs row.
  const tabsCands = [opts.tabsRow, opts.tabsHome]
    .filter((t): t is BBox => !!t && t.y > subs.y + 60 && t.y < subs.y + 340)
    .sort((a, b) => a.y - b.y);
  // Precedence: DOM tabs-strip top (layout-independent truth) > pixel-
  // detected Subscribe pill > text bboxes > fixed fallback.
  const stripOk = opts.tabsStrip && opts.tabsStrip.y > subs.y + 70 && opts.tabsStrip.y < subs.y + 400;
  let cropBottom = stripOk
    ? opts.tabsStrip!.y - 12
    : pillBottom != null
      ? pillBottom
      : btnOk
        ? opts.subscribeBtn!.y + opts.subscribeBtn!.h + 16
        : tabsCands.length
          ? tabsCands[0].y - 12
          : subs.y + 150;
  // Grid-top cap: tabs sit ~110-130px above the first video card, so the
  // chip must end at least ~126px above it — catches layouts whose
  // subscribe/tabs bboxes are all junk (jobs 173/174: niche_8 chip kept
  // its tabs row through every bbox-based anchor).
  if (!stripOk && pillBottom == null) {
    if (opts.gridTop && opts.gridTop.y > subs.y + 80) {
      cropBottom = Math.min(cropBottom, opts.gridTop.y - 126);
    }
    // FLOOR for the guess-based anchors only (the pixel-detected pill
    // bottom is authoritative): never end above subs.y+118.
    cropBottom = Math.max(cropBottom, subs.y + 118);
  }
  const cropH = Math.max(96, cropBottom - cropY);

  // Clamp to source dimensions.
  const meta = await sharp(srcPath).metadata();
  const srcW = meta.width ?? 1440;
  const srcH = meta.height ?? 900;
  const safeW = Math.min(cropW, srcW - cropX);
  const safeH = Math.min(cropH, srcH - cropY);

  // 2. Extract chip content.
  const cropped = await sharp(srcPath)
    .extract({ left: cropX, top: cropY, width: safeW, height: safeH })
    .png()
    .toBuffer();

  // 3. Scale content to the reference width; card wraps it tightly.
  const fitW = CHIP_CONTENT_W;
  const fitH = Math.round(CHIP_CONTENT_W * safeH / safeW);
  const fitted = await sharp(cropped).resize(fitW, fitH).png().toBuffer();
  const cardW = fitW + 2 * CHIP_INNER_PAD;
  const cardH = fitH + 2 * CHIP_INNER_PAD;

  const cardSvg = `<svg width="${cardW}" height="${cardH}">
    <rect x="0" y="0" width="${cardW}" height="${cardH}"
          rx="${CHIP_CARD_RADIUS}" ry="${CHIP_CARD_RADIUS}"
          fill="rgb(${CHIP_CARD_BG.r},${CHIP_CARD_BG.g},${CHIP_CARD_BG.b})"/>
  </svg>`;
  const cardWithContent = await sharp(Buffer.from(cardSvg)).png().toBuffer()
    .then(base => sharp(base)
      .composite([{ input: fitted, left: CHIP_INNER_PAD, top: CHIP_INNER_PAD }])
      .png()
      .toBuffer());

  // 4. Place card centered on the canvas.
  const canvasBg = MG_CANVAS_RGB[opts.canvas ?? 'white'];
  const cardX = Math.round((CANVAS_W - cardW) / 2);
  const cardY = Math.round((CANVAS_H - cardH) / 2);
  const outPath = path.join(os.tmpdir(), `mg-channel-chip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: { ...canvasBg, alpha: 1 } },
  })
    .composite([{ input: cardWithContent, left: cardX, top: cardY }])
    .png()
    .toFile(outPath);
  return outPath;
}

/**
 * Compose an MG-style "full channel page" frame — banner + chip + tabs
 * + grid, on a lighter outer canvas with the YT page in a rounded dark
 * card.
 *
 * MG reference frame at t=3.8 (see /tmp/mg_analysis/frames_yt/mg_t3.8.png).
 * Local verification: /tmp/iter/out_cp_b.png matched the framing.
 *
 * Crops the YT sidebar away (always at x:0-248), keeping the content
 * area (x:248-1440, y:48-900 in a 1440×900 capture). Places that
 * cropped page inside a dark rounded card on a medium-gray canvas.
 */
// Reference geometry from the transcript-aligned frame study (2026-06-12):
// MG page cards are ~58-61% of frame width × ~84% height (MAX STICK 55.5%,
// KAD STICK 60.7%), wrap their content TIGHTLY (no letterbox bands), and
// sit on a canvas that is WHITE (253,253,253 — niche_1 channel_b) or DARK
// (60,60,60 — niche_2 channel_b, all saturation pages). The old 95-gray
// canvas and 92%-width card were both off-reference.
const CPAGE_CARD_BG  = { r: 16, g: 16, b: 16 };
const CPAGE_CARD_RADIUS = 36;
const CPAGE_INNER_PAD = 24;
const CPAGE_CONTENT_W = 1120;  // card ≈ 1168px ≈ 61% of 1920
const CPAGE_MAX_CARD_H = 980;

export async function composeChannelPageFullMG(srcPath: string, opts: { canvas?: MgCanvas } = {}): Promise<string> {
  // 1. Crop the page content area (excludes YT sidebar + top search bar).
  const meta = await sharp(srcPath).metadata();
  const srcW = meta.width ?? 1440;
  const srcH = meta.height ?? 900;
  // YT sidebar width in 1440×900 capture = ~248px. Top search bar = ~48px.
  const sidebarW = Math.round(srcW * 248 / 1440);
  const topBarH = Math.round(srcH * 48 / 900);
  const cropX = sidebarW;
  const cropY = topBarH;
  const cropW = srcW - cropX;
  let cropH = srcH - cropY;

  // 2. Scale content to the reference width; the card wraps it tightly.
  //    If the scaled page is taller than the max card, trim the SOURCE
  //    bottom (page clips mid-grid at the card edge — reference-canon).
  let fitW = CPAGE_CONTENT_W;
  let fitH = Math.round(fitW * cropH / cropW);
  const maxFitH = CPAGE_MAX_CARD_H - 2 * CPAGE_INNER_PAD;
  if (fitH > maxFitH) {
    cropH = Math.round(maxFitH * cropW / fitW);
    fitH = maxFitH;
  }

  const cropped = await sharp(srcPath)
    .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
    .png()
    .toBuffer();
  const fitted = await sharp(cropped).resize(fitW, fitH).png().toBuffer();

  const cardW = fitW + 2 * CPAGE_INNER_PAD;
  const cardH = fitH + 2 * CPAGE_INNER_PAD;
  const cardSvg = `<svg width="${cardW}" height="${cardH}">
    <rect x="0" y="0" width="${cardW}" height="${cardH}"
          rx="${CPAGE_CARD_RADIUS}" ry="${CPAGE_CARD_RADIUS}"
          fill="rgb(${CPAGE_CARD_BG.r},${CPAGE_CARD_BG.g},${CPAGE_CARD_BG.b})"/>
  </svg>`;
  const cardWithContent = await sharp(Buffer.from(cardSvg)).png().toBuffer()
    .then(base => sharp(base)
      .composite([{ input: fitted, left: CPAGE_INNER_PAD, top: CPAGE_INNER_PAD }])
      .png()
      .toBuffer());

  // 3. Place card centered on the canvas.
  const canvasBg = MG_CANVAS_RGB[opts.canvas ?? 'dark_gray'];
  const cardX = Math.round((CANVAS_W - cardW) / 2);
  const cardY = Math.round((CANVAS_H - cardH) / 2);
  const outPath = path.join(os.tmpdir(), `mg-channel-page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: { ...canvasBg, alpha: 1 } },
  })
    .composite([{ input: cardWithContent, left: cardX, top: cardY }])
    .png()
    .toFile(outPath);
  return outPath;
}

/**
 * Compose an MG-style "single video card" frame — one video card cropped
 * from a videos_tab capture, placed on a dark canvas. Matches MG t=600.8
 * reference and is used by the BEAT 7 top-views rapid-fire sequence
 * (3 cards × ~1s each).
 *
 * Crops just the card bbox (which already includes thumbnail + title +
 * meta in YT's lockup model — see niche-spy-style bbox extraction).
 * Local verification: /tmp/iter/out_single_card_c.png.
 */
// Canvas re-measured 2026-06-12 on the transcript-aligned frame study:
// MG's dark canvas is 60,60,60 everywhere (was 35,35,35 here). Card width
// is per-beat: hero rapid-fire ~57% (1100); channel_b lone top-video card
// ~34% (660 — MG niche_4 "1.3m views" payoff card).
const RAPID_CARD_BG  = { r: 22, g: 22, b: 22 };  // slightly darker inner card
const RAPID_CARD_W = 1100;                        // ~57% of 1920 canvas
const RAPID_CARD_RADIUS = 36;
const RAPID_INNER_PAD = 30;
const RAPID_CROP_PAD = 14;                        // breathing room around card bbox

export async function composeThumbnailRapidFireMG(srcPath: string, cardBbox: BBox, opts: { canvas?: MgCanvas; cardW?: number } = {}): Promise<string> {
  // 1. Crop the single card from the videos_tab capture. The bbox is from
  //    YT's yt-lockup-view-model — already covers thumb + title + meta.
  const cropX = Math.max(0, cardBbox.x - RAPID_CROP_PAD);
  const cropY = Math.max(0, cardBbox.y - RAPID_CROP_PAD);
  const cropW = cardBbox.w + 2 * RAPID_CROP_PAD;
  const cropH = cardBbox.h + 2 * RAPID_CROP_PAD;

  const meta = await sharp(srcPath).metadata();
  // Clamp INTO the image: a lazy-rendered card's bbox can sit below the
  // actual screenshot bottom (bbox y≈2400 on a shorter PNG) — the raw
  // subtraction went negative and sharp threw "Expected integer for
  // height but received -60" (job 172).
  const imgW = meta.width ?? 0, imgH = meta.height ?? 0;
  const cx = Math.min(cropX, Math.max(0, imgW - 60));
  const cy = Math.min(cropY, Math.max(0, imgH - 60));
  const safeW = Math.max(40, Math.min(cropW, imgW - cx));
  const safeH = Math.max(40, Math.min(cropH, imgH - cy));
  const cropped = await sharp(srcPath)
    .extract({ left: cx, top: cy, width: safeW, height: safeH })
    .png()
    .toBuffer();

  // 2. Build the dark rounded card. Adapt card height to maintain the
  //    crop aspect (so the title row sits naturally below the thumbnail).
  const cardWidth = opts.cardW ?? RAPID_CARD_W;
  const cropAspect = safeW / safeH;
  const cardH = Math.round(cardWidth / cropAspect);
  const cardSvg = `<svg width="${cardWidth}" height="${cardH}">
    <rect x="0" y="0" width="${cardWidth}" height="${cardH}"
          rx="${RAPID_CARD_RADIUS}" ry="${RAPID_CARD_RADIUS}"
          fill="rgb(${RAPID_CARD_BG.r},${RAPID_CARD_BG.g},${RAPID_CARD_BG.b})"/>
  </svg>`;
  const cardBase = await sharp(Buffer.from(cardSvg)).png().toBuffer();

  // 3. Fit the cropped card inside the inner padded area.
  const innerW = cardWidth - 2 * RAPID_INNER_PAD;
  const innerH = cardH - 2 * RAPID_INNER_PAD;
  const fitted = await sharp(cropped)
    .resize(innerW, innerH, { fit: 'contain', background: RAPID_CARD_BG })
    .png()
    .toBuffer();
  const cardWithContent = await sharp(cardBase)
    .composite([{ input: fitted, left: RAPID_INNER_PAD, top: RAPID_INNER_PAD }])
    .png()
    .toBuffer();

  // 4. Place card centered on the canvas (measured MG colors).
  const canvasBg = MG_CANVAS_RGB[opts.canvas ?? 'dark_gray'];
  const cardX = Math.round((CANVAS_W - cardWidth) / 2);
  const cardY = Math.round((CANVAS_H - cardH) / 2);
  const outPath = path.join(os.tmpdir(), `mg-rapid-fire-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: { ...canvasBg, alpha: 1 } },
  })
    .composite([{ input: cardWithContent, left: cardX, top: cardY }])
    .png()
    .toFile(outPath);
  return outPath;
}

/**
 * Compose an MG-style "grid wall" — a header-less videos grid as a wide
 * rounded card on the dark canvas. Reference: saturation Form B
 * (transcript-aligned frame study 2026-06-12, MG niche_4 Valaritas wall
 * at "That consistency shows the real potential here."): 3 rows x 4 cols,
 * NO channel header, top row CLIPPED mid-thumbnail at the card edge,
 * every card showing title + views + age — the view-count consistency
 * proof. Card ~81% of frame width.
 */
const WALL_CONTENT_W = 1560;
const WALL_MAX_CARD_H = 980;

export async function composeGridWallMG(srcPath: string, cardBboxes: BBox[], opts: { canvas?: MgCanvas } = {}): Promise<string> {
  if (cardBboxes.length < 4) throw new Error('composeGridWallMG: need >= 4 card bboxes');
  let cards = cardBboxes.slice(0, 12);
  // Pre-shrink: if the union (minus the top clip) would overflow the max
  // card height once scaled, drop the LAST ROW of cards rather than
  // pixel-trimming through a row's title/meta (reference walls always end
  // on a complete row of metadata).
  for (;;) {
    const minY0 = Math.min(...cards.map(c => c.y));
    const maxY0 = Math.max(...cards.map(c => c.y + c.h));
    const minX0 = Math.min(...cards.map(c => c.x));
    const maxX0 = Math.max(...cards.map(c => c.x + c.w));
    const h0 = (maxY0 + 10) - (minY0 + Math.round(cards[0].h * 0.25));
    const w0 = (maxX0 + 8) - (minX0 - 8);
    if (cards.length <= 4 || Math.round(WALL_CONTENT_W * h0 / w0) <= WALL_MAX_CARD_H - 48) break;
    cards = cards.slice(0, cards.length - 4);
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of cards) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  // Top edge cuts INTO the first row's thumbnails (reference-canon clip).
  const cropX = Math.max(0, minX - 8);
  const cropY = Math.max(0, minY + Math.round(cards[0].h * 0.25));
  const cropW = (maxX + 8) - cropX;
  let cropH = (maxY + 10) - cropY;

  const meta = await sharp(srcPath).metadata();
  const srcW = meta.width ?? 1700;
  const srcH = meta.height ?? 2500;
  const safeW = Math.max(40, Math.min(cropW, srcW - cropX));
  cropH = Math.max(40, Math.min(cropH, srcH - cropY));

  // Scale to reference width; the card wraps tightly; trim the source
  // bottom if the card would exceed the frame.
  const fitW = WALL_CONTENT_W;
  const pad = 24;
  let fitH = Math.round(fitW * cropH / safeW);
  const maxFitH = WALL_MAX_CARD_H - 2 * pad;
  if (fitH > maxFitH) {
    cropH = Math.round(maxFitH * safeW / fitW);
    fitH = maxFitH;
  }
  const cropped = await sharp(srcPath)
    .extract({ left: cropX, top: cropY, width: safeW, height: cropH })
    .png()
    .toBuffer();
  const fitted = await sharp(cropped).resize(fitW, fitH).png().toBuffer();

  const cardW = fitW + 2 * pad;
  const cardH = fitH + 2 * pad;
  const cardSvg = `<svg width="${cardW}" height="${cardH}">
    <rect x="0" y="0" width="${cardW}" height="${cardH}" rx="36" ry="36"
          fill="rgb(${CPAGE_CARD_BG.r},${CPAGE_CARD_BG.g},${CPAGE_CARD_BG.b})"/>
  </svg>`;
  const cardWithContent = await sharp(Buffer.from(cardSvg)).png().toBuffer()
    .then(base => sharp(base)
      .composite([{ input: fitted, left: pad, top: pad }])
      .png()
      .toBuffer());

  const canvasBg = MG_CANVAS_RGB[opts.canvas ?? 'dark_gray'];
  const outPath = path.join(os.tmpdir(), `mg-grid-wall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: { ...canvasBg, alpha: 1 } },
  })
    .composite([{ input: cardWithContent, left: Math.round((CANVAS_W - cardW) / 2), top: Math.round((CANVAS_H - cardH) / 2) }])
    .png()
    .toFile(outPath);
  return outPath;
}

/**
 * Compose an MG-style "top videos pano" frame — full vertical grid for
 * scroll-down panning. Output is a TALL PNG (1920 × N where N > 1080)
 * that ffmpeg will pan vertically over the slot duration.
 *
 * Output dimensions adapt to the grid's actual height. The dark-gray
 * outer canvas + rounded card extend full N height. Inside the card,
 * the grid content fills the card vertically at native aspect.
 */
export async function composeTopVideosPanoMG(srcPath: string, cardBboxes: BBox[]): Promise<string> {
  if (cardBboxes.length === 0) throw new Error('composeTopVideosPanoMG: no card bboxes');

  // 1. Union ALL card bboxes → grid bounds in source coords. (Was first 8;
  //    with the tall 1700×2500 viewport we want the entire visible grid
  //    so the scroll-down has content to show.)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of cardBboxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  // Pad slightly. Bigger bottom pad to include title+meta text below cards.
  const padX = 16, padTop = 16, padBot = 80;
  const cropX = Math.max(0, minX - padX);
  const cropY = Math.max(0, minY - padTop);
  const cropW = (maxX + padX) - cropX;
  const cropH = (maxY + padBot) - cropY;

  // Clamp to source dimensions.
  const meta = await sharp(srcPath).metadata();
  const srcW = meta.width ?? 1700;
  const srcH = meta.height ?? 2500;
  const safeW = Math.min(cropW, srcW - cropX);
  const safeH = Math.min(cropH, srcH - cropY);

  // 2. Extract the grid crop.
  const cropped = await sharp(srcPath)
    .extract({ left: cropX, top: cropY, width: safeW, height: safeH })
    .png()
    .toBuffer();

  // 3. Resize the grid to fit card inner width preserving aspect. The
  //    resulting height becomes the card's content height — likely TALLER
  //    than 1080. That's the point: ffmpeg will pan vertically over it.
  const innerW = PANO_CARD_W - 2 * PANO_INNER_PAD;
  const cropAspect = safeW / safeH;
  const fitW = innerW;
  const fitH = Math.round(innerW / cropAspect);
  const fitted = await sharp(cropped).resize(fitW, fitH).png().toBuffer();

  // 4. Card height = content height + inner pad. Canvas height = card +
  //    top/bottom margins. ENSURE canvas is at least CANVAS_H tall (so a
  //    short grid still produces a >=1080 canvas).
  const cardH = fitH + 2 * PANO_INNER_PAD;
  const canvasH = Math.max(CANVAS_H, cardH + PANO_CARD_MARGIN_Y_TOP + PANO_CARD_MARGIN_Y_BOT);

  // 5. Build rounded dark card (sized to fit the grid).
  const cardSvg = `<svg width="${PANO_CARD_W}" height="${cardH}">
    <rect x="0" y="0" width="${PANO_CARD_W}" height="${cardH}"
          rx="${PANO_CARD_RADIUS}" ry="${PANO_CARD_RADIUS}"
          fill="rgb(${PANO_CARD_BG.r},${PANO_CARD_BG.g},${PANO_CARD_BG.b})"/>
  </svg>`;
  const cardBase = await sharp(Buffer.from(cardSvg)).png().toBuffer();

  // 6. Composite content into card, centered horizontally.
  const innerLeft = Math.round((PANO_CARD_W - fitW) / 2);
  const innerTop = PANO_INNER_PAD;
  const cardWithContent = await sharp(cardBase)
    .composite([{ input: fitted, left: innerLeft, top: innerTop }])
    .png()
    .toBuffer();

  // 7. Place card on dark-gray outer 1920 × canvasH canvas.
  const cardX = Math.round(PANO_CARD_MARGIN_X);
  const cardY = PANO_CARD_MARGIN_Y_TOP;
  const outPath = path.join(os.tmpdir(), `mg-pano-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await sharp({
    create: { width: CANVAS_W, height: canvasH, channels: 4, background: PANO_OUTER_BG },
  })
    .composite([{ input: cardWithContent, left: cardX, top: cardY }])
    .png()
    .toFile(outPath);
  return outPath;
}

/**
 * Compose an MG-style channel logos montage (2×5 grid of channel avatars
 * on a white canvas). Each avatar is rendered as a circle with a thick
 * black border, matching MG's intro reveal style.
 *
 * The output PNG is STATIC — the zoom-in-to-target animation happens at
 * ffmpeg time via the `logos_zoom_to:N` crop_target hook in video-compose.
 *
 * Local verification: /tmp/iter/out_logos_grid.png + /tmp/iter/logos_zoom2_t*.png
 */
const LOGOS_CANVAS_BG = { r: 255, g: 255, b: 255 };
const LOGOS_GRID_COLS = 5;
const LOGOS_GRID_ROWS = 2;
const LOGOS_AVATAR_SIZE = 280;
const LOGOS_BORDER_W = 10;
export const LOGOS_CELL_W = CANVAS_W / LOGOS_GRID_COLS;   // 384
export const LOGOS_CELL_H = CANVAS_H / LOGOS_GRID_ROWS;   // 540

/** Return the (cx, cy) center of avatar at idx in the 1920×1080 grid. */
export function logosTargetCenter(idx: number): { cx: number; cy: number } {
  const col = idx % LOGOS_GRID_COLS;
  const row = Math.floor(idx / LOGOS_GRID_COLS);
  return {
    cx: Math.round(col * LOGOS_CELL_W + LOGOS_CELL_W / 2),
    cy: Math.round(row * LOGOS_CELL_H + LOGOS_CELL_H / 2),
  };
}

/** Render one avatar as a circular image with a thick black border. */
async function renderCircleAvatar(srcBuf: Buffer, size: number, borderW: number): Promise<Buffer> {
  const r = size / 2;
  const inner = size - 2 * borderW;
  const maskSvg =
    `<svg width="${inner}" height="${inner}">` +
    `<circle cx="${inner / 2}" cy="${inner / 2}" r="${inner / 2}" fill="white"/>` +
    `</svg>`;
  const masked = await sharp(srcBuf)
    .resize(inner, inner, { fit: 'cover' })
    .composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
    .png()
    .toBuffer();
  const ringSvg =
    `<svg width="${size}" height="${size}">` +
    `<circle cx="${r}" cy="${r}" r="${r - borderW / 2}" fill="none" stroke="black" stroke-width="${borderW}"/>` +
    `</svg>`;
  return await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: masked, left: borderW, top: borderW },
      { input: Buffer.from(ringSvg), left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
}

/** Fetch a YT CDN avatar at a larger size — DB stores `=s88-c-k-...`; bump
 *  to `=s400-` so we have enough resolution for a 280-px circle render. */
async function fetchYtAvatar(url: string): Promise<Buffer | null> {
  const upsized = url.replace(/=s\d+-/, '=s400-');
  try {
    const r = await fetch(upsized);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Build the 2×5 channel logos montage and write it to a PNG.
 *
 * @param avatarUrls — 10 channel avatar URLs in display order. Missing
 *                    URLs render as empty cells.
 * @returns local path to the rendered PNG (1920×1080, white canvas).
 */
export async function composeChannelLogosMontageMG(avatarUrls: (string | null)[]): Promise<string> {
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let i = 0; i < Math.min(avatarUrls.length, LOGOS_GRID_COLS * LOGOS_GRID_ROWS); i++) {
    const url = avatarUrls[i];
    if (!url) continue;
    const srcBuf = await fetchYtAvatar(url);
    if (!srcBuf) continue;
    const circle = await renderCircleAvatar(srcBuf, LOGOS_AVATAR_SIZE, LOGOS_BORDER_W);
    const { cx, cy } = logosTargetCenter(i);
    composites.push({
      input: circle,
      left: Math.round(cx - LOGOS_AVATAR_SIZE / 2),
      top: Math.round(cy - LOGOS_AVATAR_SIZE / 2),
    });
  }

  const outPath = path.join(os.tmpdir(), `mg-logos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: LOGOS_CANVAS_BG },
  })
    .composite(composites)
    .png()
    .toFile(outPath);
  return outPath;
}
