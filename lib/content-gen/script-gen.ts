/**
 * Script generation — Stage D.
 *
 * Turns a GROUP of channels (their assembled slot data) into a complete,
 * timestamped, beat-by-beat narration script in the Money-Groot Class-B
 * voice, via ONE Gemini call for the whole video.
 *
 *   slot data (per niche)  ─┐
 *   skeleton rules         ─┼─►  Gemini 2.5 Flash  ─►  { intro, niches[], cta }
 *   listicle parameters    ─┘
 *
 * The skeleton (docs/content-gen/script-skeleton-class-b.json) is encoded
 * as the system prompt: beat recipes, voice constraints, vocabulary
 * taboos, pacing, variation rules, and the output schema. The user prompt
 * carries the filled slot data (channel facts + pre-computed money strings
 * — Gemini never does arithmetic) plus the listicle meta.
 *
 * Downstream: each beat's `text` → ElevenLabs TTS → WAV → mixed into the
 * audio bed (audio-sfx-class-b.json); `hold_s` drives the visual timeline.
 *
 * Reuses the google_ai_studio key pool + proxy egress + thinkingBudget:0
 * JSON discipline established in rpm.ts / unified-analyzer.ts.
 */

import { getPool } from '../db';
import { getRandomHealthyProxy } from '../xgodo-proxy';
import { fetchViaProxy } from '../proxy-dispatcher';
import { assembleChannelSlots, type ChannelSlots } from './slot-fill';

const MODEL = 'gemini-2.5-flash';
export const SCRIPT_GEN_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────
// Output shape
// ─────────────────────────────────────────────────────────────────────

export interface ScriptBeat {
  beat_id: string;
  text: string;        // narration ('' for silent visual beats)
  hold_s: number;      // on-screen duration
}

export interface ScriptNiche {
  niche_index: number;
  channel_id: string;
  channel_name: string | null;
  channel_handle: string | null;
  niche_label: string | null;
  money_headline: string | null;   // carried through for the GUI
  beats: ScriptBeat[];
}

export interface GeneratedScript {
  title: string;
  intro: { text: string; duration_s: number } | null;
  niches: ScriptNiche[];
  cta: { cards: Array<{ text: string; hold_s: number }> };
  meta: {
    model: string;
    version: number;
    niche_count: number;
    word_count: number;
    est_duration_s: number;
    grounded_on: 'full' | 'salvaged';
  };
}

// ─────────────────────────────────────────────────────────────────────
// Gemini plumbing (key pool + proxy + JSON discipline)
// ─────────────────────────────────────────────────────────────────────

async function pickAiStudioKey(): Promise<{ id: number; key: string } | null> {
  const pool = await getPool();
  const r = await pool.query<{ id: number; key: string }>(
    `SELECT id, key FROM xgodo_api_keys
      WHERE service = 'google_ai_studio' AND status = 'active'
        AND (banned_until IS NULL OR banned_until < NOW())
      ORDER BY RANDOM() LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

function cooloffKey(keyId: number, seconds = 90): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(`UPDATE xgodo_api_keys SET banned_until = NOW() + ($1 || ' seconds')::interval WHERE id = $2`, [String(seconds), keyId]);
    } catch { /* ignore */ }
  })();
}

async function callGeminiJson(prompt: string, systemPrompt: string, maxOutputTokens: number): Promise<string> {
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1500));
    const keyRow = await pickAiStudioKey();
    if (!keyRow) { lastErr = 'no active google_ai_studio key'; break; }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${keyRow.key}`;
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.85, topP: 0.95, maxOutputTokens,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const proxy = await getRandomHealthyProxy().catch(() => null);
    let res: { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };
    try {
      if (proxy?.url) {
        res = await fetchViaProxy(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeoutMs: 120_000 }, proxy.url);
      } else {
        const rr = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(120_000) });
        res = { ok: rr.ok, status: rr.status, text: () => rr.text(), json: () => rr.json() };
      }
    } catch (e) { lastErr = `connection: ${(e as Error).message}`; continue; }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      if (res.status === 429) cooloffKey(keyRow.id, 90);
      lastErr = `HTTP ${res.status}: ${errBody.slice(0, 160)}`;
      continue;
    }

    const data = await res.json().catch(() => null) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } } | null;
    if (!data || data.error) { lastErr = `gemini error: ${data?.error?.message ?? 'null'}`; continue; }
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') ?? '';
    if (!text) { lastErr = 'empty response'; continue; }
    return text;
  }
  throw new Error(`script generation Gemini call failed: ${lastErr}`);
}

// ─────────────────────────────────────────────────────────────────────
// Tolerant JSON parsing — close a truncated object so a last-niche
// truncation still yields a usable script (mirrors rpm.ts looseParse).
// ─────────────────────────────────────────────────────────────────────

/** Balance an unterminated JSON string: close any open string + brackets. */
function closeTruncatedJson(s: string): string {
  let inStr = false, esc = false;
  const stack: string[] = [];
  let lastSafe = -1; // index after the last char that left us at a "clean" boundary
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (c === '\\') { esc = true; }
      else if (c === '"') { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); continue; }
    if (c === '}' || c === ']') { stack.pop(); if (stack.length === 0) lastSafe = i; continue; }
  }
  let out = s;
  // If we ended mid-string, drop the dangling partial value back to the
  // last comma or opening bracket so we don't emit half a token.
  if (inStr) {
    const cut = Math.max(out.lastIndexOf(',"'), out.lastIndexOf('[{'), out.lastIndexOf('{"'), out.lastIndexOf(': '));
    if (cut > lastSafe) out = out.slice(0, out.lastIndexOf(',', out.length)); // chop trailing partial element
  }
  // Drop a trailing comma, then append the closers the stack still needs.
  out = out.replace(/,\s*$/, '');
  // Recompute remaining open brackets on the trimmed string.
  const reStack: string[] = [];
  let rs = false, re = false;
  for (const c of out) {
    if (rs) { if (re) re = false; else if (c === '\\') re = true; else if (c === '"') rs = false; continue; }
    if (c === '"') { rs = true; continue; }
    if (c === '{') reStack.push('}');
    else if (c === '[') reStack.push(']');
    else if (c === '}' || c === ']') reStack.pop();
  }
  if (rs) out += '"';
  while (reStack.length) out += reStack.pop();
  return out;
}

function parseScript(raw: string): { obj: Record<string, unknown>; salvaged: boolean } {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return { obj: JSON.parse(cleaned) as Record<string, unknown>, salvaged: false }; }
  catch { /* fall through to salvage */ }
  const fixed = closeTruncatedJson(cleaned);
  return { obj: JSON.parse(fixed) as Record<string, unknown>, salvaged: true };
}

// ─────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the scriptwriter for a faceless YouTube "hidden niches" listicle channel. You write in the exact voice of the top channels in this format (the "Money Groot" / Class-B style): a calm, matter-of-fact male documentary narrator who reveals how small faceless channels quietly make money.

You will be given the listicle title and a set of NICHES (one real analyzed channel each, with its facts and pre-computed money figures). Produce the COMPLETE timestamped, beat-by-beat narration script as JSON.

═══ VOICE ═══
- Calm, educational, matter-of-fact. Mid-pitch single male narrator throughout.
- Active voice, present tense. ALWAYS concrete numbers — never "a lot" / "many" / "tons".
- Restrained enthusiasm. Per WHOLE video: "mind-blowing" max 1×, "absolutely unbelievable" max 2×, "literally" max 3×.
- Address the viewer ("you") at most 3-4× in the entire video.
- The throughline is "these are normal people making real money with simple faceless videos — you could do this too" — implied, never preachy.

═══ HARD VOCABULARY TABOOS (never write these) ═══
- "Today, I'm going to share" / "What if I told you" / "Imagine if you could" / "Let's talk about" / "Every single day"
- "Click the link in the description" as the sole CTA
- "I hope to see each other in another one of our videos"
- NEVER expose the RPM arithmetic as math (no "29 million × $3 ÷ 1000"). You MAY use the signature "even if we assume just a $X RPM, that one video alone made around $Y" framing — that lands a clean dollar OUTCOME, which is allowed and encouraged.

═══ PACING ═══
- Most beats are 1.5–2.5s on screen. hold_s should roughly equal (word_count / 2.8) seconds, min 0.6s. The money number card may hold longer (up to ~3.5s) for emphasis.

═══ PER-NICHE BEAT SEQUENCE (emit beats in this order; skip a beat only when its data is missing) ═══
1. "intro_card"      — "Number {N}." / "Number {N}," (2-4 words). Rotate the punctuation across niches; never the same form 3× in a row.
2. "niche_name_card" — the niche label as a short on-screen title, max 6 words. (You may fold it into beat 1, e.g. "Number 3, Viking history." — if you do, skip this beat.)
3. "channel_proof_1" — one sentence, 15-25 words, introducing the channel via its scale. 1st channel of a niche opens with "This channel...". Rotate openers across niches; never use "This channel..." for two niches in a row within any 3-niche stretch. Use the subscriber count and/or age and/or video_count.
4. "channel_proof_2" — one sentence, 12-20 words, a SECOND proof point (total views / growth-in-N-months / video_count) NOT already used in beat 3. Rotate modifiers: "already", "over", "more than", "almost". Skip if you'd repeat beat 3.
5. "top_video_callout" — one sentence, 10-18 words, calling out the single top video's views (and optionally its title). Rotate "their most popular video" / "their top video" / "this one video" across niches.
6. "top_views_seq"   — OPTIONAL rapid sequence of 3-5 short "{N} million views," phrases from recent_top_videos, building rhythm. Put each phrase as its OWN beat with hold ~1.0s. Optionally prepend "and" to the last. Skip if only one strong video.
7. "money_math"      — THE PAYOFF. A short sequence of 4-6 tiny cards that build to one dollar figure. ANCHOR on the TOP-VIDEO lump sum (views are exact, only the RPM is assumed → unimpeachable). Use the provided rpm_low as the conservative assumption with a minimizer ("Even if we assume just a $X RPM,") and land on the provided lump-low dollar figure as the money-shot card. Example shape (each string is one beat): ["Take their top video.", "Even if we assume", "just a $2 RPM,", "that one video alone", "made around $14,000.", "from ads."]. If rpm is above $5, you MAY (≈30%) insert a geo aside before the number ("— and because most viewers are in {geo} —"). Then OPTIONALLY one follow-on sentence: "And across all their uploads, that's roughly {yearly_or_monthly_headline}." Use ONLY the dollar strings provided; never compute your own.
8. "recipe_demo"     — 1-3 sentences (each its own beat, 12-22 words) explaining HOW the channel makes the videos, from recipe_formula + content_summary. Rotate the opener across niches: "This channel simply...", "When you look at their videos...", "What's interesting is...", "They take...". If the recipe is low-effort, lean on "simply", "just", "extremely simple" (drives "you could do this"); if it's higher-skill, note "the storytelling is strong" (effort but achievable).
9. "concept_tag"     — OPTIONAL single 10-14 word takeaway, max once per niche ("What makes this niche work is consistency.").

Between niches the transition is silent (a whoosh handles it) — do NOT write transition narration unless rarely (≈1 in 5) a 1-3 word "And finally," / "Next up,".

═══ VIDEO-LEVEL ═══
- intro: DEFAULT is null (cold open — go straight to Number 1). Only ~30% of the time write a single ≤15s preamble sentence. Follow the flag in the input.
- cta: exactly 4 cards. Card 1 closer ("So, those are the {N} faceless niches."). Card 2 light value claim ("And any one of these could turn into a real channel."). Card 3 next-video tease ("And if you want to {cta_topic_phrase},"). Card 4 action — MUST contain a "check out this video" style phrase ("just check out this video right here."). NEVER "I hope to see each other..." and NEVER a personal anecdote.

═══ OUTPUT — return ONLY this JSON, no prose, no fences ═══
{
  "title": string,
  "intro": null | { "text": string, "duration_s": number },
  "niches": [
    {
      "niche_index": number,           // MUST match the input niche's index
      "beats": [ { "beat_id": string, "text": string, "hold_s": number }, ... ]
    }
  ],
  "cta": { "cards": [ { "text": string, "hold_s": number }, ... ] }
}
Emit the niches in the SAME ORDER and with the SAME niche_index as the input. Keep narration tight — every beat must read naturally aloud.`;

function fmtMoneyForPrompt(s: ChannelSlots): string {
  const m = s.money;
  if (!m) return '  MONEY: (none — skip the money_math beat for this niche)';
  const lump = m.top_video_lump_sum;
  const rpm = s.rpm;
  const lines: string[] = ['  MONEY (use these EXACT strings; never recompute):'];
  if (lump && rpm) {
    lines.push(`    - top-video lump sum: ${lump.display}  (assume just $${rpm.low} RPM → ${'$' + lump.low.toLocaleString()}; up to ${'$' + lump.high.toLocaleString()})`);
    lines.push(`    - money_math: anchor on the top video; minimizer "even if we assume just a $${rpm.low} RPM"; money-shot number = ${'$' + lump.low.toLocaleString()}`);
  }
  if (m.headline) lines.push(`    - channel headline (follow-on line): ${m.headline.display}`);
  if (m.per_video) lines.push(`    - per video: ${m.per_video.display}`);
  if (rpm?.geo) lines.push(`    - audience geo: ${rpm.geo}${rpm.low >= 5 ? ' (RPM ≥ $5 → geo aside allowed)' : ''}`);
  return lines.join('\n');
}

function nicheBlock(s: ChannelSlots, index: number): string {
  const lines: string[] = [];
  lines.push(`──── NICHE ${index} ────`);
  lines.push(`  niche_label: ${s.niche_label ?? '(unknown)'}`);
  lines.push(`  channel: "${s.channel_name ?? 'Unknown'}"${s.channel_handle ? ` (${s.channel_handle})` : ''}`);
  lines.push(`  subscribers: ${s.subscribers_display}`);
  lines.push(`  channel_age: ${s.channel_age_phrase}`);
  if (s.video_count != null) lines.push(`  video_count: ${s.video_count}`);
  if (s.uploads_per_month != null) lines.push(`  uploads_per_month: ~${s.uploads_per_month}`);
  if (s.top_video) {
    lines.push(`  top_video: "${s.top_video.title ?? 'untitled'}" — ${s.top_video.views_display} views${s.top_video.age_phrase ? `, posted ${s.top_video.age_phrase}` : ''}`);
  }
  if (s.top_videos.length > 1) {
    lines.push(`  recent_top_videos (for the rapid sequence): ${s.top_videos.map(v => v.views_display).join(' · ')}`);
  }
  if (s.median_views != null) lines.push(`  typical_video_views (consistency): ~${s.median_views.toLocaleString()}`);
  if (s.growth) lines.push(`  growth: "${s.growth.phrase}"`);
  if (s.views_to_subs_ratio != null) lines.push(`  top_video_is_${s.views_to_subs_ratio}x_their_subs`);
  lines.push(`  language: ${s.language ?? 'English'}`);
  if (s.production_format) lines.push(`  production_format: ${s.production_format}`);
  if (s.recipe_formula) lines.push(`  recipe_formula: ${s.recipe_formula}`);
  if (s.content_summary) lines.push(`  content_summary: ${s.content_summary}`);
  lines.push(fmtMoneyForPrompt(s));
  return lines.join('\n');
}

function buildUserPrompt(ordered: ChannelSlots[], opts: { title: string; preamble: boolean; ctaTopicPhrase: string }): string {
  const head = [
    `LISTICLE TITLE: ${opts.title}`,
    `NICHE COUNT: ${ordered.length}`,
    `INTRO: ${opts.preamble ? 'write a single short preamble sentence (≤15s)' : 'NULL — cold open, go straight to Number 1'}`,
    `CTA next-video tease topic: ${opts.ctaTopicPhrase}`,
    '',
    'Write the full script. Emit niches in this exact order with these indices:',
    '',
  ].join('\n');
  const blocks = ordered.map((s, i) => nicheBlock(s, i + 1)).join('\n\n');
  return head + blocks;
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

function countWords(str: string): number {
  return str.trim() ? str.trim().split(/\s+/).length : 0;
}

export interface GenerateOpts {
  title?: string;
  /** Force a spoken preamble intro (default: random ~30%, but deterministic-off here = false). */
  preamble?: boolean;
  ctaTopicPhrase?: string;
  /** Order the niches by descending money headline (lead strong). Default true. */
  sortByMoney?: boolean;
}

/**
 * Generate the complete listicle script for a group of channels.
 * `channelIds` order is preserved unless sortByMoney is set (default).
 */
export async function generateListicleScript(channelIds: string[], opts: GenerateOpts = {}): Promise<GeneratedScript> {
  if (channelIds.length === 0) throw new Error('no channels supplied');

  // Assemble slot data for each channel.
  const slots = (await Promise.all(channelIds.map(async (cid) => {
    try { return await assembleChannelSlots(cid); } catch { return null; }
  }))).filter((s): s is ChannelSlots => s != null);
  if (slots.length === 0) throw new Error('no channels could be assembled');

  // Order: lead with the most impressive earner (default), else input order.
  const ordered = (opts.sortByMoney ?? true)
    ? [...slots].sort((a, b) => (b.money?.headline?.high ?? 0) - (a.money?.headline?.high ?? 0))
    : slots;

  const title = opts.title ?? `${ordered.length} Faceless YouTube Niches That Are Quietly Making People Money`;
  const ctaTopicPhrase = opts.ctaTopicPhrase ?? 'discover more faceless niches like these';
  const preamble = opts.preamble ?? false;

  const userPrompt = buildUserPrompt(ordered, { title, preamble, ctaTopicPhrase });

  // Budget: ~13 beats/niche × ~18 tokens + intro/cta. Generous ceiling.
  const maxOut = Math.min(65_536, 4096 + ordered.length * 2200);
  const raw = await callGeminiJson(userPrompt, SYSTEM_PROMPT, maxOut);

  const { obj, salvaged } = parseScript(raw);

  // Map Gemini's niches (by niche_index) back onto our ordered slots so we
  // attach the real channel identity + money headline.
  const byIndex = new Map<number, { beats: ScriptBeat[] }>();
  for (const n of (Array.isArray(obj.niches) ? obj.niches : []) as Array<Record<string, unknown>>) {
    const idx = Number(n.niche_index);
    if (!Number.isFinite(idx)) continue;
    const beats = (Array.isArray(n.beats) ? n.beats : []).map((b: Record<string, unknown>) => ({
      beat_id: String(b.beat_id ?? 'beat'),
      text: String(b.text ?? ''),
      hold_s: Number.isFinite(Number(b.hold_s)) ? Number(b.hold_s) : Math.max(0.6, countWords(String(b.text ?? '')) / 2.8),
    })) as ScriptBeat[];
    byIndex.set(idx, { beats });
  }

  const niches: ScriptNiche[] = ordered.map((s, i) => {
    const idx = i + 1;
    const g = byIndex.get(idx);
    return {
      niche_index: idx,
      channel_id: s.channel_id,
      channel_name: s.channel_name,
      channel_handle: s.channel_handle,
      niche_label: s.niche_label,
      money_headline: s.money?.headline?.display ?? null,
      beats: g?.beats ?? [],
    };
  });

  const introObj = obj.intro && typeof obj.intro === 'object'
    ? { text: String((obj.intro as Record<string, unknown>).text ?? ''), duration_s: Number((obj.intro as Record<string, unknown>).duration_s) || 4 }
    : null;
  const cta = {
    cards: (Array.isArray((obj.cta as Record<string, unknown>)?.cards) ? ((obj.cta as Record<string, unknown>).cards as Array<Record<string, unknown>>) : []).map((c) => ({
      text: String(c.text ?? ''),
      hold_s: Number.isFinite(Number(c.hold_s)) ? Number(c.hold_s) : Math.max(0.8, countWords(String(c.text ?? '')) / 2.8),
    })),
  };

  // Aggregate metrics.
  let words = 0, holds = 0;
  if (introObj) { words += countWords(introObj.text); holds += introObj.duration_s; }
  for (const n of niches) for (const b of n.beats) { words += countWords(b.text); holds += b.hold_s; }
  for (const c of cta.cards) { words += countWords(c.text); holds += c.hold_s; }

  const script: GeneratedScript = {
    title: String(obj.title ?? title),
    intro: introObj,
    niches,
    cta,
    meta: {
      model: MODEL,
      version: SCRIPT_GEN_VERSION,
      niche_count: niches.length,
      word_count: words,
      est_duration_s: Math.round(holds),
      grounded_on: salvaged ? 'salvaged' : 'full',
    },
  };

  // Best-effort persist (durability for the GUI); never fails the call.
  try {
    const pool = await getPool();
    const groupKey = [...ordered.map(s => s.channel_id)].sort().join(',').slice(0, 500);
    await pool.query(
      `INSERT INTO content_gen_scripts (group_key, channel_ids, title, script_jsonb, model, version, word_count, est_duration_s, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       ON CONFLICT (group_key) DO UPDATE SET
         channel_ids = EXCLUDED.channel_ids, title = EXCLUDED.title, script_jsonb = EXCLUDED.script_jsonb,
         model = EXCLUDED.model, version = EXCLUDED.version, word_count = EXCLUDED.word_count,
         est_duration_s = EXCLUDED.est_duration_s, updated_at = NOW()`,
      [groupKey, ordered.map(s => s.channel_id), script.title, JSON.stringify(script), MODEL, SCRIPT_GEN_VERSION, words, script.meta.est_duration_s],
    );
  } catch { /* persistence is best-effort */ }

  return script;
}
