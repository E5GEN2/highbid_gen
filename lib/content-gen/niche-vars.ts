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
  if (!/^(makes|creates|uploads|records|posts|compiles|narrates|produces|simply|just)/i.test(s)) {
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

export async function loadNicheVars(channelId: string): Promise<NicheVars> {
  const pool = await getPool();

  const [analysis, showcase, rpm, stats] = await Promise.all([
    pool.query<{ recipe_formula: string | null }>(
      `SELECT recipe_formula FROM content_gen_channel_analysis WHERE channel_id = $1`, [channelId]),
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

  return {
    channelId,
    recipe_formula_simplified: simplifyRecipeFormula(analysis.rows[0]?.recipe_formula),
    recipe_summary: showcase.rows[0]?.recipe_summary ?? null,
    recipe_beats: Array.isArray(showcase.rows[0]?.beats_jsonb) ? showcase.rows[0].beats_jsonb : [],
    rpm_typical: rpm.rows[0]?.rpm_typical ?? null,
    rpm_low: rpm.rows[0]?.rpm_low ?? null,
    rpm_high: rpm.rows[0]?.rpm_high ?? null,
    geo_guess: rpm.rows[0]?.geo_guess ?? null,
    age_phrase: agePhrase(createdAt),
    median_views_phrase: medianViewsPhrase(stats.rows[0]?.median_views ?? null),
    uploads_per_month: months && videoCount ? Math.round(videoCount / months) : null,
  };
}
