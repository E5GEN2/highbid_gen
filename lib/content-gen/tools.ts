/**
 * Tool registry for the content-gen producer.
 *
 * The script-writer references tools by NAME and the producer dispatches them.
 * Each tool declares: input args schema (so the writer can be validated),
 * an output shape (so downstream gems can reference fields like
 * `{{tts.duration_s}}`), and a `run()` implementation that the producer
 * invokes.
 *
 * The argument schemas here are intentionally JSON-Schema (draft-2020-12)
 * shaped — they get inlined into the Gemini system prompt so the writer
 * knows exactly which fields are valid + required for each tool. Any
 * deviation in writer output is rejected at validation time before the
 * producer ever tries to run it.
 *
 * Adding a new tool:
 *   1. Define its args + output type below
 *   2. Add it to TOOL_REGISTRY at the bottom
 *   3. Update the prompt in script-writer.ts (it inlines this registry)
 */

import type { AnnotateElement, HighlightStyle, CompositeShapeStyle, ScreenKind, CaptureMode } from './yt-capture';

// ───────────────────────────────────────────────────────────────────
// Tool input/output types
// ───────────────────────────────────────────────────────────────────

/** yt_capture — capture a YT screen (channel/about/videos/watch) optionally
 *  with a baked-in highlight (CSS) or post-process annotation (composite). */
export interface YtCaptureArgs {
  channelId: string;
  kind: ScreenKind;
  mode?: CaptureMode;
  watchVideoId?: string;
  annotate_element?: AnnotateElement;
  annotate_kind?: 'css' | 'composite';
  annotate_style?: HighlightStyle;          // when kind='css'
  annotate_shape?: CompositeShapeStyle;     // when kind='composite'
  annotate_label?: string;
  annotate_arrow_from?: 'top' | 'bottom' | 'left' | 'right' | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
  /** Override default cache (per channel + kind + day). Composite already
   *  forces a fresh capture; only set for explicit invalidation. */
  force?: boolean;
}
export interface YtCaptureOutput {
  file_url: string;             // /api/admin/content-gen/yt-capture/file?id=N
  asset_kind: 'image' | 'video';
  bboxes: Record<string, { x: number; y: number; w: number; h: number }>;
  page_width: number;
  page_height: number;
  duration_s: number | null;    // when scroll_record
}

/** tts — narrate text in a given voice. Duration is the locked playback length
 *  the compositor must hold the visual for. */
export interface TtsArgs {
  text: string;
  /** ElevenLabs voice_id, or one of our voice aliases (money_groot, etc.) */
  voice?: string;
  /** model + stability come from voice config; expose them as overrides */
  stability?: number;
  similarity_boost?: number;
}
export interface TtsOutput {
  file_url: string;            // mp3 path
  duration_s: number;
  voice: string;
}

/** sfx_render — mix a sequence of SFX tokens into a single track. */
export interface SfxArgs {
  tokens: string[];           // ['whoosh', 'ding_on_circle_reveal'], etc.
  /** Optional total duration the track should fit into. If omitted the
   *  track's natural length is used. */
  fit_duration_s?: number;
}
export interface SfxOutput {
  file_url: string;
  duration_s: number;
}

/** image_gen — generate a text_card / icon_card / chalkboard image. */
export interface ImageGenArgs {
  composition: 'text_card' | 'icon_card' | 'chalkboard_card' | 'text_card_in_title_sequence';
  /** Primary copy on the card */
  text: string;
  /** Color treatment from the visual grammar */
  color_treatment?: 'neutral' | 'money_shot_green' | 'inline_green' | 'inline_red' | 'chalk_cream';
  bg_mode: 'white' | 'dark_gray';
  /** Icon id from the line-drawing library (when composition=icon_card) */
  icon?: string;
}
export interface ImageGenOutput {
  file_url: string;
  width: number;
  height: number;
}

/** audio_mix — combine narration + sfx + bed music into the final group bed. */
export interface AudioMixArgs {
  /** Ordered list of gem references — each entry is `{slot_id}.{gem_id}` like
   *  'channel.subs.narr'. Producer resolves them to URLs. */
  narration_refs: string[];
  sfx_refs?: string[];
  music_token?: string;        // e.g. 'main_bed_v1'
  ducking_db?: number;         // attenuate music under voice
}
export interface AudioMixOutput {
  file_url: string;
  duration_s: number;
}

/** video_compose — final assembly. Takes the timeline (slots in order) and
 *  every gem produced upstream, emits an mp4 via ffmpeg filtergraph. NOT YET
 *  IMPLEMENTED — placeholder so the script can already reference it. */
export interface VideoComposeArgs {
  /** Slot order (string ids in playback order) */
  slot_order: string[];
  /** Background mode per slot — overridden by per-slot `compose.bg` */
  default_bg?: 'white' | 'dark_gray';
  /** Resolution */
  width?: number;
  height?: number;
  fps?: number;
}
export interface VideoComposeOutput {
  file_url: string;
  duration_s: number;
}

// ───────────────────────────────────────────────────────────────────
// Tool registry (machine-readable for the writer prompt + validator)
// ───────────────────────────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12) for args. */
  args_schema: Record<string, unknown>;
  /** Fields available on the output for `{{ref}}` interpolation. */
  output_fields: string[];
}

/** The canonical tool registry — single source of truth for both the writer
 *  prompt and the producer dispatcher. */
export const TOOL_REGISTRY: ToolSpec[] = [
  {
    name: 'yt_capture',
    description: 'Capture a YouTube screen (channel home, about modal, videos tab, or a watch page) optionally with a baked-in highlight on a named element. Returns the asset file + bboxes for per-element cropping.',
    args_schema: {
      type: 'object',
      required: ['channelId', 'kind'],
      additionalProperties: false,
      properties: {
        channelId: { type: 'string', description: 'YT channel ID like UCM6...' },
        kind:      { type: 'string', enum: ['channel_page', 'about_page', 'videos_tab', 'watch_page'] },
        mode:      { type: 'string', enum: ['static', 'scroll_record'], description: 'Defaults to static; videos_tab defaults to scroll_record.' },
        watchVideoId: { type: 'string', description: 'Required when kind=watch_page.' },
        annotate_element: { type: 'string', enum: ['subscriber_count', 'video_count', 'total_views', 'joined_date', 'view_count'] },
        annotate_kind:    { type: 'string', enum: ['css', 'composite'], description: 'css=inline highlight on element; composite=post-process SVG shape.' },
        annotate_style:   { type: 'string', enum: ['yellow_ring', 'yellow_box', 'yellow_highlight', 'yellow_circle'], description: 'Used when annotate_kind=css.' },
        annotate_shape:   { type: 'string', enum: ['sharpie_circle', 'arrow', 'circle_with_label', 'glow_ring', 'underline'], description: 'Used when annotate_kind=composite.' },
        annotate_label:   { type: 'string', description: 'Label text for circle_with_label shape.' },
        annotate_arrow_from: { type: 'string', enum: ['top', 'bottom', 'left', 'right', 'top_left', 'top_right', 'bottom_left', 'bottom_right'] },
        force: { type: 'boolean' },
      },
    },
    output_fields: ['file_url', 'asset_kind', 'bboxes', 'page_width', 'page_height', 'duration_s'],
  },
  {
    name: 'tts',
    description: 'Synthesize speech for a narration line. Returns the audio file + locked duration_s so downstream slots can set hold_s to match.',
    args_schema: {
      type: 'object',
      required: ['text'],
      additionalProperties: false,
      properties: {
        text:    { type: 'string', minLength: 1 },
        voice:   { type: 'string', description: 'Voice alias (money_groot) or ElevenLabs voice_id.' },
        stability:        { type: 'number', minimum: 0, maximum: 1 },
        similarity_boost: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    output_fields: ['file_url', 'duration_s', 'voice'],
  },
  {
    name: 'sfx_render',
    description: 'Render an SFX track from one or more token names (whoosh, ding_on_circle_reveal, etc.). Output can be sized to a target duration.',
    args_schema: {
      type: 'object',
      required: ['tokens'],
      additionalProperties: false,
      properties: {
        tokens: { type: 'array', items: { type: 'string' }, minItems: 1 },
        fit_duration_s: { type: 'number', minimum: 0.1 },
      },
    },
    output_fields: ['file_url', 'duration_s'],
  },
  {
    name: 'image_gen',
    description: 'Generate a non-YT visual: text_card, icon_card, chalkboard_card, or title-sequence card. Use for compositions that the visual grammar requires from non-screenshot sources.',
    args_schema: {
      type: 'object',
      required: ['composition', 'text', 'bg_mode'],
      additionalProperties: false,
      properties: {
        composition:     { type: 'string', enum: ['text_card', 'icon_card', 'chalkboard_card', 'text_card_in_title_sequence'] },
        text:            { type: 'string' },
        color_treatment: { type: 'string', enum: ['neutral', 'money_shot_green', 'inline_green', 'inline_red', 'chalk_cream'] },
        bg_mode:         { type: 'string', enum: ['white', 'dark_gray'] },
        icon:            { type: 'string', description: 'Icon id from line-drawing library, required when composition=icon_card.' },
      },
    },
    output_fields: ['file_url', 'width', 'height'],
  },
  {
    name: 'audio_mix',
    description: 'Mix narration + SFX + bed music into a single group-level audio bed. Used by the producer at the audio assembly stage, not per slot.',
    args_schema: {
      type: 'object',
      required: ['narration_refs'],
      additionalProperties: false,
      properties: {
        narration_refs: { type: 'array', items: { type: 'string' }, minItems: 1 },
        sfx_refs:       { type: 'array', items: { type: 'string' } },
        music_token:    { type: 'string' },
        ducking_db:     { type: 'number' },
      },
    },
    output_fields: ['file_url', 'duration_s'],
  },
  {
    name: 'video_compose',
    description: 'FINAL assembly — takes the ordered list of slots + every gem produced upstream, runs ffmpeg with Ken Burns / cross-fade / audio sync, returns the final mp4. The producer runs this LAST, after all upstream gems resolved.',
    args_schema: {
      type: 'object',
      required: ['slot_order'],
      additionalProperties: false,
      properties: {
        slot_order: { type: 'array', items: { type: 'string' }, minItems: 1 },
        default_bg: { type: 'string', enum: ['white', 'dark_gray'] },
        width:      { type: 'integer', minimum: 200 },
        height:     { type: 'integer', minimum: 200 },
        fps:        { type: 'integer', minimum: 12, maximum: 60 },
      },
    },
    output_fields: ['file_url', 'duration_s'],
  },
];

/** Quick name lookup. */
export const TOOLS_BY_NAME: Record<string, ToolSpec> = Object.fromEntries(
  TOOL_REGISTRY.map(t => [t.name, t]),
);

/** All tool names — for enum constraints in the concrete-script schema. */
export const TOOL_NAMES = TOOL_REGISTRY.map(t => t.name);
