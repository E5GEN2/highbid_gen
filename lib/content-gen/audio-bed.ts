/**
 * Audio bed composer — narration + music bed + per-segment SFX → one MP3.
 *
 * The locked tri-track timeline already tells us EXACTLY:
 *   - which narration MP3 plays at t_start (audio_path + audio_duration_s)
 *   - which music token underlies the segment (visual.audio.music)
 *   - which SFX fire at t_start (visual.audio.sfx[])
 *
 * Strategy (single ffmpeg invocation, lossless intermediate):
 *   1. For each segment, gather inputs:
 *        - narration WAV at t_start (delay → adelay)
 *        - SFX one-shot at t_start (delay)
 *        - music: a continuous bed track underneath. We loop a single
 *          "bed" asset for the whole duration, ducked under narration
 *          via sidechain compress (cheap proxy: amix weights).
 *   2. Mix everything with amix, normalize, encode to mp3.
 *
 * Output: /data/clips/group_audio/{groupKey-hash}.mp3 + cached, plus the
 * segments-with-audio metadata so the render stage knows what the mix looks
 * like.
 */

import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { getPool } from '../db';
import { CLIPS_DIR } from '../clips-dir';
import { getSfx, TOKENS } from './sfx';
import type { ReflowedTimeline, ReflowedSegment } from './voice-reflow';

const BED_DIR = path.join(CLIPS_DIR, 'group_audio');

export interface AudioBedResult {
  group_key: string;
  audio_path: string;            // /data/.../foo.mp3
  audio_url: string;             // /api/admin/content-gen/audio/file?hash=…
  audio_hash: string;
  duration_s: number;
  segments_voiced: number;
  segments_with_sfx: number;
  cached: boolean;
}

function hashGroup(groupKey: string, timelineSig: string): string {
  return crypto.createHash('sha256').update(`${groupKey}|${timelineSig}`).digest('hex').slice(0, 32);
}

function timelineSignature(tl: ReflowedTimeline): string {
  // Compact signature: voice hashes + SFX tokens + timings.
  const parts = tl.segments.map(s => `${s.t_start.toFixed(1)}|${s.voice_hash ?? '-'}|${(s.audio?.sfx ?? []).join(',')}|${s.audio?.music ?? '-'}`).join('\n');
  return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

/** Run ffmpeg with arg array, capture stderr, throw on non-zero. */
function ff(args: string[], timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`ffmpeg timeout`)); }, timeoutMs);
    p.on('close', c => { clearTimeout(t); c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err.slice(0, 300)}`)); });
    p.on('error', e => { clearTimeout(t); reject(e); });
  });
}

/**
 * Compose the full audio bed for one group's locked timeline. Idempotent:
 * (group_key + timeline signature) maps to a single cached MP3.
 */
export async function composeAudioBed(groupKey: string, timeline: ReflowedTimeline, opts: { force?: boolean } = {}): Promise<AudioBedResult> {
  await fs.mkdir(BED_DIR, { recursive: true });
  const tlSig = timelineSignature(timeline);
  const groupHash = hashGroup(groupKey, tlSig);
  const outPath = path.join(BED_DIR, `${groupHash}.mp3`);

  // Cache check.
  if (!opts.force) {
    try {
      const st = await fs.stat(outPath);
      if (st.size > 0) {
        const dur = timeline.duration_s;
        return {
          group_key: groupKey, audio_path: outPath,
          audio_url: `/api/admin/content-gen/audio/file?hash=${groupHash}`,
          audio_hash: groupHash, duration_s: dur,
          segments_voiced: timeline.segments.filter(s => s.audio_duration_s).length,
          segments_with_sfx: timeline.segments.filter(s => (s.audio?.sfx?.length ?? 0) > 0).length,
          cached: true,
        };
      }
    } catch { /* not cached */ }
  }

  // Resolve voice paths from hashes.
  const pool = await getPool();
  const voiceHashes = Array.from(new Set(timeline.segments.map(s => s.voice_hash).filter((h): h is string => !!h)));
  let voicePaths = new Map<string, string>();
  if (voiceHashes.length > 0) {
    const r = await pool.query<{ text_hash: string; local_path: string }>(
      `SELECT text_hash, local_path FROM content_gen_voice_assets WHERE text_hash = ANY($1::text[])`,
      [voiceHashes],
    );
    voicePaths = new Map(r.rows.map(x => [x.text_hash, x.local_path]));
  }

  // Pre-warm all SFX tokens we'll actually use (cache or generate).
  const sfxTokens = new Set<string>();
  for (const s of timeline.segments) for (const t of (s.audio?.sfx ?? [])) if (TOKENS[t]) sfxTokens.add(t);
  const sfxPaths = new Map<string, string>();
  for (const tk of sfxTokens) {
    try { const a = await getSfx(tk); sfxPaths.set(tk, a.local_path); }
    catch { /* skip missing — render continues without it */ }
  }
  // Music bed — single looping asset we duck under speech.
  let bedPath: string | null = null;
  try { bedPath = (await getSfx('bed', 30)).local_path; } catch { bedPath = null; }

  // Build ffmpeg graph.
  //   [0] silence base of full duration → guarantees a track exists even if all assets fail
  //   [1..] narration WAVs (mono, mp3) with adelay
  //   [..] sfx one-shots with adelay
  //   [last] looped bed, volume reduced to act as ducked bed (-7 dB ≈ 0.45)
  const fullMs = Math.round(timeline.duration_s * 1000);

  const inputs: string[] = [];
  const filters: string[] = [];
  const mixLabels: string[] = [];
  let voiced = 0, withSfx = 0;

  // 0: anull base track
  inputs.push('-f', 'lavfi', '-t', String(timeline.duration_s), '-i', 'anullsrc=r=44100:cl=stereo');
  filters.push(`[0:a]anull[base]`);
  mixLabels.push('[base]');

  // Narration tracks
  let inputIdx = 1;
  for (const seg of timeline.segments) {
    if (!seg.voice_hash || !seg.audio_duration_s) continue;
    const p = voicePaths.get(seg.voice_hash);
    if (!p) continue;
    inputs.push('-i', p);
    const lbl = `v${inputIdx}`;
    const delayMs = Math.max(0, Math.round(seg.t_start * 1000));
    filters.push(`[${inputIdx}:a]aformat=channel_layouts=stereo,adelay=${delayMs}|${delayMs}[${lbl}]`);
    mixLabels.push(`[${lbl}]`);
    inputIdx++; voiced++;
  }

  // SFX one-shots
  for (const seg of timeline.segments) {
    const sfx = seg.audio?.sfx ?? [];
    if (sfx.length === 0) continue;
    let any = false;
    for (let k = 0; k < sfx.length; k++) {
      const tk = sfx[k];
      const p = sfxPaths.get(tk);
      if (!p) continue;
      inputs.push('-i', p);
      const lbl = `s${inputIdx}`;
      // small per-sfx stagger so 2-sfx beats don't perfectly overlap
      const delayMs = Math.max(0, Math.round((seg.t_start + k * 0.12) * 1000));
      // SFX a touch louder than bed
      filters.push(`[${inputIdx}:a]aformat=channel_layouts=stereo,adelay=${delayMs}|${delayMs},volume=0.9[${lbl}]`);
      mixLabels.push(`[${lbl}]`);
      inputIdx++; any = true;
    }
    if (any) withSfx++;
  }

  // Music bed: loop the bed to full duration, low volume
  if (bedPath) {
    inputs.push('-stream_loop', '-1', '-i', bedPath);
    filters.push(`[${inputIdx}:a]aformat=channel_layouts=stereo,volume=0.18,atrim=0:${timeline.duration_s},asetpts=N/SR/TB[bed]`);
    mixLabels.push('[bed]');
    inputIdx++;
  }

  // Mix.
  filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0,alimiter=limit=0.95[out]`);

  const args: string[] = [
    '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-t', String(timeline.duration_s),
    '-c:a', 'libmp3lame', '-b:a', '192k',
    outPath,
  ];

  await ff(args);

  return {
    group_key: groupKey,
    audio_path: outPath,
    audio_url: `/api/admin/content-gen/audio/file?hash=${groupHash}`,
    audio_hash: groupHash,
    duration_s: timeline.duration_s,
    segments_voiced: voiced,
    segments_with_sfx: withSfx,
    cached: false,
  };
}

/** Read a composed bed off the volume (for the serve endpoint). */
export async function readAudioBedFile(hash: string): Promise<{ buf: Buffer; contentType: string } | null> {
  const p = path.join(BED_DIR, `${hash}.mp3`);
  try {
    const buf = await fs.readFile(p);
    return { buf, contentType: 'audio/mpeg' };
  } catch { return null; }
}

// Re-export ReflowedSegment so route handlers don't double-import voice-reflow.
export type { ReflowedSegment };
