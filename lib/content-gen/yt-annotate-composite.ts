/**
 * Post-process annotation compositor.
 *
 * Takes a captured PNG + a bbox + a shape spec and draws richer annotations
 * than DOM-CSS can produce: sharpie-style hand-drawn circles, curved arrows
 * with labels, glow rings, dashed strokes. The bbox is the locate signal
 * (extracted by the DOM walker in yt-capture.ts); this module is purely the
 * rendering stage — no DOM, no Playwright.
 *
 * Why a compositor vs. CSS-on-element:
 *   - CSS `border-radius: 50%` on a text span stretches into an ellipse, not
 *     a hand-drawn circle around the text.
 *   - CSS can't originate an arrow from OUTSIDE the element's box.
 *   - CSS can't do multi-stroke "sharpie" effects or curved bezier shapes.
 *
 * Implementation: build a single SVG that covers the full PNG viewport, draw
 * the shape, composite onto the PNG via Sharp. Output a new PNG. No on-disk
 * temp files — buffers all the way.
 */

import sharp from 'sharp';
import type { BBox } from './yt-capture';

/** All composite shapes we know how to draw. */
export type CompositeShape =
  | 'sharpie_circle'
  | 'arrow'
  | 'circle_with_label'
  | 'glow_ring'
  | 'underline';

/** Direction the arrow points FROM (the arrow tip lands on the bbox). */
export type ArrowOrigin = 'top' | 'bottom' | 'left' | 'right' | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';

export interface CompositeSpec {
  shape: CompositeShape;
  /** Hex color (`#FACC15` is our standard money-yellow). */
  color?: string;
  /** Stroke width in px. Default per-shape. */
  stroke?: number;
  /** Optional label text (for `circle_with_label`). */
  label?: string;
  /** For `arrow`: which side of the bbox the arrow originates from. */
  arrow_from?: ArrowOrigin;
  /** Random seed for the wobble — exposed so callers can lock a specific
   *  "hand-drawn" look across reruns of the same capture. Default: hash of
   *  the bbox so re-running the same capture yields the same shape. */
  seed?: number;
}

const DEFAULT_COLOR = '#FACC15';

/** Deterministic LCG so the "wobble" of a sharpie circle is repeatable per
 *  bbox. We don't use Math.random() — same input must always produce the same
 *  shape so re-renders don't visually drift. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
}

/** Seed derived from bbox coordinates — different bboxes get different
 *  wobbles, but the same bbox always gets the same wobble. */
function defaultSeed(b: BBox): number {
  return ((b.x * 73856093) ^ (b.y * 19349663) ^ (b.w * 83492791) ^ (b.h * 2654435761)) >>> 0;
}

/**
 * Build an irregular-sharpie circle SVG path that wraps around the bbox.
 *
 *   - Larger than the bbox by `pad` on every side
 *   - Slight random wobble per control point (deterministic via seed)
 *   - 2-3 overlapping strokes with slight offsets — gives the "drew it
 *     twice with a Sharpie" look you see in tutorial annotations
 *
 * Returns the inner SVG markup (no <svg> wrapper) so it can be combined
 * with arrows/labels in one overlay.
 */
function drawSharpieCircle(b: BBox, color: string, stroke: number, seed: number, pad = 18): string {
  const rng = makeRng(seed);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  // Make the circle a bit wider than tall, scaled by element aspect — for a
  // short wide text like "527,506 views", the natural sharpie circle is an
  // ellipse. For more square-ish targets it'll trend toward round.
  const rx = b.w / 2 + pad;
  const ry = b.h / 2 + pad + Math.max(0, b.w * 0.05 - b.h * 0.05);  // bias to ellipse when wide
  // Build the path as 12 bezier segments around the ellipse, with each
  // control point nudged by ±wobble for the hand-drawn feel.
  const N = 12;
  const wobble = Math.min(6, Math.max(2, Math.min(rx, ry) * 0.06));
  type Pt = { x: number; y: number };
  const pts: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const wx = (rng() - 0.5) * 2 * wobble;
    const wy = (rng() - 0.5) * 2 * wobble;
    pts.push({ x: cx + Math.cos(t) * rx + wx, y: cy + Math.sin(t) * ry + wy });
  }
  // Smooth path via cubic beziers between successive points, with control
  // points offset by ~1/3 segment length tangentially.
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} `;
  for (let i = 1; i <= N; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    // simple smooth — direct quad-style with control midway
    const mx = (p0.x + p1.x) / 2 + (rng() - 0.5) * 3;
    const my = (p0.y + p1.y) / 2 + (rng() - 0.5) * 3;
    d += `Q ${mx.toFixed(1)} ${my.toFixed(1)} ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} `;
  }
  d += 'Z';
  // Two overlapping strokes — slight offset on the second, slightly thinner.
  // Combined effect reads as "thick imperfect circle drawn twice".
  const d2 = d
    .replace(/(\d+\.\d+) (\d+\.\d+)/g, (_, a: string, c: string) => {
      const ax = parseFloat(a) + (rng() - 0.5) * 4;
      const cy_ = parseFloat(c) + (rng() - 0.5) * 4;
      return `${ax.toFixed(1)} ${cy_.toFixed(1)}`;
    });
  return `
    <path d="${d}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" opacity="0.95" />
    <path d="${d2}" fill="none" stroke="${color}" stroke-width="${Math.max(2, stroke - 2)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.7" />
  `;
}

/**
 * Curved arrow from the indicated `origin` toward the bbox. Tip lands a few
 * px outside the bbox so the arrow points AT the element, not into it.
 */
function drawArrow(b: BBox, color: string, stroke: number, vpW: number, vpH: number, origin: ArrowOrigin, seed: number): string {
  const rng = makeRng(seed);
  // Tip = a point just outside the bbox on the side closest to `origin`.
  // Tail = a point well outside the bbox in the `origin` direction, anchored
  // away from the viewport edges so the arrow stays in frame.
  let tipX = b.x + b.w / 2, tipY = b.y + b.h / 2;
  let tailX = tipX, tailY = tipY;
  const tipOffset = 12;       // how far outside the bbox the tip sits
  const tailDistance = 140;   // how far the tail starts from the tip
  switch (origin) {
    case 'top':
      tipX = b.x + b.w / 2; tipY = b.y - tipOffset;
      tailX = tipX + (rng() - 0.5) * 40; tailY = tipY - tailDistance;
      break;
    case 'bottom':
      tipX = b.x + b.w / 2; tipY = b.y + b.h + tipOffset;
      tailX = tipX + (rng() - 0.5) * 40; tailY = tipY + tailDistance;
      break;
    case 'left':
      tipX = b.x - tipOffset; tipY = b.y + b.h / 2;
      tailX = tipX - tailDistance; tailY = tipY + (rng() - 0.5) * 40;
      break;
    case 'right':
      tipX = b.x + b.w + tipOffset; tipY = b.y + b.h / 2;
      tailX = tipX + tailDistance; tailY = tipY + (rng() - 0.5) * 40;
      break;
    case 'top_left':
      tipX = b.x - tipOffset / 2; tipY = b.y - tipOffset / 2;
      tailX = tipX - tailDistance * 0.7; tailY = tipY - tailDistance * 0.7;
      break;
    case 'top_right':
      tipX = b.x + b.w + tipOffset / 2; tipY = b.y - tipOffset / 2;
      tailX = tipX + tailDistance * 0.7; tailY = tipY - tailDistance * 0.7;
      break;
    case 'bottom_left':
      tipX = b.x - tipOffset / 2; tipY = b.y + b.h + tipOffset / 2;
      tailX = tipX - tailDistance * 0.7; tailY = tipY + tailDistance * 0.7;
      break;
    case 'bottom_right':
      tipX = b.x + b.w + tipOffset / 2; tipY = b.y + b.h + tipOffset / 2;
      tailX = tipX + tailDistance * 0.7; tailY = tipY + tailDistance * 0.7;
      break;
  }
  // Clamp tail inside viewport.
  tailX = Math.max(20, Math.min(vpW - 20, tailX));
  tailY = Math.max(20, Math.min(vpH - 20, tailY));
  // Control point for the curve — perpendicular to the line, biased to feel
  // hand-drawn (not a straight ruler line).
  const midX = (tipX + tailX) / 2;
  const midY = (tipY + tailY) / 2;
  const dx = tipX - tailX, dy = tipY - tailY;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;  // perpendicular unit
  const curveAmount = Math.min(60, len * 0.25) * (rng() < 0.5 ? 1 : -1);
  const ctrlX = midX + nx * curveAmount;
  const ctrlY = midY + ny * curveAmount;
  // Arrowhead — two short strokes forming the V at the tip.
  // Tangent direction at tip (derivative of quadratic curve at t=1 ≈ tip - ctrl).
  const tdx = tipX - ctrlX, tdy = tipY - ctrlY;
  const tlen = Math.hypot(tdx, tdy) || 1;
  const ux = tdx / tlen, uy = tdy / tlen;
  // Rotate ±150° to get the two arrowhead wings.
  const headLen = 18;
  const a1 = Math.PI * 5 / 6;  // 150°
  const cosA = Math.cos(a1), sinA = Math.sin(a1);
  const w1x = tipX - (ux * cosA - uy * sinA) * headLen;
  const w1y = tipY - (ux * sinA + uy * cosA) * headLen;
  const w2x = tipX - (ux * cosA + uy * sinA) * headLen;
  const w2y = tipY - (-ux * sinA + uy * cosA) * headLen;
  return `
    <path d="M ${tailX.toFixed(1)} ${tailY.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)} ${tipX.toFixed(1)} ${tipY.toFixed(1)}"
          fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" />
    <path d="M ${w1x.toFixed(1)} ${w1y.toFixed(1)} L ${tipX.toFixed(1)} ${tipY.toFixed(1)} L ${w2x.toFixed(1)} ${w2y.toFixed(1)}"
          fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" />
  `;
}

/** Solid yellow glow ring — outer halo + thinner inner border. Pure SVG so
 *  it composites smoothly over any background. */
function drawGlowRing(b: BBox, color: string, stroke: number): string {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const rx = b.w / 2 + 14;
  const ry = b.h / 2 + 14;
  return `
    <defs>
      <radialGradient id="glow-${b.x}-${b.y}" cx="50%" cy="50%" r="50%">
        <stop offset="60%" stop-color="${color}" stop-opacity="0"/>
        <stop offset="85%" stop-color="${color}" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx + 12}" ry="${ry + 12}" fill="url(#glow-${b.x}-${b.y})"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${color}" stroke-width="${stroke}" opacity="0.9"/>
  `;
}

/** Underline stroke — fat marker stroke under the text. Useful for joined_date
 *  / channel names where a circle would be too busy. Drawn as a thick
 *  highlighter-style band UNDER the text, plus a thinner stroke above for the
 *  "two-pass marker" feel. Punchy enough to read at 1080p mobile-Shorts. */
function drawUnderline(b: BBox, color: string, stroke: number): string {
  const y = b.y + b.h + 6;
  const x1 = b.x - 6, x2 = b.x + b.w + 6;
  const mx = (x1 + x2) / 2;
  const bandH = Math.max(8, stroke * 1.6);
  return `
    <rect x="${x1}" y="${y - bandH / 2}" width="${x2 - x1}" height="${bandH}" rx="${bandH / 2}" ry="${bandH / 2}" fill="${color}" opacity="0.6"/>
    <path d="M ${x1} ${y} Q ${mx} ${y + 3} ${x2} ${y - 1}"
          fill="none" stroke="${color}" stroke-width="${stroke + 2}" stroke-linecap="round" opacity="0.95"/>
    <path d="M ${x1 + 2} ${y + 3} Q ${mx + 2} ${y + 6} ${x2 - 2} ${y + 1}"
          fill="none" stroke="${color}" stroke-width="${Math.max(2, stroke - 1)}" stroke-linecap="round" opacity="0.55"/>
  `;
}

/** Circle + label callout. The label sits a few px from the circle in the
 *  configurable direction, with a thin leader line. */
function drawCircleWithLabel(b: BBox, color: string, stroke: number, label: string, vpW: number, vpH: number, seed: number): string {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  // Pick a label position — to the right if there's room, else above.
  const rxC = b.w / 2 + 18;
  const labelW = label.length * 11 + 24;
  const labelH = 32;
  let labelX = b.x + b.w + 22;
  let labelY = cy - labelH / 2;
  let leaderFromX = b.x + b.w + 18;
  let leaderFromY = cy;
  if (labelX + labelW > vpW - 12) {
    // not enough room right — try above
    labelX = Math.max(12, cx - labelW / 2);
    labelY = Math.max(12, b.y - labelH - 18);
    leaderFromX = cx;
    leaderFromY = b.y - 6;
  }
  return `
    ${drawSharpieCircle(b, color, stroke, seed, 14)}
    <line x1="${leaderFromX}" y1="${leaderFromY}" x2="${labelX + (labelX > b.x + b.w ? 4 : labelW / 2)}" y2="${labelX > b.x + b.w ? labelY + labelH / 2 : labelY + labelH}" stroke="${color}" stroke-width="3" stroke-linecap="round" opacity="0.95"/>
    <rect x="${labelX}" y="${labelY}" width="${labelW}" height="${labelH}" rx="6" ry="6" fill="#FFFFFF" stroke="${color}" stroke-width="3"/>
    <text x="${labelX + labelW / 2}" y="${labelY + labelH / 2 + 6}" font-family="system-ui, -apple-system, Roboto, sans-serif" font-size="18" font-weight="700" text-anchor="middle" fill="#111">${label.replace(/[<>&]/g, '')}</text>
  `;
}

/**
 * Apply a composite annotation onto a captured PNG.
 *
 *   pngIn:  full PNG buffer (typically 1440x900)
 *   bbox:   target element bbox (from DOM walker; pixel-anchored to the PNG)
 *   spec:   shape + style spec
 *
 * Returns a new PNG buffer with the annotation drawn ON TOP.
 *
 * Multiple specs can be composited by calling this repeatedly with the same
 * bbox or different ones — each call adds another SVG overlay.
 */
export async function applyComposite(pngIn: Buffer, bbox: BBox, spec: CompositeSpec): Promise<Buffer> {
  const meta = await sharp(pngIn).metadata();
  const vpW = meta.width ?? 1440;
  const vpH = meta.height ?? 900;
  const color = spec.color || DEFAULT_COLOR;
  const seed = spec.seed ?? defaultSeed(bbox);
  let shapeSvg = '';
  switch (spec.shape) {
    case 'sharpie_circle':
      shapeSvg = drawSharpieCircle(bbox, color, spec.stroke ?? 6, seed);
      break;
    case 'arrow':
      shapeSvg = drawArrow(bbox, color, spec.stroke ?? 5, vpW, vpH, spec.arrow_from || 'top_right', seed);
      break;
    case 'circle_with_label':
      shapeSvg = drawCircleWithLabel(bbox, color, spec.stroke ?? 5, spec.label || '', vpW, vpH, seed);
      break;
    case 'glow_ring':
      shapeSvg = drawGlowRing(bbox, color, spec.stroke ?? 5);
      break;
    case 'underline':
      shapeSvg = drawUnderline(bbox, color, spec.stroke ?? 6);
      break;
  }
  const overlay = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${vpW}" height="${vpH}" viewBox="0 0 ${vpW} ${vpH}">${shapeSvg}</svg>`;
  return sharp(pngIn)
    .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/** Compose multiple shapes onto one PNG. Each pair is rendered in order, so
 *  later shapes appear on top of earlier ones. Useful for circle+arrow on
 *  the same element, or two annotations on different elements in one frame. */
export async function applyCompositeMulti(pngIn: Buffer, layers: Array<{ bbox: BBox; spec: CompositeSpec }>): Promise<Buffer> {
  if (layers.length === 0) return pngIn;
  const meta = await sharp(pngIn).metadata();
  const vpW = meta.width ?? 1440;
  const vpH = meta.height ?? 900;
  const parts: string[] = [];
  for (const { bbox, spec } of layers) {
    const color = spec.color || DEFAULT_COLOR;
    const seed = spec.seed ?? defaultSeed(bbox);
    switch (spec.shape) {
      case 'sharpie_circle': parts.push(drawSharpieCircle(bbox, color, spec.stroke ?? 6, seed)); break;
      case 'arrow':          parts.push(drawArrow(bbox, color, spec.stroke ?? 5, vpW, vpH, spec.arrow_from || 'top_right', seed)); break;
      case 'circle_with_label': parts.push(drawCircleWithLabel(bbox, color, spec.stroke ?? 5, spec.label || '', vpW, vpH, seed)); break;
      case 'glow_ring':      parts.push(drawGlowRing(bbox, color, spec.stroke ?? 5)); break;
      case 'underline':      parts.push(drawUnderline(bbox, color, spec.stroke ?? 6)); break;
    }
  }
  const overlay = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${vpW}" height="${vpH}" viewBox="0 0 ${vpW} ${vpH}">${parts.join('\n')}</svg>`;
  return sharp(pngIn)
    .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
