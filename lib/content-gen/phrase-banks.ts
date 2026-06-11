/**
 * Phrase banks — the 9 banked pools from the 300+ transcript reverse-
 * engineering job, VERBATIM from docs/content-gen/
 * worked-example-mg-reverse-engineered.md ("banked phrase pools") and
 * script-skeleton-class-b.md (intro_card bank, money card banks).
 *
 * Rotation rules (script-skeleton variation_rules):
 *  - within one video: never the same pick twice across niches
 *  - across videos: avoid the last-50 used phrases per bank
 *    (content_gen_phrase_history)
 *  - picks are SEEDED by (video_id, bank, niche_index) so a re-render of
 *    the same job is deterministic, but every new video rotates.
 *
 * The templates use {N}-style slots — caller fills them.
 */

import { getPool } from '../db';

export type BankId =
  | 'intro_card'
  | 'emphasis_intro'
  | 'consistency_intro'
  | 'money_opener_optional'
  | 'assumption_modifier'
  | 'math_connector'
  | 'second_channel_opener'
  | 'appreciation_phrase'
  | 'transition_optional'
  | 'cta_value_card'
  | 'cta_action_card';

export const BANKS: Record<BankId, string[]> = {
  // skeleton md :81-85 — mined from MG
  intro_card: [
    'Number {N}:',
    'Number {N}.',
    'Number {N},',
  ],
  // worked example :46 — "rotates per niche"
  emphasis_intro: [
    'And the craziest part is,',
    "What's insane is,",
    'The wild thing is,',
    'And here is the crazy part.',
  ],
  // worked example :49
  consistency_intro: [
    'And their views are absolutely unbelievable.',
    'And every upload pulls real numbers.',
    'And the views back it up.',
  ],
  // worked example :63 — 50% probability, else skip
  money_opener_optional: [
    "Let's take that video",
    'Take their top video',
  ],
  // worked example :66
  assumption_modifier: [
    'Even if we assume',
    'If we assume',
    "Let's say we assume",
  ],
  // worked example :72-74
  math_connector: [
    'this would translate to',
    "that's roughly",
    'that one video alone has probably made around',
    'the estimated earnings are',
  ],
  // worked example :93-94
  second_channel_opener: [
    'There is another channel that',
    "And there's another channel",
    'Look at this one.',
  ],
  // worked example :114-115 + skeleton bank
  appreciation_phrase: [
    "And if you're watching this far, I really appreciate it.",
    "By the way, if you're still here, thank you.",
    "Real quick — if you've made it this far, that means a lot.",
  ],
  // worked example :120 — silent default 80%; "And finally..." last niche only
  transition_optional: [
    'Moving on,',
    'Next up,',
  ],
  // worked example CTA :314-316
  cta_value_card: [
    "And each one has huge potential if you're serious about starting a channel.",
    'Any one of these could become a real channel.',
    'Pick one and run with it.',
  ],
  // worked example CTA :324-326. First variant keeps the 17x winner-coded
  // "check out this video" phrase (skeleton: action card MUST contain it).
  cta_action_card: [
    'check out this video right here.',
    'just click on this video right here.',
  ],
};

const HISTORY_WINDOW = 50;

// fnv-1a → mulberry32: cheap deterministic per-(video,bank,niche) RNG.
function seedFrom(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One render's bank picker. load() pulls the cross-video history window;
 * pick() rotates within the video and avoids history; commit() persists
 * what this render used.
 */
export class BankSession {
  private recent = new Map<BankId, Set<string>>();
  private usedThisVideo = new Map<BankId, Set<string>>();
  private picks: Array<{ bank: BankId; phrase: string }> = [];

  constructor(private videoId: string) {}

  async load(): Promise<void> {
    const pool = await getPool();
    const r = await pool.query<{ bank_id: BankId; phrase: string }>(
      `SELECT bank_id, phrase FROM (
         SELECT bank_id, phrase, row_number() OVER (PARTITION BY bank_id ORDER BY used_at DESC) rn
           FROM content_gen_phrase_history
       ) t WHERE rn <= $1`, [HISTORY_WINDOW]);
    for (const row of r.rows) {
      if (!this.recent.has(row.bank_id)) this.recent.set(row.bank_id, new Set());
      this.recent.get(row.bank_id)!.add(row.phrase);
    }
  }

  /**
   * Pick a phrase. Preference order: not used this video AND not in the
   * cross-video window → not used this video → any (tiny banks exhaust).
   * `skipProbability` implements optional banks (money opener 50%,
   * transition vocal 20%) — returns null on skip, seeded (deterministic).
   */
  pick(bank: BankId, nicheIndex: number, opts: { skipProbability?: number } = {}): string | null {
    const rng = mulberry32(seedFrom(`${this.videoId}|${bank}|${nicheIndex}`));
    if (opts.skipProbability && rng() < opts.skipProbability) return null;

    const pool = BANKS[bank];
    const usedVideo = this.usedThisVideo.get(bank) ?? new Set<string>();
    const usedHist = this.recent.get(bank) ?? new Set<string>();

    let candidates = pool.filter(p => !usedVideo.has(p) && !usedHist.has(p));
    if (candidates.length === 0) candidates = pool.filter(p => !usedVideo.has(p));
    if (candidates.length === 0) candidates = pool;

    const phrase = candidates[Math.floor(rng() * candidates.length)];
    if (!this.usedThisVideo.has(bank)) this.usedThisVideo.set(bank, new Set());
    this.usedThisVideo.get(bank)!.add(phrase);
    this.picks.push({ bank, phrase });
    return phrase;
  }

  /** Persist this render's picks for the cross-video rotation window. */
  async commit(): Promise<void> {
    if (this.picks.length === 0) return;
    const pool = await getPool();
    const values: unknown[] = [];
    const tuples = this.picks.map((p, i) => {
      values.push(p.bank, p.phrase, this.videoId);
      return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`;
    });
    await pool.query(
      `INSERT INTO content_gen_phrase_history (bank_id, phrase, video_id) VALUES ${tuples.join(',')}`,
      values).catch(() => { /* history is best-effort */ });
  }
}

/** Spell out listicle counts for narration ("the ten faceless niches" —
 *  never a raw digit in prose; user-reported bug 2026-06-11). */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}
