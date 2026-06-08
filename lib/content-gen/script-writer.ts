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

import { TOOL_REGISTRY, SFX_TOKENS, MUSIC_TOKENS, ICON_IDS, COLOR_TREATMENTS, DATA_POINT_IDS_FILLABLE, DATA_POINT_IDS_BANNED, DOLLAR_TRIO } from './tools';
import { EXAMPLE_SLOT_CHANNEL_PROOF_1 } from './concrete-script.example';
import { validateScript, type ConcreteScript, type ValidationError } from './concrete-script';
import { getPool } from '../db';
import { getRandomHealthyProxy } from '../xgodo-proxy';
import { fetchViaProxy } from '../proxy-dispatcher';

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
      "slot_id": string,             // unique, snake_case, NO DOTS. e.g. "niche_1_channel_proof_1"
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
Visual grammar — drives gem choice per skeleton beat_id. bg_mode is dictated, not optional:
white = narration cards. dark_gray = YouTube-world / proof captures. Never mix on the same card.

  intro_card           → image_gen composition=text_card  bg_mode=white  ("Number 1:")
  niche_name_card      → image_gen composition=text_card  bg_mode=white
  mascot_mosaic        → image_gen composition=icon_card  bg_mode=dark_gray  (silent, hold 2.0s)
  channel_proof_1      → data_point_id="channel.subscribers"
                         yt_capture kind=channel_page (or about_page) annotate_element=subscriber_count
                         annotate_kind=composite annotate_shape=sharpie_circle  bg=dark_gray
                         SFX: ["whoosh","ding"]   (ding fires on circle reveal)
  channel_proof_2      → data_point_id="channel.total_views"
                         yt_capture kind=about_page annotate_element=total_views
                         annotate_kind=composite annotate_shape=sharpie_circle  bg=dark_gray
                         SFX: ["whoosh","ding"]
  top_video_callout    → data_point_id="video.top_video"  bg=dark_gray
                         yt_capture kind=videos_tab mode=static annotate_element=view_count
                         annotate_kind=composite annotate_shape=sharpie_circle
                         SFX: ["whoosh","ding"]
  top_views_seq        → EXPAND into 3-5 slots (one per "Nm views," phrase). Each slot:
                         data_point_id="video.views" card_index=K  bg=dark_gray
                         yt_capture kind=videos_tab mode=static (the producer crops per card bbox later)
                         tts narrates a short fragment (2-4 words). SFX: ["whoosh"]
  top_views_pano       → data_point_id="video.views"  bg=dark_gray
                         yt_capture kind=videos_tab mode=scroll_record  (no annotation; pan reveals)
  money_math           → EXPAND into 4-6 slots, one per card. Use the skeleton's card_sequence_template.
                         Each card is its own slot with card_index. bg=white EXCEPT the cited
                         top-video card (composition=thumbnail_card → yt_capture videos_tab mode=static,
                         bg=dark_gray). Money-shot card: composition=text_card color_treatment=money_shot_green
                         SFX={ding_high_pitch}. Card 3 (RPM line) optionally uses icon=shrug_with_question_marks.
                         data_point_id rotates: assumption → money.rpm_qualifier (NOT exposed) →
                         shrug_icon → money.lump_sum (the money-shot).
  recipe_demo          → external clip slot. For NOW emit a text_card placeholder describing the recipe.
                         data_point_id="recipe.formula" bg=white
  concept_tag          → data_point_id stays unset OR "competition.saturated".
                         image_gen composition=chalkboard_card  bg=dark_gray   (MAX 1 PER NICHE)
  appreciation_optional→ image_gen composition=text_card  bg=white   (MAX 2 PER VIDEO; place ~50-60% through)
  transition           → silent. No main visual gem. SFX: ["whoosh"] only.
  video_intro          → image_gen composition=text_card_in_title_sequence  bg=white  (skip by default)
  video_cta            → 4 cards. The LAST card (cta.action_card) MUST contain "check out [this/next] video"
                         and SFX includes "ascending_electronic_sting". bg=white throughout CTA.

Narration → tts rules:
  - Beat with narration → ALWAYS gem id="narr", tool="tts", args.voice from input. hold_s = "{{narr.duration_s}}".
  - Beat with no narration (mascot_mosaic, transition default) → no tts gem; hold_s is the literal number from the beat.
  - SFX gem id="sfx", tokens drawn ONLY from the SFX enum. Max 2 tokens, NEVER stack >1 on a single cut visually.
  - When beat.audio_cue.sfx is present, prefer it but coerce token names to the enum (whoosh, ding, etc.).
`.trim();

const HARD_RULES = `
# Hard rules from canonical specs (data-points / slot-rendering / visual-packaging / audio-sfx)

1. NEVER reference these data points in narration or as data_point_id (hard-banned):
     ${DATA_POINT_IDS_BANNED.join(', ')}
   "money.rpm_exposed" means do not say "views × RPM = $". Output the conclusion only ($X figure).
2. Dollar trio is EXCLUSIVE per channel: pick exactly one of ${DOLLAR_TRIO.join(' | ')}
   (whichever rounds cleanly). money.lump_sum is separate and additive ("one video paid $X").
3. data_point_id for each non-structural slot MUST be one of: ${DATA_POINT_IDS_FILLABLE.join(', ')}
   (or omitted for structural beats like intro_card, transition, video_intro).
4. SFX tokens MUST be drawn from: ${SFX_TOKENS.join(', ')}.
   - "ding" is MANDATORY on every $ reveal (money-shot card). Pitch implicit by figure size.
   - "whoosh" is the default cut transition between text-cards.
   - "ascending_electronic_sting" is RESERVED for the final CTA action card.
   - Never stack >2 tokens. Never put 2 SFX on the same instant.
5. Icon ids MUST be drawn from: ${ICON_IDS.join(', ')}.
6. Color treatments MUST be drawn from: ${COLOR_TREATMENTS.join(', ')}.
7. Music tokens MUST be drawn from: ${MUSIC_TOKENS.join(', ')}.
8. bg_mode rule (no exceptions):
     channel.subscribers / channel.total_views / channel.video_count / channel.upload_rate / video.top_video / video.views
       → bg_mode="dark_gray" (yt_screenshot world)
     money.* / niche.category / competition.* / format.* / recipe.formula / cta.*
       → bg_mode="white" (narration world)
9. chalkboard_concept_tag (image_gen composition=chalkboard_card) APPEARS AT MOST ONCE PER NICHE.
10. cta.viewer_appreciation appears AT MOST TWICE PER VIDEO, placed ~50-60% through the body.
11. First segment of niche 1 should be ≤2.0s (faster than MG's 1.42s cold-open).
12. Per-niche total target: 35-60s. Drop slots whose underlying data is unavailable rather than padding.
13. NEVER write any of this fluff:
    - "Today, I'm going to share" / "What if I told you" / "Imagine if you could" / "Let's talk about"
    - personal anecdotes ("I tried it myself", "A while back I thought about starting a channel...")
    - "I hope to see each other in another one of our videos"
    - "click the link in the description" (alone)
    - moralistic outros, forced reactions ("Oh! What!"), tool-channel plugs
    - subscribe-asks framed as gratitude ("These videos take a lot of time...")
14. CTA action card (last of 4) MUST contain the phrase "check out [this/next] video" (winner-coded 17x).
15. Slot expansion:
    - money_math → 4-6 slots, one per card (assumption → optional shrug-icon → RPM qualifier
      → optional top_video thumb → "this would translate to" → money-shot → "from ads")
    - top_views_seq → 3-5 slots, one per "Nm views," phrase
    - money.yearly|daily|monthly → 3 slots ("that's around", "$X/year", "from ads")
    - money.lump_sum → 6 slots per visual grammar sequence
    - all others → 1 slot
`.trim();

export function buildSystemPrompt(): string {
  return `You are the Script-Writer for a faceless YouTube listicle pipeline (Class B / "Money Groot" style). Your job is to convert a narration script (a list of beats with text + hold_s) plus channel data into a producer-ready ConcreteScript with explicit tool calls.

${SCHEMA_SUMMARY}

# Available tools

${toolReferenceBlock()}

# Visual grammar (beat → tool calls)

${VISUAL_GRAMMAR_PER_BEAT}

${HARD_RULES}

# Worked example slot (channel_proof_1)

\`\`\`json
${JSON.stringify(EXAMPLE_SLOT_CHANNEL_PROOF_1.slots[0], null, 2)}
\`\`\`

# Output rules

A. Output ONLY the ConcreteScript JSON. No markdown, no code fences, no commentary.
B. Every gem.tool must be one of the registered tools listed above.
C. Every gem.args object must satisfy the tool's args schema (required fields present, no unknown fields, enum values from the canonical lists).
D. slot_id must be unique, snake_case, NO DOTS. Format: "niche_<N>_<beat>_<card_index?>" e.g. "niche_1_money_math_3".
E. When the slot has a tts gem (id="narr"), compose.hold_s MUST be "{{narr.duration_s}}" — never a number.
F. compose.layers ordering: video → voice → fx.
G. final.args.slot_order lists every slot_id in playback order.
H. Use input.channel.channelId for every yt_capture.channelId — never hardcode the channel id.
I. Set context.channelId / channel_name / niche_index / video_id from input.

When uncertain, fall back to the example slot's shape. Do NOT improvise tool args outside the registered schemas.`;
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

/** Direct Google AI endpoint — gemini-2.5-flash is the current Flash gen.
 *  We call it through an xgodo HTTP proxy + a healthy key from the pool
 *  (same stack video-analysis.ts uses). NO PapaiAPI middle hop — that's
 *  what was causing 504 timeouts. */
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const PER_ATTEMPT_TIMEOUT_MS = 60_000;
// Bumped from 3 → 6 because the google_ai_studio key pool has several
// dead-service-account keys that return 401 ACCOUNT_STATE_INVALID. Each
// 401 marks that key invalid (fire-and-forget) and rotates — 6 retries
// means we can chew through up to 6 bad keys before failing the call.
// Once those are pruned, attempts in practice settle to 1.
const MAX_ATTEMPTS = 6;

/** Pull a random active Google AI key from the xgodo_api_keys pool. */
async function pickHealthyAiKey(): Promise<{ id: number; key: string } | null> {
  const pool = await getPool();
  const r = await pool.query<{ id: number; key: string }>(
    `SELECT id, key
       FROM xgodo_api_keys
      WHERE service = 'google_ai_studio'
        AND status = 'active'
        AND (banned_until IS NULL OR banned_until < NOW())
      ORDER BY RANDOM()
      LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

/** Mark a key invalid so the pool stops serving it. Fire-and-forget — we
 *  don't want a logging failure to mask the original Gemini error. */
function invalidateKey(keyId: number, reason: string): Promise<void> {
  return (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys
            SET status='invalid', invalidated_at=NOW()
          WHERE id=$1 AND status='active'`,
        [keyId],
      );
      console.log(`[script-writer] invalidated google_ai_studio key id=${keyId} (${reason})`);
    } catch { /* ignore */ }
  })();
}

/** Author a ConcreteScript via direct Gemini call through xgodo proxy.
 *  Retries up to MAX_ATTEMPTS on transient failures, rotating both the
 *  key and the proxy each attempt. */
export async function writeScript(input: ScriptWriterInput): Promise<ScriptWriterResult> {
  const system = buildSystemPrompt();
  const user = buildUserPrompt(input);
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ parts: [{ text: user }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
  });

  let lastError: Error | null = null;
  let lastStatus: number | null = null;
  let lastRawBody: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    const keyRow = await pickHealthyAiKey();
    if (!keyRow) {
      lastError = new Error('no active google_ai_studio key available in pool');
      break;
    }
    const proxy = await getRandomHealthyProxy();
    if (!proxy) {
      lastError = new Error('no healthy xgodo proxy available');
      break;
    }
    try {
      const res = await fetchViaProxy(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyRow.key },
        body,
        timeoutMs: PER_ATTEMPT_TIMEOUT_MS,
      }, proxy.url);

      lastStatus = res.status;
      const txt = await res.text();
      const elapsed = Date.now() - t0;

      if (!res.ok) {
        lastRawBody = txt.slice(0, 800);
        lastError = new Error(`Gemini ${res.status} via proxy=${proxy.country ?? '?'} key=${keyRow.id} (${elapsed}ms, attempt ${attempt}/${MAX_ATTEMPTS}): ${lastRawBody}`);
        // 401/403 = dead key (service-account deleted, banned). Mark invalid
        // so the pool stops handing it out, then rotate immediately (no
        // backoff — the next pickHealthyAiKey returns a different key).
        if (res.status === 401 || res.status === 403) {
          await invalidateKey(keyRow.id, `${res.status} on Gemini`);
          if (attempt < MAX_ATTEMPTS) continue;
          break;
        }
        // 400 = prompt / schema issue. Don't retry — that's our bug.
        if (res.status === 400) break;
        // 5xx / 429 → backoff + rotate
        if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 600 * attempt));
        continue;
      }

      // 200 OK — parse Gemini envelope + inner text
      let envelope: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      try {
        envelope = JSON.parse(txt) as typeof envelope;
      } catch {
        lastError = new Error(`parse_error: envelope is not JSON (${elapsed}ms): ${txt.slice(0, 200)}`);
        if (attempt < MAX_ATTEMPTS) continue;
        break;
      }
      const modelText = envelope.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
      if (!modelText) {
        lastRawBody = txt.slice(0, 800);
        lastError = new Error(`no candidates[0].content.parts[0].text (${elapsed}ms)`);
        if (attempt < MAX_ATTEMPTS) continue;
        break;
      }

      const jsonStr = extractJson(modelText);
      let parsed: ConcreteScript;
      try {
        parsed = JSON.parse(jsonStr) as ConcreteScript;
      } catch {
        return { ok: false, errors: [{ path: '(parse)', message: 'failed to parse JSON from model output' }], raw_response: jsonStr.slice(0, 2000) };
      }

      const errors = validateScript(parsed);
      if (errors.length > 0) {
        return { ok: false, errors, raw_response: jsonStr.slice(0, 2000) };
      }
      return { ok: true, script: parsed };
    } catch (e) {
      lastError = e as Error;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 600 * attempt));
        continue;
      }
    }
  }

  return {
    ok: false,
    errors: [{ path: '(call)', message: lastError?.message ?? `failed after ${MAX_ATTEMPTS} attempts (status=${lastStatus})` }],
    raw_response: lastRawBody ?? undefined,
  };
}
