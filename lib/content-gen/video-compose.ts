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
 *   2. Build a per-slot 1080×1920 clip:
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

const COMPOSE_DIR = path.join(CLIPS_DIR, 'producer_renders');

interface ComposeLayer {
  from: string;
  channel?: 'video' | 'voice' | 'fx' | 'overlay';
  fit?: 'contain' | 'cover' | 'fill';
  ken_burns?: 'none' | 'zoom_in_8pct' | 'zoom_out_8pct' | 'pan_left' | 'pan_right';
  url: string | null;
  duration_s: number | null;
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
  __bag__: Record<string, Record<string, Record<string, unknown>>>;
  __job_id__: number;
}

const BG_HEX = { white: '#FFFFFF', dark_gray: '#2A2A2A' } as const;

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

/** Resolve any layer.url to a local file path. Returns null when the layer
 *  is a stub we don't know how to render (audio stubs for now). */
async function resolveLayerToLocalFile(layer: ComposeLayer, bg: 'white' | 'dark_gray', width: number, height: number): Promise<{ kind: 'image' | 'video' | 'skip'; path: string | null }> {
  const url = layer.url ?? '';
  if (!url) return { kind: 'skip', path: null };
  if (url.startsWith('/api/admin/content-gen/yt-capture/file')) {
    const p = await resolveYtCaptureUrl(url);
    if (!p) return { kind: 'skip', path: null };
    // Heuristic: webm = video, anything else = image.
    return { kind: p.endsWith('.webm') ? 'video' : 'image', path: p };
  }
  if (url.startsWith('stub://image_gen/')) {
    const p = await renderStubImage(url, width, height, bg);
    return { kind: 'image', path: p };
  }
  // Audio / unknown stubs — skip in the visual pipeline.
  return { kind: 'skip', path: null };
}

/** Build a single 1080×1920 clip for one slot. Image inputs are looped to
 *  hold_s. Video inputs are trimmed/looped to hold_s. Background = bg_mode. */
async function buildSlotClip(slot_id: string, compose: ResolvedCompose, width: number, height: number, fps: number, outPath: string): Promise<void> {
  // Find the "video" channel layer — that's the main visual.
  const mainLayer = compose.layers.find(l => l.channel === 'video') ?? compose.layers[0];
  if (!mainLayer) throw new Error(`slot ${slot_id}: no video layer`);
  const bg = compose.bg;
  const hold_s = Math.max(0.3, compose.hold_s);

  const resolved = await resolveLayerToLocalFile(mainLayer, bg, width, height);
  if (!resolved.path) {
    // No usable visual — render a placeholder bg-only card.
    const tmp = await renderStubImage(`stub://image_gen/missing/${encodeURIComponent(slot_id)}`, width, height, bg);
    resolved.kind = 'image';
    resolved.path = tmp;
  }

  // Background hex → ffmpeg "0xRRGGBB" color literal.
  const padColor = BG_HEX[bg].replace('#', '0x');

  // For STILL images we want: scale to fill canvas WIDTH (not height) so the
  // YT screenshot occupies the full 1080px wide and the dark gray padding
  // only fills above/below (which we then make smaller by hand-tuned scale).
  // Plus a slow zoom-in (Ken Burns) for cinematic feel.
  //   - Pre-upscale 2× via scale (zoompan needs an oversized input for
  //     smooth sub-pixel zoom without aliasing).
  //   - zoompan: starts at 1.0× zoom, ramps to 1.08× over the hold duration.
  //   - Then re-scale + pad to canvas with bg color.
  const totalFrames = Math.max(2, Math.round(hold_s * fps));
  const stillVf = `scale=${width * 2}:-2:flags=lanczos,` +
                  `zoompan=z='1+0.08*on/${totalFrames}':d=${totalFrames}:s=${width}x${Math.round(width * height / width)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',` +
                  `scale=w=${width}:h=-2:force_original_aspect_ratio=decrease,` +
                  `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1,fps=${fps}`;
  // For VIDEO inputs (scroll_record webm), just pad to canvas without zoom.
  const videoVf = `scale=w='if(gt(a,${width}/${height}),${width},-2)':h='if(gt(a,${width}/${height}),-2,${height})':force_original_aspect_ratio=decrease,` +
                  `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1,fps=${fps}`;

  if (resolved.kind === 'image') {
    await ff([
      '-y', '-loop', '1', '-i', resolved.path,
      '-t', hold_s.toFixed(3),
      '-vf', stillVf,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-preset', 'medium', '-crf', '20',
      outPath,
    ]);
  } else {
    const vf = videoVf;
    // Video input — trim to hold_s (or loop if shorter, simplest).
    await ff([
      '-y',
      '-stream_loop', '-1',     // loop if shorter than hold_s
      '-i', resolved.path,
      '-t', hold_s.toFixed(3),
      '-vf', vf,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-an',                     // strip audio (we'll add later)
      '-preset', 'medium', '-crf', '20',
      outPath,
    ]);
  }
}

/** Top-level entry called by producer-tools.runVideoCompose. */
export async function videoCompose(args: ComposeArgs): Promise<{ file_url: string; duration_s: number; width: number; height: number; local_path: string }> {
  await fs.mkdir(COMPOSE_DIR, { recursive: true });
  const { slot_order, width, height, fps, __bag__: bag, __job_id__: jobId } = args;
  if (!slot_order || slot_order.length === 0) throw new Error('videoCompose: empty slot_order');

  const stageDir = path.join(os.tmpdir(), `producer-${jobId}-${Date.now()}`);
  await fs.mkdir(stageDir, { recursive: true });

  // Stage 1 — build per-slot clips.
  const clipPaths: string[] = [];
  let totalDur = 0;
  for (let i = 0; i < slot_order.length; i++) {
    const sid = slot_order[i];
    const compose = bag[sid]?.__compose__ as unknown as ResolvedCompose | undefined;
    if (!compose) throw new Error(`slot ${sid}: missing resolved compose`);
    const clipPath = path.join(stageDir, `slot-${String(i).padStart(3, '0')}.mp4`);
    await buildSlotClip(sid, compose, width, height, fps, clipPath);
    clipPaths.push(clipPath);
    totalDur += compose.hold_s;
  }

  // Stage 2 — concat with concat demuxer (codec-compatible since we always
  // re-encode with the same H.264 settings above).
  const concatFile = path.join(stageDir, 'concat.txt');
  await fs.writeFile(concatFile, clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const outName = `job-${jobId}-${Date.now()}.mp4`;
  const outPath = path.join(COMPOSE_DIR, outName);
  await ff([
    '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-c', 'copy',
    outPath,
  ]).catch(async () => {
    // Fallback: re-encode concat (slower but bulletproof if codecs drift).
    await ff([
      '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-preset', 'medium', '-crf', '20',
      outPath,
    ]);
  });

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
