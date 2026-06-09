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
export async function composeAboutPanelMG(srcPath: string, joined: BBox): Promise<string> {
  // 1. Compute crop bounds from joined_date anchor.
  const cropX = Math.max(0, joined.x - 44);
  const cropY = Math.max(0, joined.y - 110);
  const cropW = joined.w + 308;
  const cropH = 372;

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
  return outPath;
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
const PANO_OUTER_BG = { r: 60, g: 60, b: 60 };    // MG dark canvas
const PANO_CARD_BG  = { r: 13, g: 13, b: 13 };    // near-black inner card
const PANO_CARD_W = 1500;                          // ~78% of 1920
const PANO_CARD_RADIUS = 36;
const PANO_CARD_MARGIN_X = (CANVAS_W - PANO_CARD_W) / 2;  // 210px
const PANO_CARD_MARGIN_Y_TOP = 60;                         // card starts 60px from top
const PANO_CARD_MARGIN_Y_BOT = 60;
const PANO_INNER_PAD = 30;

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
