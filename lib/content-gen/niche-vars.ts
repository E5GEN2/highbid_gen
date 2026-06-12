/**
 * NicheVars — the per-niche variable bundle from the worked-example template
 * (docs/content-gen/worked-example-mg-reverse-engineered.md, "Variables this
 * template references"). Pulls the ANALYSIS layer the listicle builder
 * previously ignored:
 *
 *   recipe_formula_simplified ← content_gen_channel_analysis.recipe_formula
 *   recipe beats / summary    ← content_gen_recipe_showcase (transcript-grounded)
 *   rpm                       ← content_gen_channel_rpm (analyzed, not heuristic)
 *   age_phrase                ← niche_spy_channels.channel_created_at
 *   median_views_phrase       ← median(niche_spy_videos.view_count)
 *   upload_rate               ← video_count / channel age
 *
 * Channel stats themselves stay in loadChannel (listicle-builder) — this
 * module is purely additive so there is no import cycle.
 */

import { getPool } from '../db';
import type { ShowcaseBeat } from './recipe-showcase';

export interface NicheVars {
  channelId: string;
  /** Verb phrase completing "This channel ___." — rule-simplified from the
   *  analysis recipe_formula. Null when the channel was never analyzed. */
  recipe_formula_simplified: string | null;
  recipe_summary: string | null;
  /** Transcript-grounded {narration, clip_start, clip_end} beats for
   *  recipe_demo (content_gen_recipe_showcase.beats_jsonb). */
  recipe_beats: ShowcaseBeat[];
  /** Analyzed RPM (content_gen_channel_rpm). Narration uses a whole-dollar
   *  rounding of rpm_typical per the spec's $1/$3/$6/$10 vocabulary. */
  rpm_typical: number | null;
  rpm_low: number | null;
  rpm_high: number | null;
  geo_guess: string | null;
  /** "about 13 months old" / "over a year old" — from channel_created_at. */
  age_phrase: string | null;
  /** "hundreds of thousands of views per upload" — median view class. */
  median_views_phrase: string | null;
  uploads_per_month: number | null;
  /** Short niche-essence phrase for the chalkboard (concept_tag beat) —
   *  e.g. "SCALE SHOCK" / "ABSURD RANKING". Null → beat skipped. */
  concept_word: string | null;
  /** One-sentence insight: what this niche is REALLY about at its core
   *  (the concept_tag narration). */
  concept_insight: string | null;
}

/** Spoken-friendly view counts: "29 million", "8.8 million", "107 thousand".
 *  (humanizeNumber keeps a trailing .0 — bad for TTS.) */
export function spokenNumber(n: number): string {
  const fmt = (v: number, unit: string) => {
    const s = v >= 10 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString();
    return `${s.replace(/\.0$/, '')} ${unit}`;
  };
  if (n >= 1e9) return fmt(n / 1e9, 'billion');
  if (n >= 1e6) return fmt(n / 1e6, 'million');
  if (n >= 1e3) return fmt(n / 1e3, 'thousand');
  return String(n);
}

/** Rule-based one-clause simplification of the analysis recipe_formula into
 *  a verb phrase for "This channel ___." Stored formulas open with "Videos
 *  are/feature/show…" — map the opener, keep the first clause, cap length.
 *  (v2: Gemini one-clause rewrite, cached — see single-channel-beat-plan.md) */
export function simplifyRecipeFormula(formula: string | null | undefined): string | null {
  if (!formula) return null;
  let s = formula.trim();
  // First sentence only.
  const dot = s.indexOf('. ');
  if (dot > 20) s = s.slice(0, dot);
  s = s.replace(/\.$/, '');

  const maps: Array<[RegExp, string]> = [
    [/^videos are\s+/i, 'makes '],
    [/^videos feature\s+/i, 'makes videos featuring '],
    [/^videos show\s+/i, 'makes videos showing '],
    [/^videos consist of\s+/i, 'makes '],
    [/^videos present\s+/i, 'makes videos presenting '],
    [/^each video (is|shows|features)\s+/i, 'makes videos with '],
    [/^the channel\s+/i, ''],
    [/^this channel\s+/i, ''],
  ];
  for (const [re, rep] of maps) {
    if (re.test(s)) { s = s.replace(re, rep); break; }
  }
  // If it still doesn't read as a verb phrase, wrap it.
  if (!/^(makes|creates|uploads|records|posts|compiles|narrates|produces|simply|just|uses|explains|covers|shows|features|tells|presents|compares|ranks|builds|edits|animates|documents)/i.test(s)) {
    s = `makes ${s}`;
  }
  // Cap at ~18 words at a NATURAL boundary (", " / " with " / " and " /
  // " against ") so the clause never cuts mid-phrase (template: one clause).
  const words = s.split(/\s+/);
  if (words.length > 18) {
    const head = words.slice(0, 18).join(' ');
    const cutAt = Math.max(
      head.lastIndexOf(', '), head.lastIndexOf(' with '),
      head.lastIndexOf(' and '), head.lastIndexOf(' against '));
    s = (cutAt > 30 ? head.slice(0, cutAt) : head).replace(/[,;]\s*$/, '');
  }
  // Lowercase the lead (mid-sentence position after "This channel").
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function agePhrase(createdAt: string | null): string | null {
  if (!createdAt) return null;
  const months = Math.max(1, Math.round((Date.now() - new Date(createdAt).getTime()) / (30.44 * 24 * 3600 * 1000)));
  if (months < 12) return `about ${months} month${months === 1 ? '' : 's'} old`;
  if (months < 18) return 'over a year old';
  if (months < 24) return 'about a year and a half old';
  const years = Math.round(months / 12);
  return `about ${years} years old`;
}

function medianViewsPhrase(median: number | null): string | null {
  if (median == null || median < 1000) return null;
  if (median >= 1e6) return 'millions of views';
  if (median >= 1e5) return 'hundreds of thousands of views';
  if (median >= 1e4) return 'tens of thousands of views';
  return 'thousands of views';
}

/**
 * Gemini one-clause recipe line via PapaiAPI, cached in
 * content_gen_channel_analysis.recipe_formula_simple. The analysis
 * recipe_formula is a vision-model description ("Videos feature black
 * silhouettes against a grey, cloudy sky…") — too literal/visual for
 * narration (user feedback 2026-06-11). This rewrites it MG-style:
 * what kind of CONTENT it is, 8-12 plain words, verb-first.
 */
async function generateRecipeLine(
  channelId: string,
  nicheLabel: string | null,
  formula: string | null,
  summary: string | null,
): Promise<{ line: string; concept: string | null; insight: string | null } | null> {
  if (!formula && !summary) return null;
  const pool = await getPool();
  // Same key+proxy stack as recipe-showcase (PapaiAPI is unreachable from
  // some networks; AI Studio keys via xgodo proxy work everywhere).
  const keyRow = await pool.query<{ id: number; key: string }>(
    `SELECT id, key FROM xgodo_api_keys
      WHERE service = 'google_ai_studio' AND status = 'active'
        AND (banned_until IS NULL OR banned_until < NOW())
      ORDER BY RANDOM() LIMIT 1`);
  const apiKey = keyRow.rows[0]?.key;
  if (!apiKey) return null;

  const prompt = `You write spoken narration for a YouTube video about small faceless channels.
The narrator has JUST announced the niche name: "${nicheLabel ?? 'unknown'}".
Your line comes immediately after it and completes: "This channel ___."

Style — match the tone of these reference lines (note how each adds the
HOW — the production format — beyond the niche name that preceded it):
- niche "Funny Stickman Fails" → "simply records gameplay of a stickman fail game and uploads it"
- niche "Roblox Lore" → "makes explanation-style videos about different Roblox games"
- niche "Pet Clip Compilations" → "compiles viral pet clips into quick montages with trending audio"

Rules for "line":
- 8 to 12 words, ONE clause
- Start with a verb: makes / posts / creates / records / compiles / narrates
- Do NOT restate or rephrase the niche name — the viewer just heard it.
  Add NEW information: the format, how the videos are made, or what
  happens in them
- No visual details like colors, backgrounds, or silhouettes
- Plain conversational words, no flowery adjectives

Also produce the niche-concept pair (for a chalkboard "here's what this
niche is really about" beat):
- "concept": the niche's CORE CONCEPT as a punchy 1-3 word phrase,
  uppercase — what the niche is fundamentally about, NOT a generic
  virtue. Examples: "ABSURD RANKING", "SCALE SHOCK", "LORE DECODING",
  "FEAR BY NUMBERS". Never words like CONSISTENCY/QUALITY/PASSION.
- "insight": ONE spoken sentence (12-18 words) explaining what the
  niche is really about at its core — the psychological hook, why
  viewers can't look away. Plain conversational words. Example: "At its
  core, this niche is about scale — making unimaginable sizes feel real
  next to things you know."

Output ONLY JSON: {"line": "...", "concept": "...", "insight": "..."}

Channel data:
Video description: ${formula ?? '—'}
Recipe summary: ${summary ?? '—'}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
  });
  // DIRECT first (works from local dev — the key is the auth); proxy
  // fallback for Railway where egress IP diversity matters.
  let res: { ok: boolean; status: number; json(): Promise<unknown> } | null = null;
  try {
    const rr = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(60_000) });
    res = { ok: rr.ok, status: rr.status, json: () => rr.json() };
  } catch { /* direct egress blocked — try proxy */ }
  if (!res || !res.ok) {
    try {
      const { getRandomHealthyProxy } = await import('../xgodo-proxy');
      const { fetchViaProxy } = await import('../proxy-dispatcher');
      const proxy = await getRandomHealthyProxy().catch(() => null);
      if (proxy?.url) {
        res = await fetchViaProxy(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeoutMs: 60_000 }, proxy.url);
      }
    } catch { /* both paths failed */ }
  }
  if (!res || !res.ok) { console.warn(`[recipe-line] gemini HTTP ${res?.status ?? 'ERR'} for ${channelId}`); return null; }
  const data = await res.json().catch(() => null) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null;
  const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('').trim() ?? '';
  let line = '';
  let concept: string | null = null;
  let insight: string | null = null;
  try {
    const j = JSON.parse(raw.replace(/^```(json)?/m, '').replace(/```$/m, '').trim()) as { line?: string; concept?: string; insight?: string };
    line = (j.line ?? '').trim();
    concept = (j.concept ?? '').trim().toUpperCase().replace(/[^A-Z0-9 -]/g, '').replace(/\s+/g, ' ') || null;
    const cw = concept ? concept.split(' ').length : 0;
    if (concept && (concept.length < 4 || concept.length > 24 || cw > 3)) concept = null;
    insight = (j.insight ?? '').trim().replace(/^["']|["']$/g, '') || null;
    const iw = insight ? insight.split(/\s+/).length : 0;
    if (insight && (iw < 8 || iw > 22)) insight = null;
  } catch { line = raw; }
  line = line.replace(/^["']|["'.]+$/g, '').trim();
  // Validation per template spec: 5-13 words, single verb start (reject
  // double-verb glitches like "makes uses a dramatic ..."), and no
  // wholesale niche-name restating (>=60% of label words reused).
  const wc = line.split(/\s+/).length;
  const doubleVerb = /^(makes|posts|creates|records|compiles|narrates|uploads)\s+(makes|posts|creates|records|compiles|narrates|uses|making)\b/i.test(line);
  const labelWords = (nicheLabel ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const lineLower = line.toLowerCase();
  const overlap = labelWords.length > 0
    ? labelWords.filter(w => lineLower.includes(w.replace(/s$/, ''))).length / labelWords.length
    : 0;
  if (!line || wc < 5 || wc > 13 || doubleVerb || overlap >= 0.8) return null;
  line = line.charAt(0).toLowerCase() + line.slice(1);
  await pool.query(
    `UPDATE content_gen_channel_analysis
        SET recipe_formula_simple = $2,
            concept_word = COALESCE($3, concept_word),
            concept_insight = COALESCE($4, concept_insight)
      WHERE channel_id = $1`,
    [channelId, line, concept, insight]).catch(() => {});
  return { line, concept, insight };
}

export async function loadNicheVars(channelId: string): Promise<NicheVars> {
  const pool = await getPool();

  const [analysis, showcase, rpm, stats] = await Promise.all([
    pool.query<{ recipe_formula: string | null; recipe_formula_simple: string | null; niche_label: string | null; concept_word: string | null; concept_insight: string | null }>(
      `SELECT recipe_formula, recipe_formula_simple, niche_label, concept_word, concept_insight FROM content_gen_channel_analysis WHERE channel_id = $1`, [channelId]),
    pool.query<{ recipe_summary: string | null; beats_jsonb: ShowcaseBeat[] }>(
      `SELECT recipe_summary, beats_jsonb FROM content_gen_recipe_showcase WHERE channel_id = $1`, [channelId]),
    pool.query<{ rpm_typical: number | null; rpm_low: number | null; rpm_high: number | null; geo_guess: string | null }>(
      `SELECT rpm_typical, rpm_low, rpm_high, geo_guess FROM content_gen_channel_rpm WHERE channel_id = $1`, [channelId]),
    pool.query<{ channel_created_at: string | null; video_count: number | null; median_views: number | null }>(
      `SELECT c.channel_created_at, c.video_count,
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v.view_count)
                 FROM niche_spy_videos v WHERE v.channel_id = c.channel_id AND v.view_count IS NOT NULL) AS median_views
         FROM niche_spy_channels c WHERE c.channel_id = $1`, [channelId]),
  ]);

  const createdAt = stats.rows[0]?.channel_created_at ?? null;
  const videoCount = stats.rows[0]?.video_count ?? null;
  const months = createdAt
    ? Math.max(1, (Date.now() - new Date(createdAt).getTime()) / (30.44 * 24 * 3600 * 1000))
    : null;

  // Recipe line resolution: cached Gemini line → fresh Gemini generation
  // (persisted) → rule-based transform of the raw formula as last resort.
  const ana = analysis.rows[0];
  let recipeLine = ana?.recipe_formula_simple ?? null;
  let conceptWord = ana?.concept_word ?? null;
  let conceptInsight = ana?.concept_insight ?? null;
  // Regenerate when the insight is missing (rows cached before the
  // concept-deepening of 2026-06-11 carry only line+word).
  if (!conceptInsight) recipeLine = null;
  if (!recipeLine && (ana?.recipe_formula || showcase.rows[0]?.recipe_summary)) {
    // Up to 3 attempts — validation (word count / double-verb / niche-name
    // parroting) rejects bad generations; retries absorb 429s.
    for (let attempt = 0; attempt < 3 && !recipeLine; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 900 * attempt));
      const gen = await generateRecipeLine(
        channelId, ana?.niche_label ?? null, ana?.recipe_formula ?? null,
        showcase.rows[0]?.recipe_summary ?? null,
      ).catch(() => null);
      if (gen) {
        recipeLine = gen.line;
        conceptWord = gen.concept ?? conceptWord;
        conceptInsight = gen.insight ?? conceptInsight;
      }
    }
  }
  if (!recipeLine) recipeLine = simplifyRecipeFormula(ana?.recipe_formula);

  return {
    channelId,
    recipe_formula_simplified: recipeLine,
    recipe_summary: showcase.rows[0]?.recipe_summary ?? null,
    recipe_beats: Array.isArray(showcase.rows[0]?.beats_jsonb) ? showcase.rows[0].beats_jsonb : [],
    rpm_typical: rpm.rows[0]?.rpm_typical ?? null,
    rpm_low: rpm.rows[0]?.rpm_low ?? null,
    rpm_high: rpm.rows[0]?.rpm_high ?? null,
    geo_guess: rpm.rows[0]?.geo_guess ?? null,
    age_phrase: agePhrase(createdAt),
    median_views_phrase: medianViewsPhrase(stats.rows[0]?.median_views ?? null),
    uploads_per_month: months && videoCount ? Math.round(videoCount / months) : null,
    concept_word: conceptWord,
    concept_insight: conceptInsight,
  };
}
