/**
 * Crop a YT screenshot to a bbox region with optional padding.
 *
 * The MG-decoded timeline (`mg-decoded-visual-timeline.json`) reveals that
 * channel_proof_1/_2 and top_video_callout aren't full channel/about page
 * screenshots — they're tight CROPS of just the stats box (about modal) or
 * just the single popular-video card. The yellow highlight is overlaid on
 * the cropped close-up, not on the full page.
 *
 * Our yt-capture.ts already extracts every bbox we need
 * (subscriber_count, total_views, video_count, joined_date, channel_avatar,
 * channel_name, video_card_N, video_thumb_N, video_views_N, video_title_N).
 * This module is the consumer side — read a bbox + crop the cached PNG.
 *
 * Output is written to a temp PNG so video-compose can ffmpeg it like any
 * other still image (Ken Burns / pad / etc. all keep working).
 */

import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { getPool } from '../db';

export interface BBox { x: number; y: number; w: number; h: number; }
export type BBoxMap = Record<string, BBox>;

/** Pull the bbox map for one yt-capture row. Returns {} if the row doesn't
 *  exist or has no bboxes (e.g. it was a watch_page that didn't extract). */
export async function loadBBoxes(captureId: number): Promise<BBoxMap> {
  const pool = await getPool();
  const r = await pool.query<{ bboxes_jsonb: BBoxMap | null }>(
    `SELECT bboxes_jsonb FROM content_gen_yt_screens WHERE id=$1`, [captureId],
  );
  return r.rows[0]?.bboxes_jsonb ?? {};
}

export async function loadLocalPath(captureId: number): Promise<string | null> {
  const pool = await getPool();
  const r = await pool.query<{ local_path: string | null }>(
    `SELECT local_path FROM content_gen_yt_screens WHERE id=$1`, [captureId],
  );
  return r.rows[0]?.local_path ?? null;
}

/** Extract a bbox region from a PNG. Pads `pad` px around the bbox (clamped
 *  to image bounds) so the crop has visual breathing room — MG does this
 *  consistently. Returns path to a temp PNG. */
export async function cropToBBox(srcPath: string, bbox: BBox, opts: { pad?: number } = {}): Promise<string> {
  const pad = opts.pad ?? 24;
  const meta = await sharp(srcPath).metadata();
  const W = meta.width ?? 1440;
  const H = meta.height ?? 900;
  const left   = Math.max(0, Math.round(bbox.x - pad));
  const top    = Math.max(0, Math.round(bbox.y - pad));
  const right  = Math.min(W, Math.round(bbox.x + bbox.w + pad));
  const bottom = Math.min(H, Math.round(bbox.y + bbox.h + pad));
  const width  = Math.max(2, right - left);
  const height = Math.max(2, bottom - top);
  const outPath = path.join(os.tmpdir(), `cropbbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await sharp(srcPath).extract({ left, top, width, height }).png().toFile(outPath);
  return outPath;
}

/** Crop AROUND a bbox into a "stats card" sized region — useful for
 *  channel_proof_1 / _2 where MG shows the entire about-modal stats block
 *  rather than just the single line. Includes a bigger pad + tries to also
 *  capture surrounding context lines if they fit. */
export async function cropStatsBox(srcPath: string, bbox: BBox, opts: { padX?: number; padY?: number } = {}): Promise<string> {
  // Generous padding — about-modal stats box is usually 300-400px wide; the
  // individual line bbox is ~80-120px so we pad a lot to capture the
  // surrounding context (icon, label, value column).
  const padX = opts.padX ?? 120;
  const padY = opts.padY ?? 80;
  return cropToBBox(srcPath, bbox, { pad: Math.max(padX, padY) });
}

/** Resolve the bbox map key for a logical crop_target — handles aliases
 *  and per-card targets. */
export function bboxKeyFor(target: string): string | null {
  // Identity match for known keys.
  const known = new Set([
    'subscriber_count', 'video_count', 'total_views', 'joined_date',
    'channel_name', 'channel_avatar',
  ]);
  if (known.has(target)) return target;
  // Per-card targets: card_0 → video_card_0
  if (/^card_\d+$/.test(target)) return `video_${target}`;
  if (/^video_(card|thumb|views|title)_\d+$/.test(target)) return target;
  // First card by default
  if (target === 'top_video_card') return 'video_card_0';
  if (target === 'top_video_views') return 'video_views_0';
  if (target === 'top_video_title') return 'video_title_0';
  if (target === 'top_video_thumb') return 'video_thumb_0';
  return null;
}
