/**
 * Script writer — Gemini call that converts (narration beats + channel data)
 * into a producer-ready ConcreteScript with tool calls.
 *
 * Flow:
 *   1. Build a system prompt that inlines the tool registry, the concrete-
 *      script schema, the visual grammar mapping per beat, and a worked
 *      example slot (the EXAMPLE_SLOT_CHANNEL_PROOF_1 reference).
 *   2. Build a user prompt with the narration beats + channel data.
 *   3. Call Gemini Flash via PapaiAPI, parse the JSON.
 *   4. Validate against the schema. On failure, return errors — caller can
 *      retry with the errors injected into the prompt as feedback.
 *
 * This is intentionally a SINGLE-CALL writer (not multi-step) so the LLM has
 * the whole skeleton context at once and can keep slot ordering consistent.
 *
 * Tuning knobs:
 *   - temperature low (0.2) — we want consistent structure, not creative narration
 *   - explicit JSON output (no fences, no markdown)
 *   - "return ONLY the JSON" instruction
 */

import { TOOL_REGISTRY } from './tools';
import { EXAMPLE_SLOT_CHANNEL_PROOF_1 } from './concrete-script.example';
import { validateScript, type ConcreteScript, type ValidationError } from './concrete-script';

/** A narration beat as emitted by the upstream skeleton's Gemini call. */
export interface NarrationBeat {
  beat_id: string;            // matches skeleton beat_id
  text: string;               // narration line (or "" for silent visuals)
  hold_s: number;             // skeleton's suggested duration
  audio_cue?: { sfx?: string[]; music_change?: string };
}

/** Channel data threaded into the script — comes from niche_spy_channels
 *  + channel_analysis tables. The writer uses these as args for yt_capture
 *  and as substitution data in narration validation. */
export interface ChannelData {
  channelId: string;
  channel_name: string;
  subscriber_count?: number;
  total_views?: number;
  video_count?: number;
  joined_date?: string;       // ISO
  top_video_id?: string;
  top_video_title?: string;
  top_video_view_count?: number;
  niche?: string;
  sub_niche?: string;
}

export interface ScriptWriterInput {
  channel: ChannelData;
  niche_index: number;
  video_id: string;
  beats: NarrationBeat[];     // ordered narration beats for this niche
  /** Optional: override default voice for narration */
  voice?: string;
  /** Width/height for the final compose */
  width?: number;
  height?: number;
}

export interface ScriptWriterResult {
  ok: boolean;
  script?: ConcreteScript;
  errors?: ValidationError[];
  raw_response?: string;      // for debugging when parse fails
}

const SCHEMA_SUMMARY = `
ConcreteScript schema (output you must produce):
{
  "schema_version": "1",
  "context": { "channelId": string, "channel_name": string?, "niche_index": int?, "video_id": string? },
  "slots": [
    {
      "slot_id": string,             // unique, lowercase, snake-case (e.g. "niche_1.channel_proof_1")
      "beat_id": string,             // matches the input narration beat
      "narration": string,           // beat's text, "" if silent
      "gems": [
        { "id": string, "tool": string, "args": object }  // tool MUST be one of: ${TOOL_REGISTRY.map(t => t.name).join(', ')}
      ],
      "compose": {
        "bg": "white" | "dark_gray",
        "hold_s": number | "{{narr.duration_s}}",   // use the {{}} ref when there's a tts gem
        "layers": [ { "from": <gem_id>, "channel": "video"|"voice"|"fx"|"overlay", "fit": "contain"?, "ken_burns": "zoom_in_8pct"? } ]
      }
    }
  ],
  "final": { "tool": "video_compose", "args": { "slot_order": [<slot_id...>], "width": int, "height": int, "fps": int } }
}
`.trim();

function toolReferenceBlock(): string {
  return TOOL_REGISTRY.map(t => {
    return `### Tool: ${t.name}
${t.description}

args schema:
\`\`\`json
${JSON.stringify(t.args_schema, null, 2)}
\`\`\`

output fields available for {{ref}} interpolation: ${t.output_fields.join(', ')}`;
  }).join('\n\n');
}

const VISUAL_GRAMMAR_PER_BEAT = `
Visual grammar mapping per skeleton beat_id (use this to pick the right tool calls):

  intro_card           → image_gen composition=text_card  (e.g. "Number 1:")  bg_mode=white
  niche_name_card      → image_gen composition=text_card  bg_mode=white
  mascot_mosaic        → image_gen composition=icon_card  bg_mode=dark_gray   (no narration)
  channel_proof_1      → yt_capture kind=channel_page annotate_element=subscriber_count
                         annotate_kind=composite annotate_shape=sharpie_circle bg=dark_gray
  channel_proof_2      → yt_capture kind=about_page  annotate_element=total_views
                         annotate_kind=composite annotate_shape=sharpie_circle bg=dark_gray
  top_video_callout    → yt_capture kind=videos_tab mode=static annotate_element=view_count
                         annotate_kind=composite annotate_shape=sharpie_circle bg=dark_gray
  top_views_seq        → yt_capture kind=videos_tab mode=static  (no annotation — sequence of card crops)
  top_views_pano       → yt_capture kind=videos_tab mode=scroll_record  (no annotation)
  money_math           → image_gen composition=text_card OR icon_card per card in the skeleton's card_sequence_template
  recipe_demo          → external clips (out of scope for this writer; treat as text_card fallback)
  concept_tag          → image_gen composition=chalkboard_card bg_mode=dark_gray
  transition           → silent — no main visual gem; just sfx
  video_intro          → image_gen composition=text_card_in_title_sequence  (skip when default behaviour)
  video_cta            → image_gen composition=text_card per card

When a beat has narration:
  - ALWAYS include a tts gem with id="narr" containing the beat's text
  - Set compose.hold_s = "{{narr.duration_s}}" so the visual is locked to the audio
  - If beat.audio_cue.sfx exists, include a sfx_render gem with id="sfx" and the tokens

When a beat has no narration (mascot_mosaic, transition, silent variants):
  - No tts gem
  - compose.hold_s = numeric (from beat.hold_s)
  - sfx_render is still allowed if audio_cue.sfx is present
`.trim();

export function buildSystemPrompt(): string {
  return `You are the Script-Writer for a faceless YouTube listicle pipeline. Your job is to convert a narration script (a list of beats with text + hold_s) into a producer-ready ConcreteScript with explicit tool calls.

${SCHEMA_SUMMARY}

# Available tools

${toolReferenceBlock()}

# Visual grammar

${VISUAL_GRAMMAR_PER_BEAT}

# Worked example slot (for one beat, channel_proof_1)

\`\`\`json
${JSON.stringify(EXAMPLE_SLOT_CHANNEL_PROOF_1.slots[0], null, 2)}
\`\`\`

# Hard rules

1. Output ONLY the ConcreteScript JSON. No markdown, no code fences, no commentary.
2. Every gem.tool must be one of the registered tools listed above. NEVER invent tools.
3. Every gem.args object must satisfy the tool's args schema (required fields present, no unknown fields).
4. slot_id must be unique within the script. Format: "niche_<N>.<beat_id>".
5. When a beat has narration text, hold_s MUST be the template "{{narr.duration_s}}" — never a number.
6. compose.bg follows the visual grammar mapping above per beat_id.
7. layers ordering matters: video first, then voice, then fx.
8. final.args.slot_order must list every slot_id in playback order.
9. Use the input channel.channelId for every yt_capture's channelId arg — never hardcode.
10. Use the input video_id and niche_index in context.

When uncertain, fall back to the example slot's shape. Do NOT improvise tool args outside the schema.`;
}

export function buildUserPrompt(input: ScriptWriterInput): string {
  return `Generate the ConcreteScript for niche ${input.niche_index} of video ${input.video_id}.

Channel:
${JSON.stringify(input.channel, null, 2)}

Narration beats (in playback order):
${JSON.stringify(input.beats, null, 2)}

Voice: ${input.voice ?? 'money_groot'}
Output dimensions: ${input.width ?? 1080}x${input.height ?? 1920}

Return ONLY the JSON object.`;
}

/** Strip code fences and isolate the JSON object between the first '{' and
 *  last '}'. Same pattern as gemini.ts uses. */
function extractJson(text: string): string {
  let s = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[“”„‟″‶]/g, '"')
    .replace(/[‘’‚‛′‵]/g, "'")
    .trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) s = s.substring(start, end + 1);
  return s;
}

/** Call Gemini Flash to author a ConcreteScript. Validates the output before
 *  returning. */
export async function writeScript(input: ScriptWriterInput, apiKey: string): Promise<ScriptWriterResult> {
  const system = buildSystemPrompt();
  const user = buildUserPrompt(input);
  const response = await fetch(
    'https://papaiapi.com/v1beta/models/gemini-flash:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
          // Force JSON response — the proxy supports the same response_mime_type
          responseMimeType: 'application/json',
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini error ${response.status}: ${errorText.slice(0, 400)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    return { ok: false, errors: [{ path: '(response)', message: 'no text in Gemini response' }], raw_response: JSON.stringify(data).slice(0, 1000) };
  }

  const jsonStr = extractJson(text);
  let parsed: ConcreteScript;
  try {
    parsed = JSON.parse(jsonStr) as ConcreteScript;
  } catch {
    return { ok: false, errors: [{ path: '(parse)', message: 'failed to parse JSON' }], raw_response: jsonStr.slice(0, 1500) };
  }

  const errors = validateScript(parsed);
  if (errors.length > 0) {
    return { ok: false, errors, raw_response: jsonStr.slice(0, 2000) };
  }

  return { ok: true, script: parsed };
}
