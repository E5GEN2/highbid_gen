/**
 * Beat plan — a per-channel, pre-render record of which CONDITIONAL beats
 * fire for each channel in a listicle, plus the signals that drove each
 * decision. Lets an operator see "how many channels get which beats" before
 * committing to a full render, and is the home for operator flag overrides.
 *
 * Recorded additively inside buildListicleScript (reads the emitted slots +
 * the gate signals) — it does NOT change what gets emitted.
 */

/** Per-beat operator override: let the gate decide / force on / suppress. */
export type BeatToggle = 'auto' | 'on' | 'off';

/** Operator flags threaded from the CLI / API into the builder. Every field
 *  is optional; omitted = current (auto) behavior, so defaults are a no-op. */
export interface BeatFlags {
  // per-beat enable/suppress
  rapid?: BeatToggle;
  callout?: BeatToggle;
  pano?: BeatToggle;
  ageCard?: BeatToggle;
  videoCountBox?: BeatToggle;
  channelB?: BeatToggle;
  saturation?: BeatToggle;
  moneyMath?: BeatToggle;
  recipe?: BeatToggle;
  emphasis?: BeatToggle;
  // threshold overrides (else the hardcoded defaults)
  calloutOutlierMult?: number;  // default 8  — top ≥ N× median = breakout
  panoMinViews?: number;        // default 50_000 — per-video floor
  ageMaxMonths?: number;        // default 4  — posting-age gate
  videoBoxMaxVideos?: number;   // default 12 — small-catalog gate
  // control
  summaryOnly?: boolean;        // print the plan, skip the render
}

export interface BeatDecision {
  fire: boolean;
  reason: string;
}

export interface ChannelBeatPlan {
  channelId: string;
  niche_index: number;
  channelLabel: string;
  signals: Record<string, number | null>;
  beats: Record<string, BeatDecision>;
}

/** The conditional beats reported in the summary, in display order. */
export const CONDITIONAL_BEATS = [
  'top_views_rapid', 'top_video_callout', 'top_videos_pano', 'channel_age_card',
  'video_count_box', 'money_math', 'recipe_demo', 'channel_b', 'saturation', 'emphasis_card',
] as const;

/** Resolve a per-beat toggle: auto → the gate's own decision. */
export function applyToggle(autoDecision: boolean, toggle: BeatToggle | undefined): boolean {
  if (toggle === 'on') return true;
  if (toggle === 'off') return false;
  return autoDecision;
}

/** Render the plan as a human CLI summary: a tally per beat + per-channel lines. */
export function formatBeatPlan(plans: ChannelBeatPlan[]): string {
  const N = plans.length;
  if (N === 0) return 'Beat plan — no channels.';
  const out: string[] = [`\nBeat plan — ${N} channel${N === 1 ? '' : 's'}:`];
  for (const beat of CONDITIONAL_BEATS) {
    const fired = plans.filter(p => p.beats[beat]?.fire);
    if (fired.length === 0 && beat === 'emphasis_card') continue; // noise
    const niches = fired.map(p => `n${p.niche_index}`).join(',');
    out.push(`  ${beat.padEnd(18)} ${String(fired.length).padStart(2)}/${N}${niches ? '   → ' + niches : ''}`);
  }
  out.push('');
  for (const p of plans) {
    const on = CONDITIONAL_BEATS.filter(b => p.beats[b]?.fire && b !== 'top_views_rapid' && b !== 'money_math');
    out.push(`  n${p.niche_index} ${p.channelLabel}: ${on.length ? on.join(', ') : '(base beats only)'}`);
  }
  return out.join('\n');
}
