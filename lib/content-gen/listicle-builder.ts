/**
 * listicle-builder — assembles the full MG-style listicle ConcreteScript
 * from a channel group. Extracted from the producer/start route handler so
 * BOTH the HTTP route and the local CLI runner (scripts/local/render.mts)
 * share one implementation.
 *
 * Per channel (niche): intro logos-montage + niche name card → writer proof
 * beats (about_panel crops + animated highlight) → channel reveal
 * (chip → full page) → rapid-fire thumbs → videos pano → most-popular
 * callout → money_math 5-card sequence. After all niches: 4-card CTA.
 *
 * NOTE: swapChannelProof exists but is intentionally NOT used — task #65's
 * animated L→R yellow highlight requires the about_page screenshot path.
 */

import { writeScript, type ScriptWriterInput, type ChannelData, type NarrationBeat } from './script-writer';
import { type ConcreteScript } from './concrete-script';
import { getPool } from '../db';
import { ttsWithTimestamps, DEFAULT_VOICE_ID, type WordTiming } from './voice';
import { loadNicheVars, spokenNumber, type NicheVars } from './niche-vars';
import { BankSession, numberWord } from './phrase-banks';

export type ChannelEvent = {
  channelId: string;
  niche_index: number;
  channel_label?: string;
  writer: { ok: boolean; slot_count: number; beats: string[]; first_slot_id?: string; error?: string };
};

export async function loadChannel(channelId: string): Promise<ChannelData | null> {
  const pool = await getPool();

  // Refresh stats from YT Data API before reading so subscriber_count / video_count /
  // total_views match what YT is serving on the live page (and what the about_modal
  // screenshot will show). 5-min cache prevents re-hits across niches sharing a
  // channel. Failure is silent — we fall back to whatever the DB has.
  try {
    const { refreshChannelStats } = await import('@/lib/content-gen/refresh-channel-stats');
    await refreshChannelStats(pool, channelId);
  } catch (e) {
    console.warn(`[loadChannel] refresh failed for ${channelId}: ${(e as Error).message.slice(0, 200)}`);
  }

  const r = await pool.query<{
    channel_id: string; channel_name: string | null; channel_handle: string | null;
    subscriber_count: number | null;
    video_count: number | null; channel_created_at: string | null; first_upload_at: string | null;
    recent_videos_avg_views: number | null;
    total_views: number | null;
  }>(
    `SELECT channel_id, channel_name, channel_handle, subscriber_count, video_count,
            channel_created_at, first_upload_at, recent_videos_avg_views, total_views
       FROM niche_spy_channels WHERE channel_id = $1`,
    [channelId],
  );
  if (r.rows.length === 0) return null;
  const ch = r.rows[0];

  // Niche analysis lives in TWO separate tables. Producer-side label is
  // populated by lib/content-gen/unified-analyzer.ts — it gives a listicle-
  // grade phrase like "Sumerian history & ancient tablets". Shorts-admin
  // gives a hierarchy (category > niche > sub_niche).
  // Preference order: content_gen niche_label → channel_analysis sub_niche
  // → channel_analysis niche → undefined (caller falls back to a generic).
  const cgAna = await pool.query<{ niche_label: string | null }>(
    `SELECT niche_label FROM content_gen_channel_analysis WHERE channel_id = $1 LIMIT 1`,
    [channelId],
  ).catch(() => ({ rows: [] as Array<{ niche_label: string | null }> }));
  const ana = await pool.query<{ niche: string | null; sub_niche: string | null }>(
    `SELECT niche, sub_niche FROM channel_analysis WHERE channel_id = $1 LIMIT 1`,
    [channelId],
  ).catch(() => ({ rows: [] as Array<{ niche: string | null; sub_niche: string | null }> }));

  const top = await pool.query<{ url: string; title: string; view_count: number }>(
    `SELECT url, title, view_count FROM niche_spy_videos
      WHERE channel_id=$1 AND view_count IS NOT NULL
      ORDER BY view_count DESC LIMIT 1`,
    [channelId],
  );
  const topRow = top.rows[0];
  const topVideoId = topRow?.url?.match(/(?:shorts\/|watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/)?.[1];
  // Prefer the real channel.statistics.viewCount (now stored in total_views
  // by refreshChannelStats); fall back to recent_videos_avg_views * video_count
  // only when YT API refresh hasn't run yet for this channel.
  const totalViewsReal = ch.total_views != null ? Number(ch.total_views) : undefined;
  const totalApprox = ch.recent_videos_avg_views != null && ch.video_count != null
    ? Number(ch.recent_videos_avg_views) * Number(ch.video_count) : undefined;
  return {
    channelId: ch.channel_id,
    channel_name: ch.channel_name ?? ch.channel_id,
    channel_handle: ch.channel_handle ?? undefined,
    subscriber_count: ch.subscriber_count != null ? Number(ch.subscriber_count) : undefined,
    total_views: totalViewsReal ?? totalApprox,
    video_count: ch.video_count ?? undefined,
    joined_date: ch.channel_created_at ?? ch.first_upload_at ?? undefined,
    // niche: producer-side listicle label preferred, sub_niche second, niche third.
    niche: cgAna.rows[0]?.niche_label ?? ana.rows[0]?.sub_niche ?? ana.rows[0]?.niche ?? undefined,
    sub_niche: ana.rows[0]?.sub_niche ?? undefined,
    top_video_id: topVideoId,
    top_video_title: topRow?.title,
    top_video_view_count: topRow?.view_count != null ? Number(topRow.view_count) : undefined,
  };
}

/** Template beat 5 (proof_2): consistency opener + total views + age.
 *  "And the views back it up. Over 40 million total views in just about
 *  13 months." — worked-example BEAT 4 + SR beat 5 (age + total_views). */
function proof2Text(tv: string, extras?: StubExtras): string {
  // Age framing per MG transcript t=717-722: "Keep in mind, the channel
  // started posting only three to four months ago, and these are usually
  // good numbers for such a short span of time." — "started posting X
  // ago" phrasing + an INTERPRETING kicker, and ONLY when the age is
  // actually impressive (young channel). Older channels get plain stats.
  const stats = `Over ${tv} total views.`;
  const months = extras?.ageMonths ?? null;
  if (extras?.agePhrase && months != null && months <= 9 && extras?.ageKicker) {
    return `${stats} Keep in mind, this channel started posting ${extras.agePhrase}, ${extras.ageKicker}`;
  }
  if (extras?.agePhrase && months != null && months <= 18) {
    // agePhrase already carries its own minimizer ("only about ten
    // months ago" / "just over a year ago") — no extra "only" here.
    return `${stats} And this channel started posting ${extras.agePhrase}.`;
  }
  return stats;
}

export interface StubExtras {
  consistencyLine?: string | null;
  agePhrase?: string | null;
  ageMonths?: number | null;
  ageKicker?: string | null;
}

export function stubNarration(beat_id: string, ch: ChannelData, extras?: StubExtras): NarrationBeat[] {
  const sub = ch.subscriber_count != null ? humanizeNumber(ch.subscriber_count) : 'thousands of';
  const tv = ch.total_views != null ? humanizeNumber(ch.total_views) : 'millions of';
  const vv = ch.top_video_view_count != null ? humanizeNumber(ch.top_video_view_count) : 'a million';
  switch (beat_id) {
    case 'channel_proof_1': return [{ beat_id, text: `This channel already has more than ${sub} subscribers.`, hold_s: 1.8, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'channel_proof_2': return [{ beat_id, text: proof2Text(tv, extras), hold_s: 1.5, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'top_video_callout': return [{ beat_id, text: `Their most popular video has more than ${vv} views.`, hold_s: 2.0, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'niche_segment_3':
      // Compound: a full 3-beat per-niche segment. The script-writer
      // expands this into 3 slots: subs reveal → total views reveal →
      // top video callout. Producer composes all 3 into one mp4.
      return [
        { beat_id: 'channel_proof_1',   text: `This channel already has more than ${sub} subscribers.`, hold_s: 1.8, audio_cue: { sfx: ['whoosh', 'ding'] } },
        { beat_id: 'channel_proof_2',   text: proof2Text(tv, extras),  hold_s: 1.5, audio_cue: { sfx: ['whoosh', 'ding'] } },
        { beat_id: 'top_video_callout', text: `Their most popular video has more than ${vv} views.`,     hold_s: 2.0, audio_cue: { sfx: ['whoosh', 'ding'] } },
      ];
    case 'niche_segment_full':
      // Richer preset that exercises text_card + chalkboard_card + screenshots.
      // Visual grammar: niche label → channel subs (screenshot) → views
      // (screenshot) → money-shot text_card → concept_tag chalkboard.
      return [
        { beat_id: 'intro_card',         text: `Number 1.`,                                                hold_s: 0.8, audio_cue: { sfx: ['whoosh'] } },
        { beat_id: 'niche_name_card',    text: `${ch.niche ?? 'Faceless Animation'}.`,                     hold_s: 1.2, audio_cue: { sfx: ['whoosh'] } },
        { beat_id: 'channel_proof_1',    text: `This channel already has ${sub} subscribers.`,            hold_s: 1.8, audio_cue: { sfx: ['whoosh', 'ding'] } },
        { beat_id: 'channel_proof_2',    text: `And ${tv} total views.`,                                  hold_s: 1.5, audio_cue: { sfx: ['whoosh', 'ding'] } },
        { beat_id: 'top_video_callout',  text: `Their top video has ${vv} views.`,                        hold_s: 2.0, audio_cue: { sfx: ['whoosh', 'ding'] } },
        { beat_id: 'concept_tag',        text: `consistency`,                                              hold_s: 1.2, audio_cue: { sfx: ['ding'] } },
      ];
    default: return [];
  }
}
export function humanizeNumber(n: number): string {
  if (n >= 1e9) return `${(n/1e9).toFixed(1)} billion`;
  if (n >= 1e6) return `${(n/1e6).toFixed(1)} million`;
  if (n >= 1e3) return `${Math.round(n/1e3)} thousand`;
  return `${n}`;
}

/** Hand-authored slots — bypass the writer for purely structural cards. */
export type Slot = ConcreteScript['slots'][number];

export function makeFramingSlot(slot_id: string, beat_id: string, narration: string, mainTextCardArgs: Record<string, unknown>, sfxTokens: string[] = ['whoosh'], bg: 'white' | 'dark_gray' = 'white'): Slot {
  return {
    slot_id, beat_id, narration,
    gems: [
      { id: 'narr', tool: 'tts', args: { text: narration, voice: 'money_groot' } },
      { id: 'main', tool: 'image_gen', args: mainTextCardArgs },
      { id: 'sfx',  tool: 'sfx_render', args: { tokens: sfxTokens } },
    ],
    compose: {
      bg,
      hold_s: '{{narr.duration_s}}',
      layers: [
        { from: 'main', channel: 'video', fit: 'contain', ken_burns: 'zoom_in_8pct' },
        { from: 'narr', channel: 'voice' },
        { from: 'sfx',  channel: 'fx' },
      ],
    },
  };
}

/** MG-style niche intro: 2×5 grid of all channel logos, zooming into the
 *  channel being revealed in THIS niche. Replaces the plain "Number N"
 *  text card per user correction (2026-06-10: "MG OG does a composition
 *  of the logos of the channels and zooms into that one which is going
 *  to speak about"). The grid PNG is shared across niches — only the
 *  ffmpeg target_idx differs.
 *
 *  Falls back to a plain text card if allChannelIds is empty or has only
 *  one entry (the montage needs at least 2 channels to be meaningful). */
export function buildNicheIntroSlots(
  niche_index: number,
  niche_label: string,
  allChannelIds: string[],
  channelName?: string,
  thisChannelId?: string,
  introLine?: string | null,
): Slot[] {
  const base = `niche_${niche_index}`;
  // Threshold >= 1 so single-channel test renders also use the montage
  // (with that one logo). Multi-channel uses the full 2×5 grid as before.
  const useMontage = allChannelIds.length >= 1;
  // target_idx: position of THIS channel in the group's logos array. The
  // zoom-in animation focuses on this index in the 2×5 grid. When the
  // channel is not in the group (shouldn't happen but defensive), default
  // to niche_index-1.
  let targetIdx: number;
  if (thisChannelId) {
    const idx = allChannelIds.indexOf(thisChannelId);
    targetIdx = idx >= 0 ? idx : niche_index - 1;
  } else {
    targetIdx = niche_index - 1;
  }
  // Template beat 1: bank.intro_card pick ("Number {N}:" / "." / ",").
  // Falls back to the substantive hook (channel name) when no bank line
  // was provided (vertical-slice path).
  const introNarration = introLine
    ?? (channelName ? `Number ${niche_index}. ${channelName}.` : `Number ${niche_index}.`);
  const introSlot: Slot = useMontage
    ? {
        slot_id: `${base}_intro_card`,
        beat_id: 'intro_card',
        narration: introNarration,
        gems: [
          { id: 'narr', tool: 'tts', args: { text: introNarration, voice: 'money_groot' } },
          { id: 'main', tool: 'logos_montage', args: { channelIds: allChannelIds } },
          { id: 'sfx',  tool: 'sfx_render', args: { tokens: ['whoosh'] } },
        ],
        compose: {
          bg: 'white',
          hold_s: '{{narr.duration_s}}',
          layers: [
            // zoom_in_to_target + target_idx=niche_index-1 (1-indexed in
            // narration, 0-indexed in grid). The montage PNG is identical
            // across niches; only target_idx differs, so producer-tools'
            // cache reuses the same file.
            { from: 'main', channel: 'video', fit: 'contain',
              ken_burns: 'zoom_in_to_target',
              target_idx: Math.max(0, Math.min(allChannelIds.length - 1, targetIdx)) },
            { from: 'narr', channel: 'voice' },
            { from: 'sfx',  channel: 'fx' },
          ],
        },
      }
    : makeFramingSlot(`${base}_intro_card`, 'intro_card', introNarration,
        { composition: 'text_card', text: introNarration, bg_mode: 'white', color_treatment: 'neutral' },
        ['whoosh']);

  return [
    introSlot,
    makeFramingSlot(`${base}_niche_name_card`, 'niche_name_card', `${niche_label}.`,
      { composition: 'text_card', text: `${niche_label}.`, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
  ];
}

/** Round a lump-sum dollar figure to "nice" tier per visual grammar spec
 *  (2 sig figs, ladder of $1K / $5K / $10K / $25K / $50K / $100K …). */
export function roundLumpSum(n: number): number {
  if (n < 100) return Math.max(0, Math.round(n));
  // Round to 2 significant figures
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}

export function formatDollars(n: number): string {
  const rounded = roundLumpSum(n);
  if (rounded >= 1_000_000) return `$${(rounded / 1_000_000).toFixed(1)}M`;
  if (rounded >= 1_000) return `$${rounded.toLocaleString('en-US')}`;
  return `$${rounded}`;
}

/** 5-card money_math sequence per niche. The signature MG money-shot beat:
 *  "Even if we assume" → "$1 RPM" (shrug icon, green) → "that one video alone
 *  has probably made around" → "$X,XXX" (money_shot_green + ding) → "from ads".
 *  Computes lump_sum from channel.top_video_view_count × $1 RPM (silent).
 *  When the channel has no top-video data, returns [] (caller skips money_math
 *  for that niche). */
export interface MoneyMathOpts {
  /** Analyzed RPM (content_gen_channel_rpm.rpm_typical). Narration rounds
   *  to a whole dollar per the spec's $1/$3/$6/$10 vocabulary. */
  rpmTypical?: number | null;
  /** bank.money_opener_optional pick (50% skip) — adds the opener card:
   *  "Let's take that video with 7.9 million views." */
  opener?: string | null;
  /** bank.assumption_modifier pick. */
  assumption?: string | null;
  /** bank.math_connector pick. */
  connector?: string | null;
  /** geo context card (30% when rpm > $5): "because the videos are ...,
   *  most viewers likely are from US and UK." */
  geoLine?: string | null;
}

export function buildMoneyMathSlots(niche_index: number, ch: ChannelData, opts: MoneyMathOpts = {}): Slot[] {
  if (ch.top_video_view_count == null || ch.top_video_view_count < 1000) return [];
  // RPM is per 1000 views — revenue = (views / 1000) × RPM. For $1 RPM on
  // 4M views the answer is $4,000 (NOT $4M — that previous bug compounded
  // 1000×). MG uses higher RPMs in narration but caps at $1 in the visual
  // card per the silent-RPM rule (avoids "views × RPM = $" exposure).
  // Tier the RPM by view count so the number reads as plausible MG-style:
  //   < 1M views      → $1 RPM
  //   1M - 10M views  → $3 RPM
  //   ≥ 10M views     → $6 RPM (long viewer holds → premium CPM)
  const v = ch.top_video_view_count;
  // RPM: prefer the ANALYZED per-channel value (content_gen_channel_rpm,
  // derived from the transcript corpus + Gemini reasoning) rounded to a
  // whole dollar; the view-count tier is only the fallback for channels
  // that were never analyzed.
  const rpm = opts.rpmTypical != null && opts.rpmTypical > 0
    ? Math.min(10, Math.max(1, Math.round(opts.rpmTypical)))
    : (v >= 10_000_000 ? 6 : v >= 1_000_000 ? 3 : 1);
  const lumpSum = (v / 1000) * rpm;
  const formatted = formatDollars(lumpSum);
  // Per skeleton rpm_modifier_rule:
  //   low RPM ($1-$3) → use "just a" / "Even if we assume" minimizer
  //   higher RPM ($6+) → drop the minimizer ("if we assume")
  const rpmNarration = rpm <= 3 ? `just a $${rpm} RPM,` : `a $${rpm} RPM,`;
  const assumptionPhrase = opts.assumption
    ?? (rpm <= 3 ? 'Even if we assume' : 'If we assume');
  const connectorPhrase = opts.connector ?? 'that one video alone has probably made around';
  const base = `niche_${niche_index}`;
  const slots: Slot[] = [];
  // Optional opener (bank, 50%): "Let's take that video with X views."
  if (opts.opener) {
    const openerLine = `${opts.opener} with ${spokenNumber(v)} views.`;
    slots.push(makeFramingSlot(`${base}_mm_opener`, 'money_math', openerLine,
      { composition: 'text_card', text: openerLine, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']));
  }
  slots.push(...[
    makeFramingSlot(`${base}_mm_assumption`, 'money_math', assumptionPhrase,
      { composition: 'text_card', text: assumptionPhrase, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot(`${base}_mm_rpm`, 'money_math', rpmNarration,
      { composition: 'icon_card', text: `$${rpm} RPM`, bg_mode: 'white', color_treatment: 'inline_green', icon: 'shrug_with_question_marks' },
      ['whoosh']),
    makeFramingSlot(`${base}_mm_translates`, 'money_math', connectorPhrase,
      { composition: 'text_card', text: connectorPhrase, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot(`${base}_mm_lump_sum`, 'money_math', `${formatted}.`,
      { composition: 'text_card', text: formatted, bg_mode: 'white', color_treatment: 'money_shot_green' },
      ['ding']),
    makeFramingSlot(`${base}_mm_closer`, 'money_math', `from ads.`,
      { composition: 'text_card', text: `from ads`, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
  ]);
  // Optional geo context (spec: 30% when rpm > $5): inserted right after
  // the RPM card.
  if (opts.geoLine) {
    const idx = slots.findIndex(s => s.slot_id.endsWith('_mm_rpm'));
    const geoSlot = makeFramingSlot(`${base}_mm_geo`, 'money_math', opts.geoLine,
      { composition: 'text_card', text: opts.geoLine, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']);
    slots.splice(idx + 1, 0, geoSlot);
  }
  return slots;
}

/** 4-card CTA at the end of a listicle. The action card MUST contain
 *  "check out [this/next] video" (winner-coded 17×). */
export interface CtaOpts {
  /** bank.cta_value_card pick. */
  valueLine?: string | null;
  /** bank.cta_action_card pick — first variant carries the 17x winner-coded
   *  "check out this video" phrase. */
  actionLine?: string | null;
}

export function buildCtaSlots(niche_count: number, opts: CtaOpts = {}): Slot[] {
  // CTA arc per visual-packaging-class-b.json:
  //   1. Wrap-up text on white       (neutral text_card)
  //   2. Affirmation (checkmark)      (icon_card on white, green ✓)
  //   3. "Discover more…"             (pointing_hand + text on white)
  //   4. Outro: "if you're watching this far, I appreciate it"
  //                                   (cat_thumbs_up icon on dark_gray)
  //   ↑ ascending_electronic_sting SFX on the final card per audio-sfx spec.
  // Closer: numbers are SPELLED OUT in prose ("the ten faceless niches" —
  // never a raw digit; reported bug 2026-06-11), with a singular guard for
  // 1-niche renders.
  const closer = niche_count === 1
    ? `So, this is one of the most promising faceless niches right now.`
    : `So, these are the ${numberWord(niche_count)} faceless niches.`;
  const valueLine = opts.valueLine
    ?? `And each one has huge potential if you're serious about starting a channel.`;
  const actionLine = opts.actionLine ?? `check out this video right here.`;
  return [
    makeFramingSlot('cta_card_1', 'video_cta', closer,
      { composition: 'text_card', text: closer, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot('cta_card_2', 'video_cta', valueLine,
      { composition: 'icon_card', text: `Huge potential.`, bg_mode: 'white', icon: 'checkmark_green_circle', color_treatment: 'money_shot_green' },
      ['whoosh', 'ding']),
    makeFramingSlot('cta_card_3', 'video_cta', `If you want to discover more faceless niches like these,`,
      { composition: 'icon_card', text: `Discover more.`, bg_mode: 'white', icon: 'pointing_hand', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot('cta_card_4', 'video_cta', actionLine,
      { composition: 'icon_card', text: `Check out this video.`, bg_mode: 'dark_gray', icon: 'cat_thumbs_up', color_treatment: 'neutral' },
      ['ascending_electronic_sting'],
      'dark_gray'),
  ];
}

export function nicheLabelFor(ch: ChannelData, fallbackIdx: number): string {
  // ch.niche is already preferring content_gen_channel_analysis.niche_label
  // (set in loadChannel above). Fall through to sub_niche, then a generic.
  return ch.niche || ch.sub_niche || `Faceless niche ${fallbackIdx}`;
}

/** Post-process writer-emitted slots: inject crop_target on the visual layer
 *  for known beat_ids that should show MG-style cropped close-ups rather
 *  than full screenshots. Verified by frame-by-frame inspection of the
 *  source MG video:
 *    channel_proof_1   → about_panel (whole stats column on dark gray)
 *    channel_proof_2   → about_panel (same crop — the channel.total_views
 *                                      row in the same panel is what's
 *                                      yellow-highlighted)
 *    top_video_callout → handled separately by swapMostPopularCallout(): MG
 *                        composes a single-thumbnail card on WHITE bg, NOT
 *                        a screenshot crop. */
/** Compute a human-readable "N months ago" / "N years ago" phrase from a
 *  posted_at ISO date. Used by the most_popular_callout card so the
 *  composed YT-style card shows the same metadata format as YT's own UI. */
export function relativeAge(postedAt: string | undefined | null): string {
  if (!postedAt) return '';
  const then = new Date(postedAt).getTime();
  if (!Number.isFinite(then)) return '';
  // Date.now() is in TZ context — fine for relative spans.
  const diffMs = Date.now() - then;
  if (diffMs <= 0) return 'today';
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days < 7)   return days <= 1 ? '1 day ago'   : `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5)  return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

/** Format a YT-style row text from a number — matches the about-modal
 *  display: 437k / 1.2M (no decimals < 1k, lowercase suffix). */
export function ytSubFormat(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '— subscribers';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M subscribers`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k subscribers`;
  return `${n} subscribers`;
}
export function ytVideoCountFormat(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '— videos';
  return `${n} ${n === 1 ? 'video' : 'videos'}`;
}
export function ytViewsFormat(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '— views';
  // Comma-grouped, matches YT's actual format ("110,311,861 views").
  return `${Math.round(n).toLocaleString('en-US')} views`;
}
export function ytJoinedFormat(iso: string | undefined): string {
  if (!iso) return 'Joined';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'Joined';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `Joined ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Build 3 thumbnail-rapid-fire slots — MG BEAT 7 "TOP-3 VIEWS RAPID
 *  SEQUENCE". Each slot shows ONE video card (cropped from the
 *  videos_tab capture using video_card_N bbox). Narrations are generic
 *  so they don't go stale when niche_spy DB drifts from live YT data —
 *  the rendered card already shows the view count + age in its own
 *  meta line. Insert between channel_proof_2 and top_videos_pano in
 *  the niche flow. */
export async function buildTopViewsRapidFireSlots(niche_index: number, ch: ChannelData): Promise<Slot[]> {
  // 3 rapid-fire slots, each showing video_card_0/1/2 from the latest
  // videos_tab capture. Template beat 7: the view counts are SPOKEN —
  // "They have videos with {v0} views, {v1} views, and {v2} views,"
  // (worked-example :53-57). The cards crop the LATEST-3 videos on the
  // tab, so we speak the latest-3 counts (posted_at order) to match what
  // is on screen — top-by-views numbers over different cards would
  // visibly contradict the meta line. Falls back to the old generic
  // connectives when the DB has no counts.
  // SOURCE OF TRUTH: the captured videos_tab itself. niche_spy_videos only
  // holds SIGHTED videos (a subset of the channel catalog), so DB counts
  // routinely contradict the cards on screen (user report 2026-06-11).
  // captureYtScreen is day-cached — the rapid-fire gems will reuse this
  // exact capture, so spoken counts always match the rendered cards.
  let texts: Array<string | null> = [];
  try {
    const { captureYtScreen } = await import('./yt-capture');
    const readMeta = (cap: { bboxes: unknown }) =>
      (cap.bboxes as Record<string, { views_texts?: Array<string | null> }>).__meta?.views_texts ?? [];
    let cap = await captureYtScreen(ch.channelId, { kind: 'videos_tab', mode: 'static' });
    texts = readMeta(cap);
    if (texts.filter(Boolean).length < 3) {
      // Day-cached capture predates the views-text extractor (v1.1.0) —
      // force ONE fresh capture; subsequent builds hit the refreshed cache.
      cap = await captureYtScreen(ch.channelId, { kind: 'videos_tab', mode: 'static', force: true });
      texts = readMeta(cap);
    }
  } catch (e) {
    console.warn(`[rapid-fire] capture readout failed for ${ch.channelId}: ${(e as Error).message.slice(0, 120)}`);
  }
  const spokenFromCard = (t: string | null): string | null => {
    const m = t?.match(/^([\d.,]+)\s*([KMB])?\s*views?$/i);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    const mult = m[2]?.toUpperCase() === 'B' ? 1e9 : m[2]?.toUpperCase() === 'M' ? 1e6 : m[2]?.toUpperCase() === 'K' ? 1e3 : 1;
    return Number.isFinite(n) ? spokenNumber(n * mult) : null;
  };
  const spoken = [0, 1, 2].map(i => spokenFromCard(texts[i] ?? null));
  const NARRATIONS = spoken.every(s => s != null)
    ? [
        `They have videos with ${spoken[0]} views,`,
        `${spoken[1]} views,`,
        `and ${spoken[2]} views,`,
      ]
    : ['Look at this one.', 'And this one.', 'And another.'];
  const base = `niche_${niche_index}`;
  return NARRATIONS.map((narration, idx) => {
    return {
      slot_id: `${base}_top_views_rapid_${idx}`,
      beat_id: 'top_views_rapid',
      narration,
      gems: [
        { id: 'narr', tool: 'tts', args: { text: narration, voice: 'money_groot' } },
        { id: 'main', tool: 'yt_capture', args: {
          channelId: ch.channelId,
          kind: 'videos_tab',
          mode: 'static',
        }},
        { id: 'sfx', tool: 'sfx_render', args: { tokens: ['whoosh'] } },
      ],
      compose: {
        bg: 'dark_gray',
        hold_s: '{{narr.duration_s}}',
        layers: [
          // crop_target=thumbnail_rapid_fire:N → composeThumbnailRapidFireMG
          // renders the single card on a dark canvas.
          { from: 'main', channel: 'video', fit: 'contain', ken_burns: 'zoom_in_8pct', crop_target: `thumbnail_rapid_fire:${idx}` },
          { from: 'narr', channel: 'voice' },
          { from: 'sfx',  channel: 'fx' },
        ],
      },
    };
  });
}

/** Build a `channel_page_full` slot — second stage of MG's channel
 *  reveal (chip → full page → about modal at t≈1.4 → 3.8 → 6.5).
 *  Shows the entire channel_page screenshot (banner + chip + tabs +
 *  grid) on a tinted outer canvas. */
export function buildChannelPageFullSlot(niche_index: number, ch: ChannelData, emphasisLine?: string | null): Slot {
  // Template beat 4 opener: bank.emphasis_intro ("And the craziest part is,")
  // leading directly into proof_1's subscriber line.
  const narration = emphasisLine ?? `And this is what they're doing.`;
  const base = `niche_${niche_index}`;
  return {
    slot_id: `${base}_channel_page_full`,
    beat_id: 'channel_page_full',
    narration,
    gems: [
      { id: 'narr', tool: 'tts', args: { text: narration, voice: 'money_groot' } },
      { id: 'main', tool: 'yt_capture', args: {
        channelId: ch.channelId,
        kind: 'channel_page',
        mode: 'static',
      }},
      { id: 'sfx',  tool: 'sfx_render', args: { tokens: ['whoosh'] } },
    ],
    compose: {
      bg: 'dark_gray',
      hold_s: '{{narr.duration_s}}',
      layers: [
        // crop_target=channel_page_full → composeChannelPageFullMG renders
        // the whole page (sidebar stripped) inside a rounded dark card on
        // a medium-gray outer canvas.
        { from: 'main', channel: 'video', fit: 'contain', ken_burns: 'zoom_in_8pct', crop_target: 'channel_page_full' },
        { from: 'narr', channel: 'voice' },
        { from: 'sfx',  channel: 'fx' },
      ],
    },
  };
}

/** Insert a `top_videos_pano` slot immediately after channel_proof_2 for a
 *  given niche. Per user correction: this is NOT a data-driven mockup —
 *  it's a real yt_capture(videos_tab) screenshot cropped to the videos_grid
 *  composite bbox (union of the first 8 video cards). YT dark mode is on
 *  globally so the captured bg is dark gray + white text — matching MG.
 *
 *  Skips entirely if the channel has < 4 videos in DB (the grid would
 *  look broken). */
export async function buildTopVideosPanoSlot(niche_index: number, ch: ChannelData, medianPhrase?: string | null, narrationLine?: string | null): Promise<Slot | null> {
  const pool = await getPool();
  const cnt = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM niche_spy_videos
      WHERE channel_id = $1 AND view_count IS NOT NULL AND title IS NOT NULL`,
    [ch.channelId],
  );
  if (parseInt(cnt.rows[0]?.n ?? '0', 10) < 4) return null;

  // Narration is generic — describes the channel's overall popularity.
  // Keeps the writer out of the loop for this slot (no IP risk).
  // MG transcript t=9.8-13: the consistency opener plays over the grid
  // ("And their views are absolutely unbelievable."). Median phrase is
  // the data-driven fallback, generic line last.
  const narration = narrationLine
    ?? (medianPhrase
      ? `And almost every single upload pulls in ${medianPhrase}.`
      : `And look at their hottest videos.`);
  const base = `niche_${niche_index}`;
  return {
    slot_id: `${base}_top_videos_pano`,
    beat_id: 'top_videos_pano',
    narration,
    gems: [
      { id: 'narr', tool: 'tts', args: { text: narration, voice: 'money_groot' } },
      { id: 'main', tool: 'yt_capture', args: {
        channelId: ch.channelId,
        kind: 'videos_tab',
        mode: 'static',
      }},
      { id: 'sfx',  tool: 'sfx_render', args: { tokens: ['whoosh'] } },
    ],
    compose: {
      // Pano composer outputs a 1920×N tall PNG (MG t182-style). The outer
      // canvas is dark gray; bg here is just the letterbox color if the
      // ffmpeg pan ever shows beyond the composed asset (shouldn't happen
      // since the composer fills the full canvas width).
      bg: 'dark_gray',
      hold_s: '{{narr.duration_s}}',
      layers: [
        // crop_target=videos_grid → MG composer renders a tall (>1080) PNG
        // with the full grid in a dark rounded card on dark canvas.
        // ken_burns=scroll_down → ffmpeg pans vertically over the slot
        // duration, matching MG's slow scroll-down behavior.
        { from: 'main', channel: 'video', fit: 'contain', ken_burns: 'scroll_down', crop_target: 'videos_grid' },
        { from: 'narr', channel: 'voice' },
        { from: 'sfx',  channel: 'fx' },
      ],
    },
  };
}

/** Swap channel_proof_1/2 slots: replace yt_capture(about_page) with the
 *  composed channel_about_panel card. MG-style: dark gray card on white
 *  canvas with the "More info" stats column and a thin yellow vertical
 *  highlight bar next to the called-out row.
 *
 *  channel_proof_1 highlights subscribers; channel_proof_2 highlights views. */
export function swapChannelProof(slots: Slot[], ch: ChannelData): Slot[] {
  const subs = ytSubFormat(ch.subscriber_count);
  const videos = ytVideoCountFormat(ch.video_count);
  const views = ytViewsFormat(ch.total_views);
  const joined = ytJoinedFormat(ch.joined_date);
  // niche_spy_channels.channel_handle is the source of truth ("@VESSTICK").
  // Falls back to channel_name (composer prepends @ if missing).
  const handle = ch.channel_handle ?? ch.channel_name ?? 'channel';

  return slots.map(slot => {
    if (slot.beat_id !== 'channel_proof_1' && slot.beat_id !== 'channel_proof_2') return slot;
    const highlight = slot.beat_id === 'channel_proof_1' ? 'subscribers' : 'views';
    return {
      ...slot,
      gems: slot.gems.map(g => {
        if (g.id !== 'main') return g;
        return {
          id: 'main',
          tool: 'image_gen',
          args: {
            composition: 'channel_about_panel',
            text: '',                 // panel is fully data-driven
            bg_mode: 'white',
            handle,
            country: 'United States', // YT doesn't always expose this in API; placeholder for visual consistency
            joined_phrase: joined,
            subscribers_text: subs,
            video_count_text: videos,
            total_views_text: views,
            highlight_row: highlight,
          },
        };
      }),
      compose: {
        ...slot.compose,
        // Card already renders on white.
        bg: 'white',
        // Strip any crop_target — the composed card is the final image,
        // cropping it would chop content.
        layers: slot.compose.layers.map(l => {
          if (l.channel === 'video') {
            const { crop_target: _ct, ...rest } = l;
            return rest;
          }
          return l;
        }),
      },
    };
  });
}

/** Swap the writer's top_video_callout slot to use the composed
 *  most_popular_callout card instead of a screenshot crop. Per the visual
 *  grammar (visual-packaging-class-b.json:83-95) and confirmed by frame
 *  inspection of the source MG video: this beat is a composed YT-style
 *  card on WHITE bg, not a screenshot. */
export async function swapMostPopularCallout(slots: Slot[], ch: ChannelData): Promise<Slot[]> {
  if (!ch.top_video_id) return slots;
  // Look up posted_at to compute the age phrase.
  let posted_at: string | null = null;
  try {
    const pool = await getPool();
    const r = await pool.query<{ posted_at: string | null }>(
      `SELECT posted_at FROM niche_spy_videos
        WHERE url LIKE $1 OR url LIKE $2 LIMIT 1`,
      [`%/watch?v=${ch.top_video_id}%`, `%/shorts/${ch.top_video_id}%`],
    );
    posted_at = r.rows[0]?.posted_at ?? null;
  } catch { /* best-effort */ }
  const age_phrase = relativeAge(posted_at);
  return slots.map(slot => {
    if (slot.beat_id !== 'top_video_callout') return slot;
    return {
      ...slot,
      gems: slot.gems.map(g => {
        if (g.id !== 'main') return g;
        return {
          id: 'main',
          tool: 'image_gen',
          args: {
            composition: 'most_popular_callout',
            text: ch.top_video_title ?? 'Top video',
            video_id: ch.top_video_id,
            views: ch.top_video_view_count ?? 0,
            age_phrase,
            channel_watermark: ch.channel_name,
            bg_mode: 'white',
          },
        };
      }),
      compose: {
        ...slot.compose,
        // MG renders this composition on white, not dark gray.
        bg: 'white',
        // Strip any crop_target — the composed card is already correctly
        // sized; cropping would defeat the layout.
        layers: slot.compose.layers.map(l => {
          if (l.channel === 'video') {
            const { crop_target: _ct, ...rest } = l;
            return rest;
          }
          return l;
        }),
      },
    };
  });
}

export function injectCropTargets(slots: Slot[]): Slot[] {
  const beatToCrop: Record<string, string> = {
    channel_proof_1:   'about_panel',
    channel_proof_2:   'about_panel',
    // Fallback: when most_popular_callout swap can't run (channel lacks
    // niche_spy_videos data), at least crop the videos_tab capture to the
    // first card so we don't show the entire grid + sidebar.
    top_video_callout: 'top_video_card',
  };
  return slots.map(slot => {
    const target = beatToCrop[slot.beat_id];
    if (!target) return slot;
    return {
      ...slot,
      compose: {
        ...slot.compose,
        layers: slot.compose.layers.map(l => {
          if (l.channel === 'video') return { ...l, crop_target: target };
          return l;
        }),
      },
    };
  });
}

/** Force channel_proof_1 to use kind=about_page (matches MG's treatment).
 *  The script-writer prompt allows either channel_page OR about_page for
 *  this beat, and Gemini sometimes picks channel_page which shows the
 *  banner backdrop instead of the clean stats column. Override to
 *  about_page so the about_panel crop lands on the modal stats. */
export function forceProofKind(slots: Slot[]): Slot[] {
  return slots.map(slot => {
    // channel_proof_1 → about_page + highlight subscribers row
    // channel_proof_2 → about_page + highlight views row
    if (slot.beat_id !== 'channel_proof_1' && slot.beat_id !== 'channel_proof_2') return slot;
    const highlightRow: 'subscribers' | 'views' =
      slot.beat_id === 'channel_proof_1' ? 'subscribers' : 'views';
    return {
      ...slot,
      gems: slot.gems.map(g => {
        if (g.id !== 'main') return g;
        if (g.tool !== 'yt_capture') return g;
        // 2026-06-10 user feedback: previous flow baked a static yellow
        // vertical_bar / sharpie_circle into the captured PNG, which
        // then doubled with the new animated highlight. MG OG has only
        // the animated highlight, no baked annotation.
        //
        // We KEEP annotate_element so the walker still scopes the about
        // modal (otherwise the bbox extractor only returns joined_date
        // and misses subscriber_count / total_views). We DROP annotate_kind
        // and annotate_shape (the writer's gem output sets these to
        // composite/sharpie_circle; if we just spread ...g.args they
        // bleed through, so explicit destructure-and-drop is required).
        const element = highlightRow === 'subscribers' ? 'subscriber_count' : 'total_views';
        const {
          annotate_kind: _annKind,
          annotate_shape: _annShape,
          ...restArgs
        } = g.args as Record<string, unknown>;
        void _annKind; void _annShape;
        return {
          ...g,
          args: {
            ...restArgs,
            kind: 'about_page',
            annotate_element: element,
          },
        };
      }),
      compose: {
        ...slot.compose,
        // MG places the cropped dark modal panel on a WHITE outer canvas
        // (the rounded corners of the modal naturally show through the
        // crop). NOT dark_gray — that was wrong.
        bg: 'white',
        // Add the highlight_row directive to the visual layer so video-
        // compose knows which stats row to animate over.
        //
        // Match by channel === 'video' (NOT crop_target === 'about_panel')
        // because crop_target is injected LATER by injectCropTargets;
        // at this point in the pipeline no layer has it yet. The two
        // post-processors use the same matcher so they land on the same
        // layer.
        layers: (slot.compose.layers ?? []).map(l =>
          l.channel === 'video' ? { ...l, highlight_row: highlightRow } : l
        ),
      },
    };
  });
}


// ───────────────────────────────────────────────────────────────────
// Continuous narration (MG-style): ONE ElevenLabs call per slot GROUP
// (a niche's full beat sequence, or the CTA block) via ttsWithTimestamps,
// then each slot's narr gem becomes an audio_slice of the master. Spans
// tile the master at next-slot-first-word boundaries, so the natural
// pauses between sentences are preserved and the full read survives the
// per-slot cut+concat — no more robotic per-phrase joins.
//
// Word reveal: text cards whose card text EQUALS the slot narration and
// has >= REVEAL_MIN_WORDS words switch to composition 'text_card_reveal'
// + ken_burns 'word_reveal' with word_times (slot-relative) from the
// alignment — words pop in exactly as spoken.
// ───────────────────────────────────────────────────────────────────

const REVEAL_MIN_WORDS = 4;
const SLICE_LEAD_PAD_S = 0.06;

function round3(n: number): number { return Math.round(n * 1000) / 1000; }

export async function applyContinuousNarration(slots: Slot[], voiceAlias = 'money_groot'): Promise<void> {
  const eligible = slots.filter(s =>
    typeof s.narration === 'string' && s.narration.trim().length > 0 &&
    s.gems.some(g => g.id === 'narr' && g.tool === 'tts'));
  if (eligible.length === 0) return;

  const texts = eligible.map(s => s.narration.trim());
  const voice_id = voiceAlias === 'money_groot' ? DEFAULT_VOICE_ID : voiceAlias;
  let master;
  try {
    master = await ttsWithTimestamps(texts.join(' '), { voice_id });
  } catch (e) {
    // Best-effort: keep per-slot tts on failure (robotic but functional).
    console.warn(`[continuous-narration] master TTS failed, keeping per-slot tts: ${(e as Error).message.slice(0, 200)}`);
    return;
  }

  // Char span of each slot's narration inside the joined master text.
  const spans: Array<{ start_c: number; end_c: number }> = [];
  let off = 0;
  for (const t of texts) { spans.push({ start_c: off, end_c: off + t.length }); off += t.length + 1; }

  const wordsIn = (span: { start_c: number; end_c: number }): WordTiming[] =>
    master.words.filter(w => w.char_start >= span.start_c && w.char_start < span.end_c);

  for (let i = 0; i < eligible.length; i++) {
    const slot = eligible[i];
    const slotWords = wordsIn(spans[i]);
    if (slotWords.length === 0) continue; // alignment hole — keep per-slot tts

    const start = i === 0 ? 0 : Math.max(0, slotWords[0].start - SLICE_LEAD_PAD_S);
    // Tile: this slot's audio runs until the NEXT slot's first word (minus
    // lead pad) so inter-sentence pauses belong to the earlier slot and
    // nothing is dropped. Last slot runs to the end of the master.
    let end: number;
    if (i + 1 < eligible.length) {
      const nextWords = wordsIn(spans[i + 1]);
      end = nextWords.length
        ? Math.max(start + 0.3, nextWords[0].start - SLICE_LEAD_PAD_S)
        : Math.max(start + 0.3, slotWords[slotWords.length - 1].end + 0.15);
    } else {
      end = Math.max(start + 0.3, master.duration_s);
    }

    slot.gems = slot.gems.map(g => g.id === 'narr'
      ? { id: 'narr', tool: 'audio_slice', args: { src: master.local_path, start_s: round3(start), end_s: round3(end) } }
      : g);

    // Word reveal — only when the visible card text IS the narration so
    // the alignment's words map 1:1 onto the card's words.
    const mainGem = slot.gems.find(g => g.id === 'main');
    const mainArgs = mainGem?.args as Record<string, unknown> | undefined;
    const cardText = typeof mainArgs?.text === 'string' ? (mainArgs.text as string).trim() : '';
    if (mainGem?.tool === 'image_gen' && mainArgs?.composition === 'text_card' &&
        cardText === slot.narration.trim() && slotWords.length >= REVEAL_MIN_WORDS) {
      mainArgs.composition = 'text_card_reveal';
      const layer = slot.compose.layers.find(l => l.channel === 'video');
      if (layer) {
        layer.ken_burns = 'word_reveal';
        layer.word_times = slotWords.map(w => round3(Math.max(0, w.start - start)));
      }
    }
  }
}

/** concept_tag: the niche-essence beat. Visual = the essence phrase as
 *  plain bold text on white — MG's actual treatment ("Absurd Ranking",
 *  decode t=171: "A white background. Black text ... appears"); the
 *  chalkboard idea was scrapped (no chalkboard exists in the OG video;
 *  user veto 2026-06-11). Narration = the Gemini insight sentence. */
export function buildConceptSlot(niche_index: number, conceptWord: string, line: string): Slot {
  const base = `niche_${niche_index}`;
  return makeFramingSlot(`${base}_concept_tag`, 'concept_tag', line,
    { composition: 'text_card', text: conceptWord, bg_mode: 'white', color_treatment: 'neutral' },
    ['ding']);
}

/** transition (skeleton beat 13): 0.5s breather at the niche seam —
 *  silent by default (80%), occasional vocal cue from the bank. */
export function buildTransitionSlot(niche_index: number, vocalLine: string | null): Slot {
  const base = `niche_${niche_index}`;
  if (vocalLine) {
    return makeFramingSlot(`${base}_transition`, 'transition', vocalLine,
      { composition: 'text_card', text: vocalLine, bg_mode: 'dark_gray', color_treatment: 'neutral' },
      ['whoosh'], 'dark_gray');
  }
  return {
    slot_id: `${base}_transition`,
    beat_id: 'transition',
    narration: '',
    gems: [
      { id: 'main', tool: 'image_gen', args: { composition: 'text_card', text: ' ', bg_mode: 'dark_gray' } },
      { id: 'sfx', tool: 'sfx_render', args: { tokens: ['whoosh'] } },
    ],
    compose: {
      bg: 'dark_gray',
      hold_s: 0.5,
      layers: [
        { from: 'main', channel: 'video', fit: 'contain', ken_burns: 'none' },
        { from: 'sfx', channel: 'fx' },
      ],
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// buildListicleScript — the full multi-channel assembly loop.
// ───────────────────────────────────────────────────────────────────

export interface BuildListicleOpts {
  channels: string[];
  beat_id: string;
  /** Show this full group's logos in the intro montage even when only a
   *  subset of `channels` is being rendered (cheap-test mode). */
  intro_logos_channels?: string[];
}

export interface BuildListicleResult {
  script: ConcreteScript | null;
  channelEvents: ChannelEvent[];
  failures: Array<{ channelId: string; reason: string }>;
  error?: string;
}

export async function buildListicleScript(opts: BuildListicleOpts): Promise<BuildListicleResult> {
  const beat_id = opts.beat_id;
  const channels = opts.channels.slice(0, 16);
  const allSlots: ConcreteScript['slots'] = [];
  const failures: Array<{ channelId: string; reason: string }> = [];
  const channelEvents: ChannelEvent[] = [];
  let acceptedCount = 0;

  const pool = await getPool();
  // One video seed drives BOTH the script's video_id and the phrase-bank
  // rotation (deterministic within a render, rotates across renders).
  const videoSeed = `listicle-${Date.now()}`;
  const banks = new BankSession(videoSeed);
  await banks.load().catch(() => { /* history is best-effort */ });

  for (let i = 0; i < channels.length; i++) {
    const cid = channels[i];
    const ch = await loadChannel(cid);
    if (!ch) { failures.push({ channelId: cid, reason: 'not in DB' }); continue; }
    // The analysis layer (recipe formula, analyzed RPM, age/median phrases)
    // — the per-niche template variables. Missing analysis degrades each
    // line to its pre-template fallback, never blocks the render.
    const vars: NicheVars = await loadNicheVars(cid).catch(() => ({
      channelId: cid, recipe_formula_simplified: null, recipe_summary: null,
      recipe_beats: [], rpm_typical: null, rpm_low: null, rpm_high: null,
      geo_guess: null, age_phrase: null, age_months: null, median_views_phrase: null,
      uploads_per_month: null, concept_word: null, concept_insight: null,
    }));
    const niche_index = acceptedCount + 1;

    // Per-niche bank picks (worked-example template beats 1-9).
    const introLine = banks.pick('intro_card', niche_index)?.replace('{N}', String(niche_index)) ?? null;
    const recipeLine = vars.recipe_formula_simplified
      ? `This channel ${vars.recipe_formula_simplified}.` : null;
    const emphasisLine = banks.pick('emphasis_intro', niche_index);
    const consistencyLine = banks.pick('consistency_intro', niche_index);
    const moneyOpener = banks.pick('money_opener_optional', niche_index, { skipProbability: 0.5 });
    const assumptionPick = banks.pick('assumption_modifier', niche_index);
    const connectorPick = banks.pick('math_connector', niche_index);
    const rpmRounded = vars.rpm_typical != null ? Math.round(vars.rpm_typical) : null;
    const geoLine = (rpmRounded != null && rpmRounded > 5 && vars.geo_guess)
      ? `because of the audience, most viewers are likely from ${vars.geo_guess}.`
      : null;

    const ageKicker = (vars.age_months != null && vars.age_months <= 9)
      ? banks.pick('age_kicker', niche_index)
      : null;
    const beats = stubNarration(beat_id, ch, {
      agePhrase: vars.age_phrase,
      ageMonths: vars.age_months,
      ageKicker,
    });
    if (beats.length === 0) { failures.push({ channelId: cid, reason: `no stub narration for ${beat_id}` }); continue; }

    const introLogosIds = (opts.intro_logos_channels && opts.intro_logos_channels.length > 0)
      ? opts.intro_logos_channels
      : channels;
    const framing = buildNicheIntroSlots(niche_index, nicheLabelFor(ch, niche_index), introLogosIds, ch.channel_name ?? undefined, cid, introLine);


    const input: ScriptWriterInput = {
      channel: ch,
      niche_index,
      video_id: `listicle-${beat_id}-${cid.slice(-6)}`,
      beats,
      voice: 'money_groot',
      width: 1920, height: 1080,
    };
    // Stagger writer calls — 11 back-to-back Gemini requests trip the
    // per-minute quota (Mr. Nightmare dropped with 429 on the MG anchor
    // render, 2026-06-11).
    if (acceptedCount > 0) await new Promise(r => setTimeout(r, 3000));
    const result = await writeScript(input);
    if (!result.ok || !result.script) {
      channelEvents.push({
        channelId: cid, niche_index, channel_label: ch.channel_name ?? cid,
        writer: { ok: false, slot_count: 0, beats: beats.map(b => b.beat_id),
                  error: result.errors?.[0]?.message?.slice(0, 200) ?? 'writer failed' },
      });
      failures.push({ channelId: cid, reason: result.errors?.[0]?.message?.slice(0, 200) ?? 'writer failed' });
      continue;
    }
    channelEvents.push({
      channelId: cid, niche_index, channel_label: ch.channel_name ?? cid,
      writer: { ok: true, slot_count: result.script.slots.length, beats: beats.map(b => b.beat_id),
                first_slot_id: result.script.slots[0]?.slot_id },
    });

    const moneyMath = buildMoneyMathSlots(niche_index, ch, {
      rpmTypical: vars.rpm_typical,
      opener: moneyOpener,
      assumption: assumptionPick,
      connector: connectorPick,
      geoLine,
    });

    // recipe_demo (skeleton beat 10): the channel's REAL footage inside the
    // MG mini-player while the narrator explains the recipe. Narration +
    // clip windows come straight from content_gen_recipe_showcase
    // (transcript-grounded, generated by the analysis pipeline).
    const recipeSlots: Slot[] = vars.recipe_beats
      .filter(b => b.source_video_url && Number(b.clip_end) > Number(b.clip_start))
      .slice(0, 3)
      .map((b, bi) => ({
        slot_id: `niche_${niche_index}_recipe_demo_${bi}`,
        beat_id: 'recipe_demo',
        narration: b.narration,
        gems: [
          { id: 'narr', tool: 'tts', args: { text: b.narration, voice: 'money_groot' } },
          // Window EXTENDS past the matched moment (user feedback
          // 2026-06-11: looping the same 4s for a 10s slot reads as a
          // glitch). The clip STARTS on the transcript-matched moment —
          // that VO↔visual relationship is the point — then keeps playing
          // forward naturally; the slot's hold caps it, so the loop never
          // fires. 16s covers any narration span.
          { id: 'main', tool: 'clip_extract', args: {
            video_url: b.source_video_url as string,
            clip_start: Number(b.clip_start),
            clip_end: Number(b.clip_start) + Math.max(16, Number(b.clip_end) - Number(b.clip_start)),
          } },
        ],
        compose: {
          bg: 'dark_gray' as const,
          hold_s: '{{narr.duration_s}}',
          layers: [
            // NO diegetic audio — MG mini-players run on narration only
            // (user-verified against the reference 2026-06-11).
            { from: 'main', channel: 'video' as const, fit: 'contain' as const, ken_burns: 'none' as const, player_frame: true, watermark_text: ch.channel_name ?? undefined },
            { from: 'narr', channel: 'voice' as const },
          ],
        },
      }));
    const proofSwapped = forceProofKind(result.script.slots);
    const callouttSwapped = await swapMostPopularCallout(proofSwapped, ch);
    // DO NOT call swapChannelProof — task #65's animated highlight needs
    // the about_page screenshot crop path.
    const writerSlotsTransformed = injectCropTargets(callouttSwapped);

    // MG transcript t=3.8-6: the recipe line plays over the FULL channel
    // page — there is no separate chip beat at the niche open. The
    // emphasis opener is its own white text card (t=6-7: "And the
    // craziest" card), and the sentence completes over the about-panel
    // stats (proof_1) — continuous narration carries it across.
    const channelPageFullSlot = buildChannelPageFullSlot(niche_index, ch, recipeLine ?? `Take a look at this channel.`);
    const emphasisSlot = emphasisLine
      ? makeFramingSlot(`niche_${niche_index}_emphasis_card`, 'emphasis_card', emphasisLine,
          { composition: 'text_card', text: emphasisLine, bg_mode: 'white', color_treatment: 'neutral' },
          ['whoosh'])
      : null;
    const rapidFireSlots = await buildTopViewsRapidFireSlots(niche_index, ch);
    const panoSlot = await buildTopVideosPanoSlot(niche_index, ch, vars.median_views_phrase, consistencyLine);

    const withInjects: Slot[] = [];
    let revealInserted = false;
    let proof1Seen = false;
    for (const slot of writerSlotsTransformed) {
      if (!revealInserted && slot.beat_id === 'channel_proof_1') {
        withInjects.push(channelPageFullSlot);
        if (emphasisSlot) withInjects.push(emphasisSlot);
        revealInserted = true;
      }
      withInjects.push(slot);
      if (slot.beat_id === 'channel_proof_1') {
        // MG order (t=9.8-16): proof_1 → grid (pano, consistency line) →
        // rapid count cards → proof_2.
        if (panoSlot) withInjects.push(panoSlot);
        withInjects.push(...rapidFireSlots);
        proof1Seen = true;
      }
    }
    if (!revealInserted) {
      withInjects.unshift(...(emphasisSlot ? [channelPageFullSlot, emphasisSlot] : [channelPageFullSlot]));
    }
    if (!proof1Seen) {
      if (panoSlot) withInjects.push(panoSlot);
      withInjects.push(...rapidFireSlots);
    }
    // concept_tag — the niche-ESSENCE beat (user direction 2026-06-11:
    // go deeper into what the niche is about, like MG's "Absurd Ranking"
    // chalkboard). Narration = the Gemini insight sentence (what the
    // niche is really about at its core); chalkboard = the 1-3 word
    // essence phrase. Bank line remains the fallback when only the
    // word exists (pre-insight cache rows).
    const conceptLine = vars.concept_insight
      ?? (vars.concept_word
        ? banks.pick('concept_tag', niche_index)?.replace('{WORD}', vars.concept_word.toLowerCase()) ?? null
        : null);
    const conceptSlot = vars.concept_word && conceptLine
      ? buildConceptSlot(niche_index, vars.concept_word, conceptLine)
      : null;
    // transition — vocal 20% of the time, silent breather otherwise.
    const transitionSlot = buildTransitionSlot(
      niche_index, banks.pick('transition_optional', niche_index, { skipProbability: 0.8 }));

    // Continuous narration for the whole niche group — one natural read,
    // sliced per slot; reveals wired where applicable. Slot order follows
    // the skeleton: intro → name → MOSAIC → reveal/proofs → money →
    // recipe → CONCEPT → TRANSITION.
    const nicheGroup: Slot[] = [
      ...framing,
      ...withInjects,
      ...moneyMath,
      ...recipeSlots,
      ...(conceptSlot ? [conceptSlot] : []),
      transitionSlot,
    ];
    await applyContinuousNarration(nicheGroup);
    allSlots.push(...nicheGroup);
    acceptedCount++;
  }

  if (acceptedCount === 0) {
    return { script: null, channelEvents, failures, error: 'every channel failed to author' };
  }
  const ctaGroup = buildCtaSlots(acceptedCount, {
    valueLine: banks.pick('cta_value_card', 0),
    actionLine: banks.pick('cta_action_card', 0),
  });
  await applyContinuousNarration(ctaGroup);
  allSlots.push(...ctaGroup);

  const script: ConcreteScript = {
    schema_version: '1',
    context: {
      channelId: channels.join(','),
      channel_name: `listicle-${acceptedCount}-niches`,
      video_id: videoSeed,
      niche_index: 0,
    },
    slots: allSlots,
    final: {
      tool: 'video_compose',
      args: {
        slot_order: allSlots.map(s => s.slot_id),
        width: 1920, height: 1080, fps: 30,
        default_bg: 'dark_gray',
        music_token: 'bed',
      },
    },
  };
  await banks.commit().catch(() => {});
  return { script, channelEvents, failures };
}
