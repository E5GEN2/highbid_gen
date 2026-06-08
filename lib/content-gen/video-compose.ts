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

const COMPOSE_DIR = path.join(CLIPS_DIR, 'producer_renders');

interface ComposeLayer {
  from: string;
  channel?: 'video' | 'voice' | 'fx' | 'overlay';
  fit?: 'contain' | 'cover' | 'fill';
  ken_burns?: 'none' | 'zoom_in_8pct' | 'zoom_out_8pct' | 'pan_left' | 'pan_right';
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
      const { loadBBoxes, bboxKeyFor, cropToBBox } = await import('./yt-crop');
      const bboxes = await loadBBoxes(captureId);
      const key = bboxKeyFor(layer.crop_target);
      if (key && bboxes[key]) {
        const cropped = await cropToBBox(basePath, bboxes[key], { pad: 32 });
        return { kind: 'image', path: cropped };
      }
      // bbox missing — log + fall through to full image.
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
  const stillVf = `scale=${width * 2}:-2:flags=lanczos,` +
                  `zoompan=z='1+0.08*on/${totalFrames}':d=${totalFrames}:s=${width}x${Math.round(width * height / width)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',` +
                  `scale=w=${width}:h=-2:force_original_aspect_ratio=decrease,` +
                  `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1,fps=${fps}`;
  const videoVf = `scale=w='if(gt(a,${width}/${height}),${width},-2)':h='if(gt(a,${width}/${height}),-2,${height})':force_original_aspect_ratio=decrease,` +
                  `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1,fps=${fps}`;

  // Build the visual track first as a silent intermediate; then mux audio
  // in a second pass. Keeps the filtergraph simple and lets us pad audio
  // with silence to match hold_s exactly.
  const silentPath = path.join(path.dirname(outPath), `silent-${path.basename(outPath)}`);
  if (resolved.kind === 'image') {
    await ff([
      '-y', '-loop', '1', '-i', resolved.path,
      '-t', hold_s.toFixed(3),
      '-vf', stillVf,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-preset', 'medium', '-crf', '20',
      silentPath,
    ]);
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

  // Mux audio. Three cases:
  //   1. voice + fx → amix both, pad to hold_s, trim, encode AAC
  //   2. voice only → format voice to stereo, pad/trim to hold_s
  //   3. neither   → silent AAC stream so all slots have consistent audio
  if (voicePath && fxPath) {
    await ff([
      '-y', '-i', silentPath, '-i', voicePath, '-i', fxPath,
      '-filter_complex',
        `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=1.0[v1];` +
        `[2:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.7[v2];` +
        `[v1][v2]amix=inputs=2:duration=longest:dropout_transition=0,` +
        `apad=pad_dur=${hold_s.toFixed(3)},atrim=0:${hold_s.toFixed(3)}[aout]`,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
      outPath,
    ]);
  } else if (voicePath) {
    await ff([
      '-y', '-i', silentPath, '-i', voicePath,
      '-filter_complex', `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,apad=pad_dur=${hold_s.toFixed(3)},atrim=0:${hold_s.toFixed(3)}[aout]`,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
      outPath,
    ]);
  } else if (fxPath) {
    await ff([
      '-y', '-i', silentPath, '-i', fxPath,
      '-filter_complex', `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,apad=pad_dur=${hold_s.toFixed(3)},atrim=0:${hold_s.toFixed(3)}[aout]`,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
      outPath,
    ]);
  } else {
    await ff([
      '-y', '-i', silentPath,
      '-f', 'lavfi', '-t', hold_s.toFixed(3), '-i', 'anullsrc=cl=stereo:r=44100',
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
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

  // Stage 2 — concat with concat demuxer.
  const concatFile = path.join(stageDir, 'concat.txt');
  await fs.writeFile(concatFile, clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const concatPath = path.join(stageDir, 'concat.mp4');
  await ff([
    '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-c', 'copy',
    concatPath,
  ]).catch(async () => {
    await ff([
      '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-preset', 'medium', '-crf', '20',
      concatPath,
    ]);
  });

  // Stage 3 — music bed pass. Generate a music track for the total duration,
  // mix UNDER voice+sfx with ducking. Per the audio-sfx spec the bed is
  // -6dB under voice with 200ms release. We use a simple amix with weights
  // (sidechain compress would be ideal but adds a lot of filter complexity).
  // music_token=null disables the bed entirely.
  const outName = `job-${jobId}-${Date.now()}.mp4`;
  const outPath = path.join(COMPOSE_DIR, outName);
  const musicToken = (args.music_token === undefined ? 'bed' : args.music_token) || null;
  if (musicToken) {
    try {
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
    } catch (e) {
      // Music bed is best-effort — log and fall back to concat without bed.
      console.warn(`[producer:music-bed] failed for token=${musicToken}: ${(e as Error).message}`);
      await fs.copyFile(concatPath, outPath);
    }
  } else {
    await fs.copyFile(concatPath, outPath);
  }

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
