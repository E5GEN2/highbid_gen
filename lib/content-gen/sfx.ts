/**
 * SFX + music generation — ElevenLabs /v1/sound-generation.
 *
 * The tri-track timeline emits SYMBOLIC SFX tokens ("whoosh",
 * "ding_high_pitch", "soft_chimes", …) and music tokens ("bed", "intro",
 * "duck_under_diegetic", …). Here we translate each token into a text
 * prompt + duration, generate it via 11labs, cache it on the volume by
 * content hash, and expose a single `getSfx(token, durationS?)` entry
 * point the audio-bed composer calls per timeline event.
 *
 * Caching is by SHA256(token + prompt + duration_req) so:
 *  - same token = free disk hit on re-runs
 *  - tweaking the prompt for a token = new cache slot (old one still around)
 *  - identical request across groups = shared single asset
 *
 * 11labs minimums: duration_seconds >= 0.5. Whoosh/ding requests below
 * that are clamped up.
 */

import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { getPool } from '../db';
import { CLIPS_DIR } from '../clips-dir';

const SFX_DIR = path.join(CLIPS_DIR, 'sfx');
const ELEVENLABS_API = 'https://api.elevenlabs.io/v1';
const MIN_DURATION = 0.5;

export type SfxKind = 'sfx' | 'music';

interface TokenSpec {
  kind: SfxKind;
  prompt: string;
  default_duration_s: number;
  prompt_influence?: number;   // 0..1, how strictly to follow the prompt (0.7 default for SFX)
}

/**
 * Token → text-prompt registry. Tokens are referenced by the timeline
 * compiler (renderVisual emits them). Prompts derived from
 * audio-sfx-class-b.json — "what MG actually uses" in plain English.
 */
export const TOKENS: Record<string, TokenSpec> = {
  // ── SFX ──
  whoosh:                { kind: 'sfx', prompt: 'a quick subtle whoosh transition swoosh, dry, no reverb, very short', default_duration_s: 0.5, prompt_influence: 0.7 },
  subtle_whoosh:         { kind: 'sfx', prompt: 'a very subtle short whoosh transition, soft and quick, almost a breath', default_duration_s: 0.5, prompt_influence: 0.7 },
  whoosh_on_load:        { kind: 'sfx', prompt: 'a quick whoosh transition as an element loads in, dry, no reverb', default_duration_s: 0.5, prompt_influence: 0.7 },
  whoosh_on_transition:  { kind: 'sfx', prompt: 'a quick whoosh transition between visual segments, clean, dry', default_duration_s: 0.5, prompt_influence: 0.7 },
  whoosh_on_grid_reveal: { kind: 'sfx', prompt: 'a quick whoosh sound for a grid of thumbnails revealing on screen, light and clean', default_duration_s: 0.6, prompt_influence: 0.7 },

  ding:                  { kind: 'sfx', prompt: 'a short clean ding bell hit, neutral pitch, dry, single hit, no decay tail', default_duration_s: 0.5, prompt_influence: 0.8 },
  ding_high_pitch:       { kind: 'sfx', prompt: 'a sharp high-pitched ding bell for a money reveal, very bright, short and clean', default_duration_s: 0.5, prompt_influence: 0.8 },
  ding_on_card_entry:    { kind: 'sfx', prompt: 'a soft clean ding when a card enters the screen, single bell hit, gentle', default_duration_s: 0.5, prompt_influence: 0.8 },
  ding_on_circle:        { kind: 'sfx', prompt: 'a soft clean ding bell hit synced to a yellow circle annotation appearing, gentle and bright', default_duration_s: 0.5, prompt_influence: 0.8 },

  soft_chimes:           { kind: 'sfx', prompt: 'soft mellow rising chimes, magical positive reveal, gentle and dreamy', default_duration_s: 1.0, prompt_influence: 0.7 },
  ascending_sting:       { kind: 'sfx', prompt: 'a short ascending electronic sting building up, hopeful, ending on a bright note', default_duration_s: 1.0, prompt_influence: 0.7 },
  // Alias — the writer/builder emit the registry name (tools.ts SFX_TOKENS);
  // it failed as "unknown token" on every render until 2026-06-11.
  ascending_electronic_sting: { kind: 'sfx', prompt: 'a short ascending electronic sting building up, hopeful, ending on a bright note', default_duration_s: 1.0, prompt_influence: 0.7 },

  // ── Music beds (longer; durations supplied at call time) ──
  bed:                   { kind: 'music', prompt: 'calm mellow lofi background music for a documentary explainer video, no vocals, gentle synth and warm piano, smooth and looping', default_duration_s: 30, prompt_influence: 0.5 },
  intro:                 { kind: 'music', prompt: 'a short uplifting intro music sting for a documentary explainer, hopeful, no vocals, fades into a calm bed', default_duration_s: 4, prompt_influence: 0.5 },
  niche_in:              { kind: 'music', prompt: 'a brief warm music transition introducing a new section, gentle synth swell, hopeful, no vocals', default_duration_s: 2, prompt_influence: 0.5 },
  duck_under_diegetic:   { kind: 'music', prompt: 'calm, gentle background music ducked low under another sound source, sparse, present but mostly silent', default_duration_s: 8, prompt_influence: 0.5 },
  duck_deeper:           { kind: 'music', prompt: 'very soft calm background pad ducked deep under speech, intimate, almost silent', default_duration_s: 4, prompt_influence: 0.5 },
};

export interface SfxAsset {
  sfx_hash: string;
  token: string;
  kind: SfxKind;
  prompt: string;
  duration_req: number;
  local_path: string;
  duration_s: number;
  bytes: number;
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

function hashOf(token: string, prompt: string, duration_req: number, influence: number): string {
  return crypto.createHash('sha256')
    .update(`${token}|${prompt}|${duration_req}|${influence}`)
    .digest('hex')
    .slice(0, 32);
}

function probeDuration(mp3Path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mp3Path]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', c => {
      if (c !== 0) return reject(new Error(`ffprobe ${c}: ${err.slice(0, 160)}`));
      const v = parseFloat(out.trim());
      if (!Number.isFinite(v) || v <= 0) return reject(new Error(`bad duration: ${out}`));
      resolve(v);
    });
    p.on('error', reject);
  });
}

/**
 * Get the asset for a token. If it's not in cache, generate via 11labs and
 * persist. durationS overrides the registry default (clamped to MIN).
 */
export async function getSfx(token: string, durationS?: number): Promise<SfxAsset> {
  const spec = TOKENS[token];
  if (!spec) throw new Error(`unknown sfx token: ${token}`);
  const dur = Math.max(MIN_DURATION, Math.round(((durationS ?? spec.default_duration_s)) * 100) / 100);
  const influence = spec.prompt_influence ?? 0.5;
  const hash = hashOf(token, spec.prompt, dur, influence);

  const pool = await getPool();
  const cached = (await pool.query<{ kind: SfxKind; prompt: string; local_path: string; duration_s: number; bytes: number }>(
    `SELECT kind, prompt, local_path, duration_s, bytes FROM content_gen_sfx_assets WHERE sfx_hash = $1`,
    [hash],
  )).rows[0];
  if (cached) {
    try {
      const st = await fs.stat(cached.local_path);
      if (st.size > 0) {
        await pool.query(`UPDATE content_gen_sfx_assets SET last_used_at = NOW() WHERE sfx_hash = $1`, [hash]).catch(() => {});
        return { sfx_hash: hash, token, kind: cached.kind, prompt: cached.prompt, duration_req: dur, local_path: cached.local_path, duration_s: cached.duration_s, bytes: cached.bytes, cached: true };
      }
    } catch { /* file gone — regenerate */ }
  }

  const key = await getElevenLabsKey();
  const res = await fetch(`${ELEVENLABS_API}/sound-generation`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text: spec.prompt, duration_seconds: dur, prompt_influence: influence }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`elevenlabs sfx ${res.status}: ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error(`sfx returned only ${buf.length} bytes`);

  await fs.mkdir(SFX_DIR, { recursive: true });
  const localPath = path.join(SFX_DIR, `${hash}.mp3`);
  await fs.writeFile(localPath, buf);
  const duration_s = await probeDuration(localPath);

  await pool.query(
    `INSERT INTO content_gen_sfx_assets (sfx_hash, token, kind, prompt, duration_req, local_path, duration_s, bytes, prompt_influence, last_used_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (sfx_hash) DO UPDATE SET local_path = EXCLUDED.local_path, duration_s = EXCLUDED.duration_s, bytes = EXCLUDED.bytes, last_used_at = NOW()`,
    [hash, token, spec.kind, spec.prompt, dur, localPath, duration_s, buf.length, influence],
  );

  return { sfx_hash: hash, token, kind: spec.kind, prompt: spec.prompt, duration_req: dur, local_path: localPath, duration_s, bytes: buf.length, cached: false };
}

/** Read a cached SFX off the volume (for the serve endpoint). */
export async function readSfxFile(sfx_hash: string): Promise<{ buf: Buffer; contentType: string } | null> {
  const pool = await getPool();
  const r = await pool.query<{ local_path: string }>(
    `SELECT local_path FROM content_gen_sfx_assets WHERE sfx_hash = $1`, [sfx_hash],
  );
  const p = r.rows[0]?.local_path;
  if (!p) return null;
  try {
    const buf = await fs.readFile(p);
    await pool.query(`UPDATE content_gen_sfx_assets SET last_used_at = NOW() WHERE sfx_hash = $1`, [sfx_hash]).catch(() => {});
    return { buf, contentType: 'audio/mpeg' };
  } catch { return null; }
}

/**
 * Pre-warm every SFX/music token in the registry at default durations.
 * Useful before a render so all the small one-shots are ready instantly.
 */
export async function warmAllSfx(concurrency = 4): Promise<{ ok: number; failed: number; assets: Array<SfxAsset | { token: string; error: string }> }> {
  const tokens = Object.keys(TOKENS);
  const out: Array<SfxAsset | { token: string; error: string }> = new Array(tokens.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++; if (idx >= tokens.length) return;
      const tk = tokens[idx];
      try { out[idx] = await getSfx(tk); }
      catch (e) { out[idx] = { token: tk, error: (e as Error).message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tokens.length) }, () => worker()));
  return { ok: out.filter(x => !('error' in x)).length, failed: out.filter(x => 'error' in x).length, assets: out };
}
