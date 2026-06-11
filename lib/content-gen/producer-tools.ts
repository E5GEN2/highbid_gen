/**
 * Tool dispatcher — maps a ConcreteScript gem.tool name to the actual
 * runtime that produces its output.
 *
 *   yt_capture    → captureYtScreen (already built — uses xgodo proxies +
 *                   Playwright + compositor)
 *   tts           → STUB — wraps the voice lib once we wire it
 *   sfx_render    → STUB — wraps the sfx lib
 *   image_gen     → STUB — wraps xgodo image-gen (task #1 still in flight)
 *   audio_mix     → STUB — wraps the existing audio_bed_compose
 *   video_compose → ffmpeg filtergraph assembly (HOT PATH; built here)
 *
 * Each runner takes raw args (from the script gem.args) and returns an
 * output object matching the tool's OUTPUT_FIELDS (file_url, duration_s,
 * etc.). Throws on irrecoverable error — the producer catches and writes
 * status='failed' on the gem row.
 */

import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { captureYtScreen, type ScreenKind, type CaptureMode, type AnnotateSpec, type AnnotateElement, type HighlightStyle, type CompositeShapeStyle } from './yt-capture';
import { videoCompose } from './video-compose';
import { ttsBeat, DEFAULT_VOICE_ID } from './voice';
import { CLIPS_DIR } from '../clips-dir';
import { getSfx } from './sfx';
import { imageGenerate } from './image-gen';

export interface ToolOutput {
  file_url?: string;
  duration_s?: number | null;
  asset_kind?: 'image' | 'video';
  bboxes?: Record<string, { x: number; y: number; w: number; h: number }>;
  page_width?: number;
  page_height?: number;
  voice?: string;
  width?: number;
  height?: number;
  [k: string]: unknown;
}

/** Public entry — producer calls runTool(toolName, args) per gem. */
export async function runTool(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  switch (name) {
    case 'yt_capture':    return runYtCapture(args);
    case 'tts':           return runTts(args);
    case 'audio_slice':   return runAudioSlice(args);
    case 'clip_extract':  return runClipExtract(args);
    case 'sfx_render':    return runSfxRender(args);
    case 'image_gen':     return runImageGen(args);
    case 'logos_montage': return runLogosMontage(args);
    case 'audio_mix':     return runAudioMix(args);
    case 'video_compose': return runVideoCompose(args);
    default:
      throw new Error(`unknown tool "${name}"`);
  }
}

/** clip_extract — cut [clip_start, clip_end) out of a channel's real video
 *  for MG-style mini_player b-roll (recipe_demo beats). Whole-video download
 *  is cached per YouTube id under clips/video_src (one download serves every
 *  beat of that video); the trimmed clip KEEPS AUDIO for the diegetic mix
 *  (audio-sfx spec: source audio at ~-15dB under narration).
 *  Download: direct first (works from local dev), xgodo proxy fallback
 *  (Railway egress). */
async function runClipExtract(args: Record<string, unknown>): Promise<ToolOutput> {
  const video_url = String(args.video_url ?? '');
  const start = Number(args.clip_start ?? 0);
  const end = Number(args.clip_end ?? 0);
  if (!video_url) throw new Error('clip_extract: video_url required');
  if (!(end > start)) throw new Error(`clip_extract: bad span ${start}..${end}`);
  const ytid = video_url.match(/(?:shorts\/|watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/)?.[1];
  if (!ytid) throw new Error(`clip_extract: cannot parse video id from ${video_url}`);

  const srcDir = path.join(CLIPS_DIR, 'video_src');
  const brollDir = path.join(CLIPS_DIR, 'broll');
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(brollDir, { recursive: true });
  const srcPath = path.join(srcDir, `${ytid}.mp4`);

  const srcOk = await fs.stat(srcPath).then(s => s.size > 100_000).catch(() => false);
  if (!srcOk) {
    const { emitToolCall } = await import('./exec-context');
    await emitToolCall(`clip_extract:download ${ytid}`, { video_url });
    const ytdlpArgs = (proxyUrl: string | null) => [
      '--merge-output-format', 'mp4',
      '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
      '-o', srcPath, '--no-warnings', '--no-playlist',
      ...(proxyUrl ? ['--proxy', proxyUrl] : []),
      video_url,
    ];
    const tryDownload = (proxyUrl: string | null) => new Promise<void>((resolve, reject) => {
      const proc = spawn('yt-dlp', ytdlpArgs(proxyUrl));
      const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('yt-dlp timeout (4min)')); }, 240_000);
      let err = '';
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', c => { clearTimeout(t); c === 0 ? resolve() : reject(new Error(`yt-dlp exit ${c}: ${err.slice(-180)}`)); });
      proc.on('error', e => { clearTimeout(t); reject(e); });
    });
    try {
      await tryDownload(null);                  // direct (local dev)
    } catch (e1) {
      const { getRandomHealthyProxy } = await import('../xgodo-proxy');
      const proxy = await getRandomHealthyProxy().catch(() => null);
      if (!proxy?.url) throw new Error(`clip_extract download failed (direct: ${(e1 as Error).message.slice(0, 120)}; no proxy)`);
      await tryDownload(proxy.url);             // proxy (Railway)
    }
  }

  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256').update(`${ytid}|${start.toFixed(2)}|${end.toFixed(2)}`).digest('hex').slice(0, 16);
  const outPath = path.join(brollDir, `${hash}.mp4`);
  const outOk = await fs.stat(outPath).then(s => s.size > 10_000).catch(() => false);
  if (!outOk) {
    await new Promise<void>((resolve, reject) => {
      // decode-accurate seek; KEEP audio (diegetic mix needs it)
      const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-i', srcPath, '-ss', start.toFixed(2), '-t', (end - start).toFixed(2),
        '-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', outPath]);
      let err = '';
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', c => c === 0 ? resolve() : reject(new Error(`clip trim ffmpeg ${c}: ${err.slice(0, 180)}`)));
      proc.on('error', reject);
    });
  }
  return {
    file_url: `file://${outPath}`,
    local_path: outPath,
    duration_s: Math.round((end - start) * 100) / 100,
    asset_kind: 'video',
  };
}

/** audio_slice — cut a per-slot span out of a continuous master narration
 *  (ttsWithTimestamps). Args: { src, start_s, end_s }. Accurate-seek
 *  re-encode (not -c copy: mp3 frame boundaries would drift word sync).
 *  Used by the listicle builder's continuous-narration mode so each slot
 *  keeps {{narr.duration_s}} hold semantics while the VOICE was generated
 *  as one natural read. */
async function runAudioSlice(args: Record<string, unknown>): Promise<ToolOutput> {
  const src = String(args.src ?? '');
  const start = Number(args.start_s ?? 0);
  const end = Number(args.end_s ?? 0);
  if (!src) throw new Error('audio_slice: src required');
  if (!(end > start)) throw new Error(`audio_slice: bad span ${start}..${end}`);
  const fsp = await import('fs/promises');
  await fsp.access(src).catch(() => { throw new Error(`audio_slice: src missing: ${src}`); });

  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256').update(`${src}|${start.toFixed(3)}|${end.toFixed(3)}`).digest('hex').slice(0, 16);
  const outDir = path.join(CLIPS_DIR, 'tts', 'slices');
  await fsp.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${hash}.mp3`);

  const exists = await fsp.stat(outPath).then(s => s.size > 500).catch(() => false);
  if (!exists) {
    const { spawn } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      // -ss AFTER -i = decode-accurate seek (sample-precise enough for word sync).
      const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-i', src, '-ss', start.toFixed(3), '-t', (end - start).toFixed(3),
        '-c:a', 'libmp3lame', '-q:a', '2', '-y', outPath]);
      let err = '';
      p.stderr.on('data', d => { err += d.toString(); });
      p.on('close', c => c === 0 ? resolve() : reject(new Error(`audio_slice ffmpeg ${c}: ${err.slice(0, 200)}`)));
      p.on('error', reject);
    });
  }
  return {
    file_url: `file://${outPath}`,
    local_path: outPath,
    duration_s: Math.round((end - start) * 1000) / 1000,
  };
}

/** logos_montage — render 2×5 channel-avatar montage for MG-style
 *  niche reveals. Args: { channelIds: string[] } (in display order).
 *  Caches per video by hash of the channel_id list. */
async function runLogosMontage(args: Record<string, unknown>): Promise<ToolOutput> {
  const channelIds = (args.channelIds as string[]) ?? [];
  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    throw new Error('logos_montage: channelIds required');
  }
  const { getPool } = await import('../db');
  const pool = await getPool();
  // Fetch avatars in the SAME order as the input channelIds list, so
  // target_idx = niche_index in the producer always maps to the right cell.
  const r = await pool.query<{ channel_id: string; channel_avatar: string | null }>(
    `SELECT channel_id, channel_avatar FROM niche_spy_channels WHERE channel_id = ANY($1::text[])`,
    [channelIds],
  );
  const byId = new Map(r.rows.map(row => [row.channel_id, row.channel_avatar]));
  const orderedUrls: (string | null)[] = channelIds.map(id => byId.get(id) ?? null);

  const { composeChannelLogosMontageMG } = await import('./yt-compose-mg');
  const local_path = await composeChannelLogosMontageMG(orderedUrls);
  return {
    file_url: `file://${local_path}`,
    local_path,
    asset_kind: 'image',
    duration_s: null,
    bboxes: null,
    page_width: 1920,
    page_height: 1080,
  };
}

// ───────────────────────────────────────────────────────────────────
// yt_capture — already battle-tested. We just forward args.
// ───────────────────────────────────────────────────────────────────

async function runYtCapture(args: Record<string, unknown>): Promise<ToolOutput> {
  const channelId = String(args.channelId ?? '');
  if (!channelId) throw new Error('yt_capture: channelId required');
  const kind = (args.kind as ScreenKind) ?? 'channel_page';
  const mode = (args.mode as CaptureMode | undefined) ?? undefined;
  const watchVideoId = (args.watchVideoId as string | undefined) ?? undefined;
  const annEl = args.annotate_element as AnnotateElement | undefined;
  const annotate: AnnotateSpec | undefined = annEl ? {
    element: annEl,
    kind: (args.annotate_kind as 'css' | 'composite' | undefined) ?? 'css',
    style: args.annotate_style as HighlightStyle | undefined,
    shape: args.annotate_shape as CompositeShapeStyle | undefined,
    label: args.annotate_label as string | undefined,
    arrow_from: args.annotate_arrow_from as AnnotateSpec['arrow_from'],
    color: args.annotate_color as string | undefined,
  } : undefined;

  const r = await captureYtScreen(channelId, {
    kind, mode, watchVideoId, annotate,
    force: Boolean(args.force),
  });
  // Critical: surface the ANNOTATION-SPECIFIC local_path from the capture
  // result. The DB row is unique on (channel_id, kind, date_bucket) and
  // gets overwritten across multiple annotated calls for the same
  // channel+kind+date, so file_url=?id=N would point to whichever
  // annotation ran LAST. By passing local_path directly we preserve the
  // annotation-specific file each gem actually captured.
  return {
    file_url: `/api/admin/content-gen/yt-capture/file?id=${r.id}`,
    local_path: r.local_path,
    asset_kind: r.asset_kind,
    duration_s: r.duration_s,
    bboxes: r.bboxes,
    page_width: 1440,
    page_height: 900,
  };
}

// ───────────────────────────────────────────────────────────────────
// tts — STUB for now. Returns a synthetic duration derived from text
// length so downstream compose has SOMETHING to lock hold_s to. Real
// impl wraps the ElevenLabs voice lib (already built — needs the cache
// schema + a getter for file_url).
// ───────────────────────────────────────────────────────────────────

async function runTts(args: Record<string, unknown>): Promise<ToolOutput> {
  const text = String(args.text ?? '');
  if (!text) throw new Error('tts: text required');
  // Voice alias map: writer-friendly names → ElevenLabs voice_ids.
  // money_groot defaults to the calm-male documentary narrator we use
  // throughout the pipeline (DEFAULT_VOICE_ID).
  const voiceAlias = String(args.voice ?? 'money_groot');
  const voice_id = voiceAlias === 'money_groot' ? DEFAULT_VOICE_ID : voiceAlias;
  const asset = await ttsBeat(text, {
    voice_id,
    settings: {
      ...(args.stability != null ? { stability: Number(args.stability) } : {}),
      ...(args.similarity_boost != null ? { similarity_boost: Number(args.similarity_boost) } : {}),
    },
  });
  return {
    file_url: `/api/admin/content-gen/voice/file?hash=${asset.text_hash}`,
    duration_s: asset.duration_s,
    voice: asset.voice_id,
    // Pass local_path so video-compose can read directly off disk without
    // an HTTP self-loop.
    local_path: asset.local_path,
  };
}

// ───────────────────────────────────────────────────────────────────
// sfx_render — STUB. Returns synthetic duration matching fit_duration_s
// or a per-token default (whoosh = 0.4s, ding = 0.6s, etc.). Real impl
// wraps lib/content-gen/sfx and caches by token-hash.
// ───────────────────────────────────────────────────────────────────

async function runSfxRender(args: Record<string, unknown>): Promise<ToolOutput> {
  const tokens = (args.tokens as string[]) ?? [];
  if (tokens.length === 0) throw new Error('sfx_render: tokens required');
  const fit = args.fit_duration_s as number | undefined;

  // tool_call emission — shows what tokens are being resolved + fit window.
  // Surfaces ElevenLabs sound-gen invocations (often the slowest sub-step
  // when a fresh token is generated).
  const { emitToolCall } = await import('./exec-context');
  await emitToolCall(`sfx:fetch (${tokens.length} tokens)`, { tokens, fit });

  // Fetch each canonical token via the existing sfx lib (cached by content
  // hash, generated via ElevenLabs sound-gen). Returns local mp3 paths.
  const assets = await Promise.all(tokens.map(t => getSfx(t).catch(e => {
    console.error(`[producer:sfx] token=${t} failed: ${(e as Error).message}`);
    return null;
  })));
  const valid = assets.filter((a): a is NonNullable<typeof a> => a !== null);
  if (valid.length === 0) throw new Error('sfx_render: all tokens failed to resolve');
  await emitToolCall(`sfx:resolved (${valid.length}/${tokens.length})`, {
    resolved: valid.length, requested: tokens.length,
  });

  // Concat the SFX assets into a single track. ffmpeg concat filter handles
  // gapless joining; if a `fit_duration_s` was requested, we pad with
  // silence at the end OR trim to that length.
  await fs.mkdir('/tmp/producer_sfx', { recursive: true });
  const outPath = path.join('/tmp/producer_sfx', `sfx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);

  if (valid.length === 1 && !fit) {
    // Single token, natural duration — just copy the existing cached file.
    await fs.copyFile(valid[0].local_path, outPath);
    return { file_url: `file://${outPath}`, duration_s: valid[0].duration_s, local_path: outPath };
  }

  // Multi-token OR fit-required: build a concat list + run ffmpeg.
  const concatList = path.join(os.tmpdir(), `sfx-concat-${Date.now()}.txt`);
  await fs.writeFile(concatList, valid.map(a => `file '${a.local_path.replace(/'/g, "'\\''")}'`).join('\n'));

  const baseDur = valid.reduce((a, b) => a + b.duration_s, 0);
  const target = fit ?? baseDur;

  await new Promise<void>((resolve, reject) => {
    const args2 = ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', concatList,
      // Pad with silence to target OR trim if natural is longer.
      '-af', `apad=pad_dur=${target.toFixed(3)},atrim=0:${target.toFixed(3)}`,
      '-c:a', 'libmp3lame', '-b:a', '192k',
      outPath];
    const p = spawn('ffmpeg', args2);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', c => c === 0 ? resolve() : reject(new Error(`ffmpeg sfx concat ${c}: ${err.slice(0, 300)}`)));
    p.on('error', reject);
  });
  await fs.unlink(concatList).catch(() => {});

  return {
    file_url: `file://${outPath}`,
    duration_s: target,
    local_path: outPath,
  };
}

// ───────────────────────────────────────────────────────────────────
// image_gen — STUB. Real impl: text_card/icon_card/chalkboard_card
// rendered via Sharp + SVG (similar pattern to yt-annotate-composite).
// For now returns a deterministic stub url so the producer can keep
// flowing. The compositor will draw a placeholder rectangle.
// ───────────────────────────────────────────────────────────────────

async function runImageGen(args: Record<string, unknown>): Promise<ToolOutput> {
  const composition = String(args.composition ?? 'text_card') as 'text_card' | 'text_card_reveal' | 'icon_card' | 'chalkboard_card' | 'text_card_in_title_sequence' | 'most_popular_callout' | 'channel_about_panel' | 'top_videos_pano';
  const text = String(args.text ?? '');
  const bg_mode = (args.bg_mode === 'dark_gray' ? 'dark_gray' : 'white') as 'white' | 'dark_gray';
  const color_treatment = args.color_treatment as 'neutral' | 'money_shot_green' | 'inline_green' | 'inline_red' | 'chalk_cream' | 'yellow_ring' | undefined;
  const icon = args.icon as 'shrug_with_question_marks' | 'pointing_hand' | 'checkmark_green_circle' | 'dollar_sign_green_circle' | 'cat_thumbs_up' | 'speaker_muted' | 'speaker_with_sound_waves' | 'shrug_emoji' | 'cash_pile' | undefined;
  // tool_call sub-event so the Execution drawer shows what composition
  // is being rendered (text_card, money_math, top_videos_pano, etc.) +
  // its dominant args.
  const { emitToolCall } = await import('./exec-context');
  await emitToolCall(`image_gen:${composition}`, {
    composition, bg_mode, color_treatment,
    text_preview: text.slice(0, 60) || undefined,
  });
  const result = await imageGenerate({
    composition,
    text,
    bg_mode,
    color_treatment,
    icon,
    // Forward the fields specific to most_popular_callout
    video_id: args.video_id as string | undefined,
    views: typeof args.views === 'number' ? args.views : undefined,
    age_phrase: args.age_phrase as string | undefined,
    duration_badge: args.duration_badge as string | undefined,
    channel_watermark: args.channel_watermark as string | undefined,
    // Forward the fields specific to channel_about_panel
    handle: args.handle as string | undefined,
    country: args.country as string | undefined,
    joined_phrase: args.joined_phrase as string | undefined,
    subscribers_text: args.subscribers_text as string | undefined,
    video_count_text: args.video_count_text as string | undefined,
    total_views_text: args.total_views_text as string | undefined,
    highlight_row: args.highlight_row as 'handle' | 'country' | 'joined' | 'subscribers' | 'videos' | 'views' | null | undefined,
    // Forward the fields specific to top_videos_pano
    videos: args.videos as Array<{ video_id: string; title: string; views: number; age_phrase?: string; duration_badge?: string }> | undefined,
  });
  return {
    file_url: result.file_url,
    width: result.width,
    height: result.height,
    local_path: result.local_path,
    // text_card_reveal: progressive PNG set (k=0 blank … k=N full text)
    // consumed by video-compose's word_reveal mode.
    ...(Array.isArray(result.local_paths) ? { local_paths: result.local_paths } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────
// audio_mix — STUB. Real impl wraps the existing audio_bed_compose
// (already built per task #8). For producer's purposes today, the per-
// slot SFX is rendered inline by video_compose's ffmpeg filtergraph
// from the per-slot sfx.file_url — no separate mix step needed.
// ───────────────────────────────────────────────────────────────────

async function runAudioMix(args: Record<string, unknown>): Promise<ToolOutput> {
  return {
    file_url: 'stub://audio_mix/composite',
    duration_s: 0,
  };
}

// ───────────────────────────────────────────────────────────────────
// video_compose — final assembly. PLACEHOLDER for now: returns a
// metadata-only stub that records the slot order + per-slot bag, so
// the producer's pipeline runs end-to-end even before ffmpeg lands.
// Real impl (next iteration): build an ffmpeg filtergraph that
//   - loads each slot's main visual (image OR video)
//   - Ken Burns zoom on stills
//   - cross-cuts between slots
//   - mixes narr + sfx audio
// outputs an mp4 at width × height × fps.
// ───────────────────────────────────────────────────────────────────

async function runVideoCompose(args: Record<string, unknown>): Promise<ToolOutput> {
  const slot_order = (args.slot_order as string[]) ?? [];
  // Long-form 16:9 defaults (MG videos are ~14-min YT long-form, not Shorts).
  const width = (args.width as number) ?? 1920;
  const height = (args.height as number) ?? 1080;
  const fps = (args.fps as number) ?? 30;
  const default_bg = (args.default_bg as 'white' | 'dark_gray') ?? 'dark_gray';
  // Music bed token — defaults to 'bed' (calm lofi). Pass music_token=null
  // through the script.final.args to disable.
  const music_token = (args.music_token === undefined) ? 'bed' : (args.music_token as string | null);
  const bag = (args.__bag__ as Record<string, Record<string, Record<string, unknown>>>) ?? {};
  const jobId = (args.__job_id__ as number) ?? 0;
  if (slot_order.length === 0) throw new Error('video_compose: empty slot_order');
  const result = await videoCompose({
    slot_order, width, height, fps, default_bg,
    music_token,
    __bag__: bag,
    __job_id__: jobId,
  });
  return {
    file_url: result.file_url,
    duration_s: result.duration_s,
    width: result.width,
    height: result.height,
    local_path: result.local_path,
  };
}
