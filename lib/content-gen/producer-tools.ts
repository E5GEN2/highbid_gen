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

import { captureYtScreen, type ScreenKind, type CaptureMode, type AnnotateSpec, type AnnotateElement, type HighlightStyle, type CompositeShapeStyle } from './yt-capture';
import { videoCompose } from './video-compose';
import { ttsBeat, DEFAULT_VOICE_ID } from './voice';

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
    case 'sfx_render':    return runSfxRender(args);
    case 'image_gen':     return runImageGen(args);
    case 'audio_mix':     return runAudioMix(args);
    case 'video_compose': return runVideoCompose(args);
    default:
      throw new Error(`unknown tool "${name}"`);
  }
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
  return {
    file_url: `/api/admin/content-gen/yt-capture/file?id=${r.id}`,
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
  const natural = tokens.reduce((a, t) => a + sfxNaturalDur(t), 0);
  const duration_s = fit ?? natural;
  return {
    file_url: `stub://sfx/${tokens.join('+')}`,
    duration_s,
  };
}
function sfxNaturalDur(token: string): number {
  if (token === 'ascending_electronic_sting') return 1.2;
  if (token.startsWith('ding')) return 0.5;
  if (token.startsWith('whoosh')) return 0.4;
  if (token === 'cash_counting') return 0.8;
  return 0.5;
}

// ───────────────────────────────────────────────────────────────────
// image_gen — STUB. Real impl: text_card/icon_card/chalkboard_card
// rendered via Sharp + SVG (similar pattern to yt-annotate-composite).
// For now returns a deterministic stub url so the producer can keep
// flowing. The compositor will draw a placeholder rectangle.
// ───────────────────────────────────────────────────────────────────

async function runImageGen(args: Record<string, unknown>): Promise<ToolOutput> {
  const composition = String(args.composition ?? 'text_card');
  const text = String(args.text ?? '').slice(0, 60);
  const bg_mode = String(args.bg_mode ?? 'white');
  return {
    file_url: `stub://image_gen/${composition}/${encodeURIComponent(text)}?bg=${bg_mode}`,
    width: 1080,
    height: 1920,
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
  const width = (args.width as number) ?? 1080;
  const height = (args.height as number) ?? 1920;
  const fps = (args.fps as number) ?? 30;
  const default_bg = (args.default_bg as 'white' | 'dark_gray') ?? 'dark_gray';
  const bag = (args.__bag__ as Record<string, Record<string, Record<string, unknown>>>) ?? {};
  const jobId = (args.__job_id__ as number) ?? 0;
  if (slot_order.length === 0) throw new Error('video_compose: empty slot_order');
  const result = await videoCompose({
    slot_order, width, height, fps, default_bg,
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
