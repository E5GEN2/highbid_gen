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

/** Canonical SFX token enum — from docs/content-gen/audio-sfx-class-b.json.
 *  These are the ONLY valid tokens for sfx_render. Anything outside this
 *  list is a writer hallucination. */
export const SFX_TOKENS = [
  'whoosh',          // default transition between cards
  'ding',            // number / value reveal — pitch rises with figure size
  'click',
  'keyboard_typing',
  'bell_ring',
  'page_turn',
  'cash_counting',
  'soft_chimes',
  'mouse_click',
  'ascending_electronic_sting',   // final CTA beat only
  'generic_impact',
] as const;
export type SfxToken = typeof SFX_TOKENS[number];

/** Canonical music track enum — from docs/content-gen/audio-sfx-class-b.json. */
export const MUSIC_TOKENS = [
  'upbeat_light',                    // default body bed
  'upbeat_motivational',
  'upbeat_tech',
  'calm_uplifting',
  'upbeat_calm',                     // CTA
  'upbeat_corporate',                // niche pivots
  'phonk_funk',                      // diegetic only — when topic is funk-related
  'soft_calm',
  'upbeat_modern_inspirational',
  'energetic_dramatic',
] as const;
export type MusicToken = typeof MUSIC_TOKENS[number];

/** Canonical icon-library enum — from docs/content-gen/visual-packaging-class-b.json. */
export const ICON_IDS = [
  'shrug_with_question_marks',       // "we're estimating" — used in lump_sum sequence
  'pointing_hand',
  'checkmark_green_circle',
  'dollar_sign_green_circle',
  'cat_thumbs_up',
  'speaker_muted',
  'speaker_with_sound_waves',
  'shrug_emoji',
  'cash_pile',
] as const;
export type IconId = typeof ICON_IDS[number];

/** Canonical color-treatment enum (visual-packaging-class-b + slot-rendering
 *  contract). yellow_ring is named in slot-rendering for the annotation
 *  primitive applied to channel.subscribers / channel.video_count /
 *  channel.total_views — keep it here so image_gen.color_treatment matches
 *  the slot-rendering contract. */
export const COLOR_TREATMENTS = ['neutral', 'money_shot_green', 'inline_green', 'inline_red', 'chalk_cream', 'yellow_ring'] as const;
export type ColorTreatment = typeof COLOR_TREATMENTS[number];

/** Canonical data-point IDs — from docs/content-gen/data-points.json.
 *  P1 fillable: things the script CAN reference. The slot-rendering grammar
 *  is keyed on these. */
export const DATA_POINT_IDS_FILLABLE = [
  'money.yearly', 'money.daily', 'money.monthly', 'money.per_video', 'money.lump_sum',
  'channel.upload_rate', 'channel.age', 'channel.subscribers', 'channel.video_count', 'channel.total_views',
  'growth.in_period',
  'video.top_video', 'video.views',
  'niche.category', 'competition.saturated', 'competition.zero',
  'format.tool_named', 'format.production_type',
  'time.posting_year',
  'recipe.formula', 'cta.viewer_appreciation',
] as const;
export type DataPointId = typeof DATA_POINT_IDS_FILLABLE[number];

/** HARD-BANNED data-point IDs — never appear in the output. */
export const DATA_POINT_IDS_BANNED = ['money.rpm_exposed', 'social.likes', 'time.posting_window'] as const;

/** Dollar-trio: exactly one of these per channel (whichever rounds cleanly). */
export const DOLLAR_TRIO = ['money.yearly', 'money.daily', 'money.monthly'] as const;

/** sfx_render — mix a sequence of SFX tokens into a single track.
 *  NEVER stack >1 SFX on a single cut (audio-sfx exclude rule). */
export interface SfxArgs {
  tokens: SfxToken[];
  /** Optional total duration the track should fit into. If omitted the
   *  track's natural length is used. */
  fit_duration_s?: number;
}
export interface SfxOutput {
  file_url: string;
  duration_s: number;
}

/** image_gen — generate a non-YT visual (text_card / icon_card / chalkboard /
 *  title-sequence card). Compositions follow slot-rendering-class-b. */
export interface ImageGenArgs {
  composition: 'text_card' | 'text_card_reveal' | 'icon_card' | 'chalkboard_card' | 'text_card_in_title_sequence' | 'most_popular_callout' | 'channel_about_panel' | 'top_videos_pano';
  /** Primary copy on the card. For most_popular_callout this is the video title.
   *  Optional when composition=channel_about_panel or top_videos_pano (fully data-driven). */
  text: string;
  /** Color treatment from the visual grammar */
  color_treatment?: ColorTreatment;
  bg_mode: 'white' | 'dark_gray';
  /** Icon id from the canonical line-drawing library
   *  (required when composition=icon_card). */
  icon?: IconId;
  // ── Fields specific to most_popular_callout composition ──
  /** YT video id (11-char) — used to fetch the thumbnail from YT's CDN. */
  video_id?: string;
  /** Raw view count — humanized to "12M views" by the renderer. */
  views?: number;
  /** Pre-formatted relative age, e.g. "7 months ago" / "2 years ago". */
  age_phrase?: string;
  /** Optional duration badge (e.g. "34:32") rendered bottom-right of the thumbnail. */
  duration_badge?: string;
  /** Optional channel watermark (e.g. "NoFL") inside the thumbnail bottom-left. */
  channel_watermark?: string;
  // ── Fields specific to channel_about_panel composition ──
  /** Channel handle with or without leading @ (e.g. "@VESSTICK"). */
  handle?: string;
  /** Country line shown under handle (e.g. "United States"). */
  country?: string;
  /** Pre-formatted "Joined DD Mon YYYY" phrase. */
  joined_phrase?: string;
  /** Pre-formatted subscribers row (e.g. "437k subscribers"). */
  subscribers_text?: string;
  /** Pre-formatted videos row (e.g. "122 videos"). */
  video_count_text?: string;
  /** Pre-formatted views row (e.g. "110,311,861 views"). */
  total_views_text?: string;
  /** Which row to mark with the yellow vertical highlight bar. */
  highlight_row?: 'handle' | 'country' | 'joined' | 'subscribers' | 'videos' | 'views' | null;
  // ── Fields specific to top_videos_pano composition ──
  /** Array of video items rendered into the 4×2 grid. */
  videos?: Array<{
    video_id: string;
    title: string;
    views: number;
    age_phrase?: string;
    duration_badge?: string;
  }>;
}
export interface ImageGenOutput {
  file_url: string;
  width: number;
  height: number;
}

/** audio_mix — combine narration + sfx + bed music into the final group bed.
 *  Ducks music −6dB under voice with 200ms release per audio-sfx spec. */
export interface AudioMixArgs {
  narration_refs: string[];
  sfx_refs?: string[];
  music_token?: MusicToken;
  /** Ducking attenuation under voice (default −6 dB per spec). */
  ducking_db?: number;
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
  /** Tool implementation version. Bump when the tool's behavior changes
   *  in a way that should invalidate cached outputs (filter formula
   *  changed, composer geometry changed, prompt rewrite, etc.). Bumping
   *  the version is what makes the producer re-run the tool instead of
   *  returning a cached asset. */
  version?: string;
  /** Field names in args that should be EXCLUDED from the cache key. Use
   *  for things like force=true / sync=true / timestamps that should
   *  trigger a fresh run but not invalidate other callers' cache hits. */
  cache_key_excludes?: string[];
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
        annotate_shape:   { type: 'string', enum: ['sharpie_circle', 'arrow', 'circle_with_label', 'glow_ring', 'underline', 'vertical_bar'], description: 'Used when annotate_kind=composite.' },
        annotate_label:   { type: 'string', description: 'Label text for circle_with_label shape.' },
        annotate_arrow_from: { type: 'string', enum: ['top', 'bottom', 'left', 'right', 'top_left', 'top_right', 'bottom_left', 'bottom_right'] },
        force: { type: 'boolean' },
      },
    },
    output_fields: ['file_url', 'asset_kind', 'bboxes', 'page_width', 'page_height', 'duration_s'],
    // v1.1.0: extractor now captures per-card displayed view-count TEXT
    // (__meta.views_texts) — bump invalidates stale captures without it.
    version: 'v1.1.0',
    cache_key_excludes: ['force'],
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
    version: 'v1.0.0',
  },
  {
    name: 'clip_extract',
    description: 'Cut [clip_start, clip_end) seconds out of a real channel video (yt-dlp cached download + ffmpeg trim, audio kept for diegetic mix). Powers mini_player b-roll in recipe_demo beats. Builder-generated only.',
    args_schema: {
      type: 'object',
      required: ['video_url', 'clip_start', 'clip_end'],
      additionalProperties: false,
      properties: {
        video_url:  { type: 'string' },
        clip_start: { type: 'number' },
        clip_end:   { type: 'number' },
      },
    },
    output_fields: ['file_url', 'duration_s', 'asset_kind'],
    version: 'v1.0.0',
  },
  {
    name: 'audio_slice',
    description: 'Cut a [start_s, end_s) span out of a continuous master narration mp3 (produced by ttsWithTimestamps). Builder-generated only — the writer never emits this.',
    args_schema: {
      type: 'object',
      required: ['src', 'start_s', 'end_s'],
      additionalProperties: false,
      properties: {
        src:     { type: 'string', description: 'Absolute path of the master narration mp3.' },
        start_s: { type: 'number' },
        end_s:   { type: 'number' },
      },
    },
    output_fields: ['file_url', 'duration_s'],
    version: 'v1.0.0',
  },
  {
    name: 'sfx_render',
    description: 'Render an SFX track from one or more canonical SFX tokens. NEVER stack more than one SFX per cut (audio-sfx exclude rule). `ding` is mandatory on every $ reveal (pitch rises with figure size); `whoosh` is the default text-card cut transition; `ascending_electronic_sting` is reserved for the final CTA beat.',
    args_schema: {
      type: 'object',
      required: ['tokens'],
      additionalProperties: false,
      properties: {
        tokens: {
          type: 'array', minItems: 1, maxItems: 2,
          items: { type: 'string', enum: [...SFX_TOKENS] },
        },
        fit_duration_s: { type: 'number', minimum: 0.1 },
      },
    },
    output_fields: ['file_url', 'duration_s'],
    version: 'v1.0.0',
  },
  {
    name: 'image_gen',
    description: 'Generate a non-YT visual: text_card (narration cards), icon_card (line-drawing illustration), chalkboard_card (concept tag, max 1 per niche), or text_card_in_title_sequence (intro). bg_mode follows the visual-grammar rule: white for narration, dark_gray for YT-world / proof.',
    args_schema: {
      type: 'object',
      required: ['composition', 'text', 'bg_mode'],
      additionalProperties: false,
      properties: {
        composition:     { type: 'string', enum: ['text_card', 'text_card_reveal', 'icon_card', 'chalkboard_card', 'text_card_in_title_sequence', 'most_popular_callout', 'channel_about_panel', 'top_videos_pano'] },
        text:            { type: 'string' },
        color_treatment: { type: 'string', enum: [...COLOR_TREATMENTS] },
        bg_mode:         { type: 'string', enum: ['white', 'dark_gray'] },
        icon:            { type: 'string', enum: [...ICON_IDS], description: 'Required when composition=icon_card.' },
        // most_popular_callout fields
        video_id:          { type: 'string', description: 'most_popular_callout: YT video id.' },
        views:             { type: 'number', description: 'most_popular_callout: raw view count.' },
        age_phrase:        { type: 'string', description: 'most_popular_callout: pre-formatted relative age.' },
        duration_badge:    { type: 'string', description: 'most_popular_callout: duration overlay.' },
        channel_watermark: { type: 'string', description: 'most_popular_callout: thumbnail watermark text.' },
        // channel_about_panel fields
        handle:            { type: 'string', description: 'channel_about_panel: handle (e.g. @VESSTICK).' },
        country:           { type: 'string', description: 'channel_about_panel: country line.' },
        joined_phrase:     { type: 'string', description: 'channel_about_panel: "Joined DD Mon YYYY".' },
        subscribers_text:  { type: 'string', description: 'channel_about_panel: subscribers row text.' },
        video_count_text:  { type: 'string', description: 'channel_about_panel: videos row text.' },
        total_views_text:  { type: 'string', description: 'channel_about_panel: views row text.' },
        highlight_row:     { type: ['string', 'null'], enum: ['handle', 'country', 'joined', 'subscribers', 'videos', 'views', null], description: 'channel_about_panel: which row to mark with the yellow vertical bar.' },
        // top_videos_pano fields
        videos:            { type: 'array', description: 'top_videos_pano: up to 8 entries with {video_id, title, views, age_phrase?, duration_badge?}.',
                             items: { type: 'object', additionalProperties: true } },
      },
    },
    output_fields: ['file_url', 'width', 'height'],
    version: 'v1.0.0',
  },
  {
    name: 'logos_montage',
    description: 'Render a 2×5 channel-avatar montage (MG-style "Number N" niche reveal) — 10 circular logos on a white canvas. Used together with ken_burns="zoom_in_to_target" + target_idx to zoom into the channel being revealed in each niche.',
    args_schema: {
      type: 'object',
      required: ['channelIds'],
      additionalProperties: false,
      properties: {
        channelIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10,
                      description: 'Ordered list of channel IDs (target_idx maps to this position).' },
      },
    },
    output_fields: ['file_url', 'local_path'],
    version: 'v1.0.0',
  },
  {
    name: 'audio_mix',
    description: 'Mix narration + SFX + bed music into a group-level audio bed. Ducks music −6 dB under voice with 200 ms release per audio-sfx spec. Music switches at niche/section/mode boundaries; default is `upbeat_light`.',
    args_schema: {
      type: 'object',
      required: ['narration_refs'],
      additionalProperties: false,
      properties: {
        narration_refs: { type: 'array', items: { type: 'string' }, minItems: 1 },
        sfx_refs:       { type: 'array', items: { type: 'string' } },
        music_token:    { type: 'string', enum: [...MUSIC_TOKENS] },
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
