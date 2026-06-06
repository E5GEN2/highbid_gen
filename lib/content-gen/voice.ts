/**
 * Voice stage — ElevenLabs TTS for the narration script (Stage D.3).
 *
 * Turns each spoken segment in the tri-track timeline into a real WAV/MP3
 * with a MEASURED duration, then exposes the duration so the timeline can
 * reflow its hold_s values to match. This is the timing-truth layer:
 * everything downstream renders against actual audio length, not the
 * words/2.8 estimate.
 *
 *   spoken segment  ──TTS──►  cached MP3 + duration (ffprobe)
 *                                   │
 *                                   ▼
 *                          reflow timeline.hold_s
 *
 * Per-beat caching: SHA256(text + voice_id + model + settings) → /data/clips/
 * tts/{hash}.mp3. Identical text on a re-run is a free disk hit. We persist
 * the asset metadata in content_gen_voice_assets so we can clean up later.
 *
 * Default voice: Daniel (onwK4e9ZLuTAKqWW03F9) — "Steady Broadcaster,
 * informative/educational, middle-aged British male" — closest match to
 * the calm matter-of-fact documentary narrator the spec specifies. Model
 * eleven_multilingual_v2 (production-quality, supports all 11labs features).
 */

import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { getPool } from '../db';
import { CLIPS_DIR } from '../clips-dir';

const TTS_DIR = path.join(CLIPS_DIR, 'tts');
const ELEVENLABS_API = 'https://api.elevenlabs.io/v1';

/** Daniel — Steady Broadcaster, informative_educational. The default
 *  Class-B narrator (calm, mid-pitch, documentary). */
export const DEFAULT_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9';
export const DEFAULT_MODEL = 'eleven_multilingual_v2';
export const DEFAULT_SETTINGS = {
  stability: 0.55,
  similarity_boost: 0.75,
  style: 0.2,
  use_speaker_boost: true,
};

export interface VoiceOpts {
  voice_id?: string;
  model_id?: string;
  settings?: Record<string, number | boolean>;
}

export interface VoiceAsset {
  text_hash: string;
  text: string;
  voice_id: string;
  model_id: string;
  local_path: string;
  duration_s: number;
  bytes: number;
  char_count: number;
  cached: boolean;
}

async function getElevenLabsKey(): Promise<string> {
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'elevenlabs_api_key' LIMIT 1`,
  );
  const key = r.rows[0]?.value?.trim();
  if (!key) throw new Error('elevenlabs_api_key not configured in admin_config');
  return key;
}

function settingsKey(s: VoiceOpts['settings']): string {
  const merged = { ...DEFAULT_SETTINGS, ...(s ?? {}) };
  return Object.keys(merged).sort().map(k => `${k}:${merged[k as keyof typeof merged]}`).join(',');
}

function hashText(text: string, voice_id: string, model_id: string, settings: VoiceOpts['settings']): string {
  return crypto.createHash('sha256')
    .update(`${voice_id}|${model_id}|${settingsKey(settings)}|${text}`)
    .digest('hex')
    .slice(0, 32);
}

/** Measure audio duration with ffprobe (available wherever the clipping
 *  system runs — same Railway image). */
function probeDuration(mp3Path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mp3Path]);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err.slice(0, 160)}`));
      const v = parseFloat(out.trim());
      if (!Number.isFinite(v) || v <= 0) return reject(new Error(`ffprobe bad duration: ${out}`));
      resolve(v);
    });
    p.on('error', reject);
  });
}

/**
 * TTS a single phrase, cache + measure. Returns the asset (cached or fresh).
 * Throws on API/network failure — callers handle batch resilience.
 */
export async function ttsBeat(text: string, opts: VoiceOpts = {}): Promise<VoiceAsset> {
  const cleanText = text.trim();
  if (!cleanText) throw new Error('empty text');

  const voice_id = opts.voice_id || DEFAULT_VOICE_ID;
  const model_id = opts.model_id || DEFAULT_MODEL;
  const settings = { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) };
  const text_hash = hashText(cleanText, voice_id, model_id, settings);

  const pool = await getPool();

  // Fast path: hit the cache.
  const cached = (await pool.query<{ text: string; voice_id: string; model_id: string; local_path: string; duration_s: number; bytes: number; char_count: number }>(
    `SELECT text, voice_id, model_id, local_path, duration_s, bytes, char_count
       FROM content_gen_voice_assets WHERE text_hash = $1`,
    [text_hash],
  )).rows[0];
  if (cached) {
    // Verify the file still exists on the volume (could have been pruned).
    try {
      const stat = await fs.stat(cached.local_path);
      if (stat.size > 0) {
        await pool.query(`UPDATE content_gen_voice_assets SET last_used_at = NOW() WHERE text_hash = $1`, [text_hash]).catch(() => {});
        return { text_hash, ...cached, cached: true };
      }
    } catch { /* file gone — regenerate below */ }
  }

  // Generate it.
  const key = await getElevenLabsKey();
  const url = `${ELEVENLABS_API}/text-to-speech/${voice_id}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text: cleanText, model_id, voice_settings: settings }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`elevenlabs ${res.status}: ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error(`elevenlabs returned ${buf.length} bytes (too small)`);

  await fs.mkdir(TTS_DIR, { recursive: true });
  const localPath = path.join(TTS_DIR, `${text_hash}.mp3`);
  await fs.writeFile(localPath, buf);
  const duration_s = await probeDuration(localPath);

  await pool.query(
    `INSERT INTO content_gen_voice_assets (text_hash, text, voice_id, model_id, settings, local_path, duration_s, bytes, char_count, last_used_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (text_hash) DO UPDATE SET
       local_path = EXCLUDED.local_path, duration_s = EXCLUDED.duration_s,
       bytes = EXCLUDED.bytes, last_used_at = NOW()`,
    [text_hash, cleanText, voice_id, model_id, JSON.stringify(settings), localPath, duration_s, buf.length, cleanText.length],
  );

  return {
    text_hash, text: cleanText, voice_id, model_id, local_path: localPath,
    duration_s, bytes: buf.length, char_count: cleanText.length, cached: false,
  };
}

/** Read a cached TTS file by its text hash (for the serve endpoint). */
export async function readVoiceFile(text_hash: string): Promise<{ buf: Buffer; contentType: string } | null> {
  const pool = await getPool();
  const r = await pool.query<{ local_path: string }>(
    `SELECT local_path FROM content_gen_voice_assets WHERE text_hash = $1`, [text_hash],
  );
  const p = r.rows[0]?.local_path;
  if (!p) return null;
  try {
    const buf = await fs.readFile(p);
    await pool.query(`UPDATE content_gen_voice_assets SET last_used_at = NOW() WHERE text_hash = $1`, [text_hash]).catch(() => {});
    return { buf, contentType: 'audio/mpeg' };
  } catch { return null; }
}

/** Concurrent batch with a cap — elevenlabs handles concurrency well, but
 *  we don't want to blow the rate limit on a 100-segment script. */
export async function ttsBatch(texts: string[], opts: VoiceOpts = {}, concurrency = 4): Promise<Array<VoiceAsset | { error: string; text: string }>> {
  const out: Array<VoiceAsset | { error: string; text: string }> = new Array(texts.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= texts.length) return;
      const text = texts[idx];
      try { out[idx] = await ttsBeat(text, opts); }
      catch (e) { out[idx] = { error: (e as Error).message, text }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, () => worker()));
  return out;
}
