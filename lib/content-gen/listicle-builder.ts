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
import { type ConcreteScript, type HighlightRow } from './concrete-script';
import { getPool } from '../db';
import { ttsWithTimestamps, DEFAULT_VOICE_ID, type WordTiming } from './voice';
import { loadNicheVars, spokenNumber, type NicheVars } from './niche-vars';
import { BankSession, numberWord } from './phrase-banks';
import { findSimilarChannels } from './similar-channels';

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

/** Template beat 5 (proof_2): total views only.
 *  Age was previously folded in here; per the frame study (about-
 *  highlight-age-rules.md A3/G3) MG delivers age as a STANDALONE white
 *  card, not over the views panel, and ONLY for ≤4-month channels — so
 *  age now lives in the dedicated `channel_age_card` beat and proof_2
 *  is just the totals. (extras kept for signature compatibility.) */
function proof2Text(tv: string, _extras?: StubExtras): string {
  void _extras;
  return `Over ${tv} total views.`;
}

export interface StubExtras {
  consistencyLine?: string | null;
  agePhrase?: string | null;
  ageMonths?: number | null;
  ageKicker?: string | null;
  /** Small-catalog hook (about-highlight-age-rules.md A2/G1): when the
   *  picker decides video count is the striking "small input", proof_1
   *  speaks "only {N} videos … {subs}" and the about-panel box lands on
   *  the videos row instead of subscribers. */
  videoCount?: number | null;
  videoCountHook?: boolean;
}

/** proof_1 narration. Default = the subscribers line. Small-catalog hook
 *  = MG's "only {N} videos and already gained {subs}" (n8) — the video
 *  count is spoken so the yellow box can land on it (R2). */
function proof1Text(sub: string, extras?: StubExtras): string {
  if (extras?.videoCountHook && extras.videoCount != null) {
    return `This channel has posted just ${extras.videoCount} videos, and already has more than ${sub} subscribers.`;
  }
  return `This channel already has more than ${sub} subscribers.`;
}

export function stubNarration(beat_id: string, ch: ChannelData, extras?: StubExtras): NarrationBeat[] {
  // FLOOR rounding — these all feed "more than {N}" / "Over {N}" claims.
  const sub = ch.subscriber_count != null ? floorHumanizeNumber(ch.subscriber_count) : 'thousands of';
  const tv = ch.total_views != null ? floorHumanizeNumber(ch.total_views) : 'millions of';
  const vv = ch.top_video_view_count != null ? floorHumanizeNumber(ch.top_video_view_count) : 'a million';
  switch (beat_id) {
    case 'channel_proof_1': return [{ beat_id, text: proof1Text(sub, extras), hold_s: 1.8, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'channel_proof_2': return [{ beat_id, text: proof2Text(tv, extras), hold_s: 1.5, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'top_video_callout': return [{ beat_id, text: `Their most popular video has more than ${vv} views.`, hold_s: 2.0, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'niche_segment_3':
      // Compound: a full 3-beat per-niche segment. The script-writer
      // expands this into 3 slots: subs reveal → total views reveal →
      // top video callout. Producer composes all 3 into one mp4.
      return [
        { beat_id: 'channel_proof_1',   text: proof1Text(sub, extras), hold_s: 1.8, audio_cue: { sfx: ['whoosh', 'ding'] } },
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

/** FLOOR variant for "more than {N}" / "Over {N}" claims: the spoken
 *  lower bound must never exceed the number visible on screen. Nearest-
 *  rounding said "more than 15 thousand" over a 14.6K row (6 datapoint
 *  contradictions in the job-171 frame verification). Truncates: 9.183M
 *  -> "9.1 million", 14.6K -> "14 thousand", 2,098,413 -> "2 million". */
export function floorHumanizeNumber(n: number): string {
  const trunc1 = (x: number) => {
    const v = Math.floor(x * 10) / 10;
    return Number.isInteger(v) ? `${v}` : v.toFixed(1);
  };
  if (n >= 1e9) return `${trunc1(n/1e9)} billion`;
  if (n >= 1e6) return `${trunc1(n/1e6)} million`;
  if (n >= 1e3) return `${Math.floor(n/1e3)} thousand`;
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
    // Icon screens are TEXT-FREE per the MG rule (icons always get a
    // dedicated screen; only the RPM-assumption combo may mix).
    makeFramingSlot('cta_card_2', 'video_cta', valueLine,
      { composition: 'icon_card', text: ``, bg_mode: 'white', icon: 'checkmark_green_circle', color_treatment: 'money_shot_green' },
      ['whoosh', 'ding']),
    makeFramingSlot('cta_card_3', 'video_cta', `If you want to discover more faceless niches like these,`,
      { composition: 'icon_card', text: ``, bg_mode: 'white', icon: 'pointing_hand', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot('cta_card_4', 'video_cta', actionLine,
      // cat_thumbs_up on DARK — the OG-decoded card_4 treatment. The
      // round-1 "cat reads as noise" complaint was really the white-lock
      // flipping this card white; with the dark exception restored the
      // original icon is canon (and card_3 keeps the spec pointing hand).
      { composition: 'icon_card', text: ``, bg_mode: 'dark_gray', icon: 'cat_thumbs_up', color_treatment: 'neutral' },
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

/** Parse a YouTube view-count string ("1.2M views", "264K views") → number. */
function parseViewsNum(t: string | null | undefined): number | null {
  const m = (t ?? '').match(/^\s*([\d.,]+)\s*([KMB])?\s*views?/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = (m[2] ?? '').toUpperCase();
  const mult = u === 'B' ? 1e9 : u === 'M' ? 1e6 : u === 'K' ? 1e3 : 1;
  return n * mult;
}

/** View counts of the channel's recent VISIBLE uploads (videos_tab "Latest"),
 *  read from the day-cached capture's __meta.views_texts. Unbiased + free —
 *  the showcase gates (callout outlier, pano floor) use this distribution. */
async function recentViewNums(channelId: string): Promise<number[]> {
  try {
    const { captureYtScreen } = await import('./yt-capture');
    const cap = await captureYtScreen(channelId, { kind: 'videos_tab', mode: 'static' });
    const vt = (cap.bboxes as { __meta?: { views_texts?: Array<string | null> } })?.__meta?.views_texts;
    if (!Array.isArray(vt)) return [];
    return vt.map(parseViewsNum).filter((n): n is number => n != null && n >= 0);
  } catch { return []; }
}

/** Build 3 thumbnail-rapid-fire slots — MG BEAT 7 "TOP-3 VIEWS RAPID
 *  SEQUENCE". Each slot shows ONE video card (cropped from the
 *  videos_tab capture using video_card_N bbox). Narrations are generic
 *  so they don't go stale when niche_spy DB drifts from live YT data —
 *  the rendered card already shows the view count + age in its own
 *  meta line. Insert between channel_proof_2 and top_videos_pano in
 *  the niche flow. */
export async function buildTopViewsRapidFireSlots(
  niche_index: number,
  ch: ChannelData,
  opts: { calloutFires?: boolean; calloutVideoTitle?: string | null } = {},
): Promise<Slot[]> {
  // Template beat 7: names the channel's TOP videos to paint the niche.
  //
  // SOURCE: the videos_tab_POPULAR capture (sorted most-viewed first), so the
  // cards shown ARE the channel's top videos (user 2026-06-14). card[0] = the
  // #1 video. niche_spy_videos only holds SIGHTED videos, so we read off the
  // capture, not the DB. Failure modes we close:
  //   1. CAPTURE DRIFT — the row is day-bucketed and OVERWRITTEN across calls,
  //      so a re-capture by the compose gem read a DIFFERENT snapshot than the
  //      builder spoke from. We capture ONCE here and PIN capture_id on every
  //      gem so the cards render from this exact snapshot.
  //   2. INDEX SHIFT — resolve the exact card index per slot here (shared with
  //      the compositor via resolveVideoCardIndices) and read THAT card's text.
  //   3. DEDUP — when top_video_callout fires it shows the #1 video, so rapid
  //      DROPS that video (by title match, else the top card) and shows the
  //      next-best, so the same video is never named twice.
  let viewsTexts: Array<string | null> = [];
  let titlesTexts: Array<string | null> = [];
  let cardIdx: number[] = [];      // slot → video_card_N index actually shown
  let pinId: number | null = null;
  try {
    const { captureYtScreen } = await import('./yt-capture');
    const { resolveVideoCardIndices } = await import('./video-compose');
    const sharp = (await import('sharp')).default;
    const KIND = 'videos_tab_popular' as const;   // top-viewed order
    const readMeta = (cap: { bboxes: unknown }) =>
      ((cap.bboxes as Record<string, { views_texts?: Array<string | null>; titles_texts?: Array<string | null> }>).__meta) ?? {};
    let cap = await captureYtScreen(ch.channelId, { kind: KIND, mode: 'static' });
    let meta = readMeta(cap);
    if ((meta.views_texts ?? []).filter(Boolean).length < 3 || (meta.titles_texts ?? []).filter(Boolean).length < 1) {
      // Day-cached capture predates the views/titles-text extractor — force
      // ONE fresh capture; subsequent builds hit the refreshed cache.
      cap = await captureYtScreen(ch.channelId, { kind: KIND, mode: 'static', force: true });
      meta = readMeta(cap);
    }
    viewsTexts = meta.views_texts ?? [];
    titlesTexts = meta.titles_texts ?? [];
    pinId = cap.id;
    const imgH = (await sharp(cap.local_path).metadata()).height ?? Infinity;
    // Resolve up to 4 candidate top cards; drop the callout's #1 video so it
    // isn't named twice (dedup), then keep the top 3 remaining.
    let cand = resolveVideoCardIndices(
      cap.bboxes as Record<string, { x: number; y: number; w: number; h: number } | undefined>, imgH, 4);
    if (opts.calloutFires && cand.length > 0) {
      const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const ct = norm(opts.calloutVideoTitle);
      const matchIdx = ct ? cand.find(i => norm(titlesTexts[i]) === ct) : undefined;
      const dropIdx = matchIdx !== undefined ? matchIdx : cand[0];   // title match, else the top card
      cand = cand.filter(i => i !== dropIdx);
    }
    cardIdx = cand.slice(0, 3);
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
  // TITLE-NAMING form (MG BEAT 7; user 2026-06-14): name the titles of the
  // shown cards to paint the channel's niche/format — "They make videos like
  // X, Y, and Z." (OG n3 named titles: "Top 10 numbers to live in, or Top 10
  // letters to use as a chair"). Titles come from the SAME pinned capture's
  // cards (titles_texts[cardIdx]), so every spoken title matches its card.
  const cleanTitle = (t: string | null): string | null => {
    const s = (t ?? '').replace(/\s+/g, ' ').trim();
    return s.length >= 3 ? s : null;
  };
  const titles = cardIdx.map(ci => cleanTitle(titlesTexts[ci] ?? null));
  // Leading run of titled cards — keeps slot↔title alignment exact (slot i
  // shows cardIdx[i] and speaks titles[i]; stop at the first untitled card).
  let kTitled = 0;
  while (kTitled < Math.min(3, titles.length) && titles[kTitled]) kTitled++;
  // View-count fallback, used only when titles weren't captured.
  const spoken = cardIdx.map(ci => spokenFromCard(viewsTexts[ci] ?? null));
  const nCards = spoken.filter(s => s != null).length;

  let NARRATIONS: string[];
  if (kTitled >= 1) {
    NARRATIONS = [];
    for (let i = 0; i < kTitled; i++) {
      const lead = i === 0 ? 'They make videos like ' : '';
      const conj = (i === kTitled - 1 && kTitled > 1) ? 'and ' : '';
      const end  = i === kTitled - 1 ? '.' : ',';
      NARRATIONS.push(`${lead}${conj}${titles[i]}${end}`);
    }
  } else if (nCards >= 1) {
    NARRATIONS = nCards >= 3
      ? [`They have videos with ${spoken[0]} views,`, `${spoken[1]} views,`, `and ${spoken[2]} views,`]
      : nCards === 2
        ? [`They have videos with ${spoken[0]} views,`, `and ${spoken[1]} views,`]
        : [`They have videos with ${spoken[0]} views,`];
  } else {
    NARRATIONS = ['Look at this one.', 'And this one.'];
  }
  const base = `niche_${niche_index}`;
  return NARRATIONS.map((narration, idx) => {
    // Crop the EXACT card whose count we just spoke; fall back to the slot
    // ordinal only when selection produced nothing (generic-copy path).
    const ci = cardIdx[idx] ?? idx;
    const mainArgs: Record<string, unknown> = { channelId: ch.channelId, kind: 'videos_tab_popular', mode: 'static' };
    if (pinId != null) mainArgs.capture_id = pinId;   // PIN: gems reuse the readout's exact snapshot
    return {
      slot_id: `${base}_top_views_rapid_${idx}`,
      beat_id: 'top_views_rapid',
      narration,
      gems: [
        { id: 'narr', tool: 'tts', args: { text: narration, voice: 'money_groot' } },
        { id: 'main', tool: 'yt_capture', args: mainArgs },
        { id: 'sfx', tool: 'sfx_render', args: { tokens: ['whoosh'] } },
      ],
      compose: {
        bg: 'dark_gray',
        hold_s: '{{narr.duration_s}}',
        layers: [
          // crop_target=thumbnail_rapid_fire:N → composeThumbnailRapidFireMG
          // renders the single card on a dark canvas. N = the resolved card
          // index (not the slot ordinal) so the shown card matches the VO.
          { from: 'main', channel: 'video', fit: 'contain', ken_burns: 'zoom_in_8pct', crop_target: `thumbnail_rapid_fire:${ci}` },
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
export function forceProofKind(slots: Slot[], opts: { videoCountHook?: boolean } = {}): Slot[] {
  return slots.map(slot => {
    // channel_proof_1 → about_page + highlight subscribers row.
    //   videoCountHook (small-catalog hook, about-highlight-age rules
    //   R1/R2/G1+G2): proof_1 narration speaks BOTH stats — "posted just N
    //   videos, and already has more than {subs} subscribers" — so MG boxes
    //   BOTH rows in spoken order (videos first, then subscribers). G2
    //   dual-row: emit an array; video-compose sweeps them sequentially.
    // channel_proof_2 → about_page + highlight views row.
    if (slot.beat_id !== 'channel_proof_1' && slot.beat_id !== 'channel_proof_2') return slot;
    const highlightRow: HighlightRow | HighlightRow[] =
      slot.beat_id === 'channel_proof_2' ? 'views'
      : opts.videoCountHook ? ['videos', 'subscribers']
      : 'subscribers';
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
        // annotate_element only scopes the about-modal bbox walker (so it
        // returns the stats rows, not just joined_date); the animated bake
        // scans the composed PNG for rows, so for a dual-row box the FIRST
        // target is a fine scoping anchor.
        const primaryRow = Array.isArray(highlightRow) ? highlightRow[0] : highlightRow;
        const element = primaryRow === 'subscribers' ? 'subscriber_count'
          : primaryRow === 'videos' ? 'video_count'
          : 'total_views';
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

/** Parse a capture-displayed view-count text ("1.3M views") and speak it
 *  rounded DOWN to the leading magnitude — the reference's only spoken
 *  view figure says "more than 1 million" over an on-screen "1.3m views"
 *  card (channel-b spec 1A): the voice must never overshoot the card. */
function roundedDownSpokenViews(t: string | null): string | null {
  const m = t?.match(/^([\d.,]+)\s*([KMB])?\s*views?$/i);
  if (!m) return null;
  const mult = m[2]?.toUpperCase() === 'B' ? 1e9 : m[2]?.toUpperCase() === 'M' ? 1e6 : m[2]?.toUpperCase() === 'K' ? 1e3 : 1;
  const n = parseFloat(m[1].replace(/,/g, '')) * mult;
  if (!Number.isFinite(n) || n < 10_000) return null; // too small to be a payoff
  const mag = n >= 1e6 ? 1e6 : 1e3;
  let units = Math.floor(n / mag);                           // 1.3M → 1 ; 460K → 460
  if (units >= 100) units = Math.floor(units / 100) * 100;   // 460 → 400
  else if (units >= 10) units = Math.floor(units / 10) * 10; // 87 → 80
  return spokenNumber(units * mag);
}

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
// Background semantics (MG decoded study, 2026-06-11, N=122 text cards):
// text cards are 50/50 white/dark overall but 73-75% MATCH their
// neighbors' bg, and a card between two dark cuts stays dark 46:8.
// The grammar: DARK text cards are CONNECTORS inside dark visual runs
// (screenshots / b-roll); WHITE cards are deliberate statement breaks —
// niche names (11:5 white), emphasis-before-a-number, the money chain
// (longest white run, 17 cuts), CTA (6:0 white). Median run: 2-3 cuts
// per bg before flipping.
// ───────────────────────────────────────────────────────────────────

/** Beats whose text/icon cards are ALWAYS white (statement breaks). */
const WHITE_LOCKED_BEATS = new Set([
  'intro_card', 'niche_name_card', 'emphasis_card', 'money_math',
  'video_cta', 'concept_tag', 'channel_age_card',
]);
/** Beats whose cards are ALWAYS dark. */
const DARK_LOCKED_BEATS = new Set(['transition']);
/** Slot-level dark exceptions inside white-locked beats: MG's CTA action
 *  card (cta_card_4, "check out this video" + sting) plays on DARK while
 *  the rest of the CTA run is white. The blanket video_cta white-lock
 *  flipped it white (job-173: card_4 rendered as a duplicate of card_3). */
const DARK_LOCKED_SLOTS = new Set(['cta_card_4']);

/** Apply the MG continuity rule: any UNLOCKED text/icon card inherits
 *  the bg of the slot before it (connectors stay inside their run).
 *  Locked beats are normalized to their semantic bg. Runs as a post-pass
 *  over the assembled niche group so writer-authored cards inherit too. */
export function applyBgPolicy(slots: Slot[]): void {
  let prevBg: 'white' | 'dark_gray' = 'white';
  for (const s of slots) {
    const mainGem = s.gems.find(g => g.id === 'main');
    const args = mainGem?.args as Record<string, unknown> | undefined;
    const isCard = mainGem?.tool === 'image_gen' &&
      ['text_card', 'text_card_reveal', 'icon_card'].includes(String(args?.composition));
    // most_popular_callout is ALWAYS dark (both OG references are dark
    // cards on the dark canvas; the writer emitted white on some niches —
    // job 173, niche_4 critical).
    if (mainGem?.tool === 'image_gen' && String(args?.composition) === 'most_popular_callout' && args) {
      args.bg_mode = 'dark_gray';
      s.compose.bg = 'dark_gray';
    }
    if (isCard) {
      const target: 'white' | 'dark_gray' | null =
        DARK_LOCKED_SLOTS.has(s.slot_id) ? 'dark_gray'
        : WHITE_LOCKED_BEATS.has(s.beat_id) ? 'white'
        : DARK_LOCKED_BEATS.has(s.beat_id) ? 'dark_gray'
        : prevBg; // continuity (the 85% rule)
      if (target && args) {
        args.bg_mode = target;
        s.compose.bg = target;
        for (const l of s.compose.layers) {
          if (l.channel === 'video') { /* bg drives the canvas */ }
        }
      }
    }
    prevBg = (s.compose.bg as 'white' | 'dark_gray') ?? prevBg;
  }
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
    // SCREEN TRUTH for proof numbers: the about CAPTURE's displayed text
    // (rule_texts, v1.2.5) — the YT-API refresh can be one tick fresher
    // than the day-cached screenshot and the spoken floor then exceeds
    // the highlighted row (job 176, niche_5: "265 thousand" over 264K).
    try {
      const { captureYtScreen } = await import('./yt-capture');
      const aboutCap = await captureYtScreen(cid, { kind: 'about_page', mode: 'static' });
      const rt = (aboutCap.bboxes as unknown as Record<string, { rule_texts?: Record<string, string> }>).__meta?.rule_texts ?? {};
      const parseShown = (t: string | undefined): number | null => {
        const m = t?.match(/^([\d.,]+)\s*([KMB])?/i);
        if (!m) return null;
        const mult = m[2]?.toUpperCase() === 'B' ? 1e9 : m[2]?.toUpperCase() === 'M' ? 1e6 : m[2]?.toUpperCase() === 'K' ? 1e3 : 1;
        const n = parseFloat(m[1].replace(/,/g, '')) * mult;
        return Number.isFinite(n) ? n : null;
      };
      const shownSubs = parseShown(rt.subscriber_count);
      const shownViews = parseShown(rt.total_views);
      if (shownSubs != null) ch.subscriber_count = shownSubs;
      if (shownViews != null) ch.total_views = shownViews;
    } catch (e) {
      console.warn(`[about-truth] capture readout failed for ${cid}: ${(e as Error).message.slice(0, 100)}`);
    }
    // SMALLNESS PICKER (about-highlight-age-rules.md A2/G4): MG frames a
    // fast-growing small channel as "[big result] from a [small input]",
    // where the small input is the catalog size (video count) or recency
    // (age). This pass implements the VIDEO-COUNT branch (G1): when the
    // catalog is tiny AND the result is strong, proof_1 speaks "only N
    // videos" and the about-panel box lands on the videos row. The age
    // branch stays in proof_2 narration (proof2Text) for now — G3 later.
    const strong = (ch.subscriber_count ?? 0) >= 10_000 || (ch.total_views ?? 0) >= 100_000;
    const tinyCatalog = ch.video_count != null && ch.video_count > 0 && ch.video_count <= 12;
    const videoCountHook = !!(tinyCatalog && strong);
    if (videoCountHook) {
      console.log(`[smallness] niche ${niche_index}: video-count hook (${ch.video_count} videos, subs=${ch.subscriber_count ?? '?'}, views=${ch.total_views ?? '?'})`);
    }
    const beats = stubNarration(beat_id, ch, {
      agePhrase: vars.age_phrase,
      ageMonths: vars.age_months,
      ageKicker,
      videoCount: ch.video_count ?? null,
      videoCountHook,
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
    const proofSwapped = forceProofKind(result.script.slots, { videoCountHook });
    const callouttSwapped = await swapMostPopularCallout(proofSwapped, ch);
    // Showcase-beat gates (user 2026-06-14; video-performance-beat-rules.md).
    // Distribution from the channel's recent VISIBLE uploads (videos_tab
    // "Latest"), which is unbiased + free (day-cached). The two beats key on
    // DIFFERENT criteria:
    //   • top_video_callout — a genuine BREAKOUT: the top video ≫ the
    //     channel's median upload (one standout worth isolating, e.g. OG n1's
    //     29M-view video over a ~hundreds-of-thousands median).
    //   • top_videos_pano — the whole recent catalog OVER-PERFORMS: ≈ every
    //     video clears a per-video floor (OG n1: "almost every single upload
    //     pulls in hundreds of thousands of views").
    // top_views_rapid is NOT gated — it stays on every channel (title-naming
    // form) to paint the niche.
    const recentViews = await recentViewNums(ch.channelId);
    const sortedViews = [...recentViews].sort((a, b) => a - b);
    const medianViews = sortedViews.length ? sortedViews[Math.floor(sortedViews.length / 2)] : 0;
    const p10Views = sortedViews.length ? sortedViews[Math.floor(sortedViews.length * 0.1)] : 0; // ≈ "almost all" floor
    const topViews = ch.top_video_view_count ?? (sortedViews.length ? sortedViews[sortedViews.length - 1] : 0);
    const CALLOUT_OUTLIER_MULT = 8;  // top ≥ 8× median = a real standout
    const PANO_MIN_VIEWS = 50_000;   // per-video floor ("xxk each") — tunable
    const calloutWorthy = medianViews > 0 && topViews >= CALLOUT_OUTLIER_MULT * medianViews;
    const panoWorthy = sortedViews.length >= 6 && p10Views >= PANO_MIN_VIEWS;
    const calloutGated = calloutWorthy
      ? callouttSwapped
      : callouttSwapped.filter(s => s.beat_id !== 'top_video_callout');
    // Will a callout actually render? (gated AND the writer emitted one AND we
    // have the top-video id). Rapid uses this to dedup the #1 video out.
    const calloutFires = calloutGated.some(s => s.beat_id === 'top_video_callout') && !!ch.top_video_id;
    // DO NOT call swapChannelProof — task #65's animated highlight needs
    // the about_page screenshot crop path.
    const writerSlotsTransformed = injectCropTargets(calloutGated);

    // MG transcript t=3.8-6: the recipe line plays over the FULL channel
    // page — there is no separate chip beat at the niche open. The
    // emphasis opener is its own white text card (t=6-7: "And the
    // craziest" card), and the sentence completes over the about-panel
    // stats (proof_1) — continuous narration carries it across.
    const channelPageFullSlot = buildChannelPageFullSlot(niche_index, ch, recipeLine ?? `Take a look at this channel.`);
    // channel_age_card (about-highlight-age-rules.md A3/G3): for a YOUNG
    // hero (posting start ≤ 4 months, first_upload-based via niche-vars),
    // Age card (about-highlight-age-rules.md A3; frame-decoded 2026-06-14
    // on OG n6 Quizetta). MG's model: the VOICEOVER is the full contextual
    // sentence ("...started posting quiz-style videos only two months ago
    // and has already gained..."), while the CARD shows only the SHORT
    // LOWERCASE FRAGMENT spoken at that instant ("only 2 months ago") in a
    // MODEST font. So narration ≠ card text here:
    //   narration = contextual sentence (VO has subject + verb)
    //   card text = the bare age fragment (what's on screen)
    // Because text ≠ narration, the word-reveal stays OFF (pop-on, static),
    // matching MG (the fragment holds for ~0.8s). Fires only for ≤4-month
    // channels; older channels get no age mention.
    const ageNarration = vars.age_phrase
      ? `And they started posting ${vars.age_phrase}.`
      : null;
    const ageFragment = vars.age_phrase ?? null;  // lowercase, MG-style "only four months ago"
    const ageCardSlot = (vars.age_months != null && vars.age_months <= 4 && ageNarration && ageFragment)
      ? {
          slot_id: `niche_${niche_index}_channel_age_card`,
          beat_id: 'channel_age_card',
          narration: ageNarration,
          gems: [
            { id: 'narr', tool: 'tts', args: { text: ageNarration, voice: 'money_groot' } },
            { id: 'main', tool: 'image_gen', args: { composition: 'text_card', text: ageFragment, bg_mode: 'white', color_treatment: 'neutral' } },
            { id: 'sfx', tool: 'sfx_render', args: { tokens: ['whoosh'] } },
          ],
          compose: {
            bg: 'white' as const,
            hold_s: '{{narr.duration_s}}',
            layers: [
              { from: 'main', channel: 'video' as const, fit: 'contain' as const, ken_burns: 'none' as const },
              { from: 'narr', channel: 'voice' as const },
              { from: 'sfx', channel: 'fx' as const },
            ],
          },
        } as Slot
      : null;
    const emphasisSlot = emphasisLine
      ? makeFramingSlot(`niche_${niche_index}_emphasis_card`, 'emphasis_card', emphasisLine,
          { composition: 'text_card', text: emphasisLine, bg_mode: 'white', color_treatment: 'neutral' },
          ['whoosh'])
      : null;
    const rapidFireSlots = await buildTopViewsRapidFireSlots(niche_index, ch, {
      calloutFires, calloutVideoTitle: ch.top_video_title ?? null,
    });
    // pano = catalog-wide over-performance grid, gated on panoWorthy (≈ every
    // recent video clears the per-video floor; see gates above).
    const panoSlot = panoWorthy
      ? await buildTopVideosPanoSlot(niche_index, ch, vars.median_views_phrase, consistencyLine)
      : null;

    const withInjects: Slot[] = [];
    let revealInserted = false;
    let proof1Seen = false;
    for (const slot of writerSlotsTransformed) {
      if (!revealInserted && slot.beat_id === 'channel_proof_1') {
        withInjects.push(channelPageFullSlot);
        // Age card right after the channel reveal (n6/n11 position).
        if (ageCardSlot) withInjects.push(ageCardSlot);
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
      const lead: Slot[] = [channelPageFullSlot];
      if (ageCardSlot) lead.push(ageCardSlot);
      if (emphasisSlot) lead.push(emphasisSlot);
      withInjects.unshift(...lead);
    }
    if (!proof1Seen) {
      if (panoSlot) withInjects.push(panoSlot);
      withInjects.push(...rapidFireSlots);
    }
    // channel_b_proof + saturation_callout — canonical spec from the
    // 14-instance frame decode (docs/content-gen/channel-b-saturation-spec.md
    // + -gaps.md, 2026-06-12). Channel B comes from embedding similarity
    // over the WHOLE rofe library (hero top video KNN on the pgvector DB);
    // saturation fires when >= 20 channels clear the looser bar.
    //
    // The deepest reference invariant: NUMBERS LIVE ON SCREEN, CLAIMS LIVE
    // IN VOICE (0/8 instances speak subs; the one spoken view figure is
    // rounded DOWN vs the card). Shot grammar: chip -> full page -> proof
    // amplifier, static card-on-canvas hard cuts, no ken burns, no drawn
    // highlights; the payoff number gets a silent dwell instead.
    let channelBSlots: Slot[] = [];
    let saturationSlots: Slot[] = [];
    try {
      const sim = await findSimilarChannels(cid, channels);
      // Relationship verification (channel-b-verify.ts): classify every
      // candidate we might SHOW on the format/subject axes so the
      // narration never overclaims ("the same kind of videos" over a
      // channel that merely shares the subject world — user report
      // 2026-06-12). Verdicts cache forever per (hero, candidate);
      // classification is sequential — mostly cache hits after render 1.
      const { classifyRelationship, relationTail, isUnrelated, isPageWorthy } = await import('./channel-b-verify');
      const heroEv = { channelId: cid, nicheLabel: ch.niche, recipeFormula: vars.recipe_formula_simplified ?? null };
      const candidateIds = [...new Set([
        ...sim.channels.map(c => c.channel_id),
        ...sim.montagePool.slice(0, 6),
      ])];
      const verdicts = new Map<string, Awaited<ReturnType<typeof classifyRelationship>>>();
      for (const cand of candidateIds) {
        verdicts.set(cand, await classifyRelationship(heroEv, cand).catch(() => null));
      }
      // B = highest-similarity candidate that (a) is not BOTH-axes-
      // different and (b) clears the MIN-STATS gate. Presence-only stats
      // let an emptied 86-subscriber channel through while the narration
      // claimed "performing extremely well" (job 171, niches 5/8).
      const bMinStatsOk = (c: Awaited<ReturnType<typeof loadChannel>>) =>
        !!c && (((c.subscriber_count ?? 0) >= 5000)
          || (((c.total_views ?? 0) >= 500_000) && ((c.video_count ?? 0) >= 3)));
      let b: typeof sim.channels[number] | null = null;
      let chB: Awaited<ReturnType<typeof loadChannel>> = null;
      let bVerdict: ReturnType<typeof verdicts.get> | null = null;
      for (const cand of sim.channels) {
        const v = verdicts.get(cand.channel_id) ?? null;
        if (v && isUnrelated(v)) continue;
        const c = await loadChannel(cand.channel_id);
        if (!bMinStatsOk(c)) {
          console.warn(`[channel-b] ${cand.channel_name} fails min-stats gate (subs=${c?.subscriber_count ?? '?'}, views=${c?.total_views ?? '?'}, vids=${c?.video_count ?? '?'}) — skipping`);
          continue;
        }
        b = cand; chB = c; bVerdict = v;
        break;
      }
      if (b && chB) {
        const bVars = await loadNicheVars(b.channel_id).catch(() => null);
        {
          const base = `niche_${niche_index}`;
          // Canvas for the WHOLE channel_b beat — constant within the beat,
          // rotating across niches/videos (reference: niche_1 runs chip+page
          // on WHITE 253,253,253; niche_2 on DARK 60,60,60).
          const bSeed = videoSeed.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, niche_index);
          const bCanvas: 'white' | 'dark_gray' = bSeed % 2 === 0 ? 'white' : 'dark_gray';
          // Bank variants have different grammar tails:
          //   "There is another channel that" -> "makes the same kind of videos"
          //   "And there's another channel"   -> "making the same kind of videos"
          //   "Look at this one."             -> full rewrite
          // The TAIL comes from the relationship verdict (MG matrix:
          // generic similarity + 2-4 word specific difference). null
          // verdict = classification unavailable -> n8 hedge, never the
          // unverified "same kind" claim.
          const opener = banks.pick('second_channel_opener', niche_index) ?? 'There is another channel that';
          const vTail = bVerdict
            ? relationTail(bVerdict)
            : { that: 'that started uploading similar content', ing: 'uploading similar content' };
          const tails = vTail ?? { that: 'makes the same kind of videos', ing: 'making the same kind of videos' };
          // relationTail's that-form starts with "that ..." — drop the
          // duplicate when the opener already ends with "that".
          const thatTail = tails.that.replace(/^that\s+/, '');
          const openerLine = opener === 'Look at this one.'
            ? `Look at this one — another channel ${tails.ing}`
            : opener.endsWith('that')
              ? `${opener} ${thatTail}`
              : `${opener} ${tails.ing}`;
          // Age claim ONLY when the posting start is actually known
          // (first_upload_at). channel_created_at alone routinely
          // contradicts the visible catalog — Size Cipher: account joined
          // 2013, first upload 2025-12 (gap D2).
          const fuQ = await (await getPool()).query<{ first_upload_at: string | null }>(
            `SELECT first_upload_at FROM niche_spy_channels WHERE channel_id = $1`, [b.channel_id],
          ).catch(() => ({ rows: [] as Array<{ first_upload_at: string | null }> }));
          const ageReliable = !!fuQ.rows[0]?.first_upload_at && !!bVars?.age_phrase;
          // Proof amplifier: lone top-video card from a Popular-sorted
          // capture — card_0 IS the most popular, so views_texts[0] is the
          // exact on-screen figure; speak it rounded DOWN (spec 3A: the
          // voice must never overshoot the card).
          let topSpoken: string | null = null;
          let bTopIdx = 0;
          try {
            const { captureYtScreen } = await import('./yt-capture');
            const readMeta = (cap: { bboxes: unknown }) =>
              (cap.bboxes as Record<string, { views_texts?: Array<string | null> }>).__meta?.views_texts ?? [];
            let cap = await captureYtScreen(b.channel_id, { kind: 'videos_tab_popular', mode: 'static' });
            let vt = readMeta(cap);
            if (!vt.some(t => t)) {
              cap = await captureYtScreen(b.channel_id, { kind: 'videos_tab_popular', mode: 'static', force: true });
              vt = readMeta(cap);
            }
            // ARGMAX, not card_0: when the Popular chip isn't found the
            // grid stays Latest-sorted and card_0 is merely the newest
            // video — job 171 showed a 426K card as "most popular" while
            // the page grid displayed 1.3M (niche_1). The max VISIBLE
            // count is the honest claim either way.
            const parseViews = (t: string | null): number | null => {
              const m = t?.match(/^([\d.,]+)\s*([KMB])?\s*views?$/i);
              if (!m) return null;
              const mult = m[2]?.toUpperCase() === 'B' ? 1e9 : m[2]?.toUpperCase() === 'M' ? 1e6 : m[2]?.toUpperCase() === 'K' ? 1e3 : 1;
              const n = parseFloat(m[1].replace(/,/g, '')) * mult;
              return Number.isFinite(n) ? n : null;
            };
            // Only consider cards that are INSIDE the screenshot: bboxes
            // are DOM-measured and rows below the 2500px viewport exist in
            // the DOM but not in the pixels (job 175: argmax landed on
            // card_18 at y=2574 in a 2500px capture — the crop had no card
            // to show and the fallback broke voice<->card consistency).
            const sharpMod = (await import('sharp')).default;
            const capImgH = (await sharpMod(cap.local_path).metadata().catch(() => ({ height: 2500 }))).height ?? 2500;
            const capBoxes = cap.bboxes as Record<string, { y: number; h: number } | undefined>;
            let bestViews: number | null = null;
            vt.forEach((t, i) => {
              const card = capBoxes[`video_card_${i}`];
              if (!card || card.y + card.h > capImgH - 4) return;
              const n = parseViews(t ?? null);
              if (n != null && (bestViews == null || n > bestViews)) { bestViews = n; bTopIdx = i; }
            });
            topSpoken = bestViews != null ? roundedDownSpokenViews(vt[bTopIdx] ?? null) : null;
          } catch (e) {
            console.warn(`[channel-b] popular capture failed for ${b.channel_id}: ${(e as Error).message.slice(0, 120)}`);
          }
          // Sentence plan (category claims only — no subs, no video counts):
          //   chip:  "{opener} the same kind of videos —"
          //   page:  age claim if reliable, else performance claim
          //   card:  "their most popular video has more than {N} views."
          const midLine = ageReliable
            ? `it started posting ${bVars!.age_phrase}${topSpoken ? ',' : '.'}`
            : `and it's already performing extremely well${topSpoken ? ' —' : '.'}`;
          const topLine = topSpoken
            ? `${ageReliable ? 'and ' : ''}their most popular video has more than ${topSpoken} views.`
            : null;

          channelBSlots = [
            // B0 — header chip: identity + the stats line. The digits
            // (subs, video count) live HERE, on screen, never in voice.
            {
              slot_id: `${base}_channel_b_chip`,
              beat_id: 'channel_b_proof',
              narration: `${openerLine} —`,
              gems: [
                { id: 'narr', tool: 'tts', args: { text: `${openerLine} —`, voice: 'money_groot' } },
                { id: 'main', tool: 'yt_capture', args: { channelId: b.channel_id, kind: 'channel_page', mode: 'static' } },
                { id: 'sfx', tool: 'sfx_render', args: { tokens: ['whoosh'] } },
              ],
              compose: {
                bg: bCanvas,
                hold_s: '{{narr.duration_s}}',
                layers: [
                  { from: 'main', channel: 'video', fit: 'contain', crop_target: 'channel_chip' },
                  { from: 'narr', channel: 'voice' },
                  { from: 'sfx', channel: 'fx' },
                ],
              },
            },
            // B1 — full channel page card (the format-replication proof: a
            // wall of same-template thumbnails). Static dead-hold, rounded
            // card on canvas via channel_page_full (masthead/sidebar gone).
            {
              slot_id: `${base}_channel_b_page`,
              beat_id: 'channel_b_proof',
              narration: midLine,
              gems: [
                { id: 'narr', tool: 'tts', args: { text: midLine, voice: 'money_groot' } },
                { id: 'main', tool: 'yt_capture', args: { channelId: b.channel_id, kind: 'channel_page', mode: 'static' } },
              ],
              compose: {
                bg: bCanvas,
                hold_s: '{{narr.duration_s}}',
                layers: [
                  { from: 'main', channel: 'video', fit: 'contain', crop_target: 'channel_page_full' },
                  { from: 'narr', channel: 'voice' },
                ],
              },
            },
            // B2 — lone top-video card payoff + silent dwell on the number
            // (reference: narration ends 0.6-1.05s before the cut).
            ...(topLine ? [{
              slot_id: `${base}_channel_b_top_video`,
              beat_id: 'channel_b_proof',
              narration: topLine,
              gems: [
                { id: 'narr', tool: 'tts', args: { text: topLine, voice: 'money_groot' } },
                { id: 'main', tool: 'yt_capture', args: { channelId: b.channel_id, kind: 'videos_tab_popular', mode: 'static' } },
                { id: 'sfx', tool: 'sfx_render', args: { tokens: ['ding'] } },
              ],
              compose: {
                bg: bCanvas,
                hold_s: '{{narr.duration_s}}',
                dwell_s: 0.8,
                layers: [
                  { from: 'main', channel: 'video' as const, fit: 'contain' as const, crop_target: `top_video_card:${bTopIdx}` },
                  { from: 'narr', channel: 'voice' as const },
                  { from: 'sfx', channel: 'fx' as const },
                ],
              },
            }] : []),
          ];

          // Double-B (MG niche_2 precedent: Blox Analyst same-subject AND
          // Rog Hider "exact style with Clash Royale"): when the primary B
          // is a clean same/same match and ANOTHER strong candidate is a
          // same-format twist, give it ONE compact page slot with the
          // delta named. n2b's shape: one page + line, ~3-4s.
          if (bVerdict && bVerdict.format_match === 'same' && bVerdict.subject_match === 'same') {
            const twist = sim.channels.find(c => {
              if (c.channel_id === b.channel_id || c.similarity < 0.8) return false;
              const v = verdicts.get(c.channel_id);
              return !!v && v.format_match === 'same' && v.subject_match === 'different'
                && v.confidence === 'high' && !!v.subject_term;
            });
            const twistStats = twist ? await loadChannel(twist.channel_id) : null;
            if (twist && bMinStatsOk(twistStats)) {
              const tv = verdicts.get(twist.channel_id)!;
              const twistLine = `And there's another one doing the same style with ${tv!.subject_term}.`;
              channelBSlots.push({
                slot_id: `${base}_channel_b_twist`,
                beat_id: 'channel_b_proof',
                narration: twistLine,
                gems: [
                  { id: 'narr', tool: 'tts', args: { text: twistLine, voice: 'money_groot' } },
                  { id: 'main', tool: 'yt_capture', args: { channelId: twist.channel_id, kind: 'channel_page', mode: 'static' } },
                  { id: 'sfx', tool: 'sfx_render', args: { tokens: ['whoosh'] } },
                ],
                compose: {
                  bg: bCanvas,
                  hold_s: '{{narr.duration_s}}',
                  layers: [
                    { from: 'main', channel: 'video' as const, fit: 'contain' as const, crop_target: 'channel_page_full' },
                    { from: 'narr', channel: 'voice' as const },
                    { from: 'sfx', channel: 'fx' as const },
                  ],
                },
              });
            }
          }
        }
        // saturation_callout — Form A (spec 2B): RAPID sequential lookalike
        // channel pages (the cut rhythm IS the "many channels" claim), then
        // two dark verdict text cards. MG SC1: 3 pages at ~0.6s each, then
        // "and performing well" / "with the same format." (second card is a
        // word-by-word build — ours reveals automatically at >= 4 words).
        if (sim.saturated) {
          // Pages only for verified relatives (at least one axis matches,
          // high confidence). The montage narration stays GENERIC — MG
          // never names channels or differences there, so verdicts only
          // gate screen time; adjacents still count toward the cluster
          // number, they just never get a page.
          const shown = new Set(channelBSlots.flatMap(s =>
            s.gems.filter(g => g.tool === 'yt_capture').map(g => (g.args as { channelId?: string }).channelId ?? '')));
          const preGate = sim.montagePool
            .filter(c => !shown.has(c))
            .filter(c => {
              const v = verdicts.get(c);
              return !!v && isPageWorthy(v);
            })
            .slice(0, 6);
          // Same min-stats gate as B: an emptied 86-sub channel passed the
          // verdict check on its HISTORICAL titles and rendered a "this
          // channel doesn't have any content" page in the montage (job
          // 173, niche_5). loadChannel refreshes stats (5-min cache).
          const others: string[] = [];
          for (const cId of preGate) {
            if (others.length >= 3) break;
            const cStats = await loadChannel(cId).catch(() => null);
            if (bMinStatsOk(cStats)) others.push(cId);
            else console.warn(`[saturation] ${cId} fails min-stats gate — skipping page`);
          }
          if (others.length === 1) {
            // Form B — extra-channel deep-dive (reference niche_4 Valaritas):
            // page hold -> dark consistency card -> header-less GRID WALL
            // (top row clipped mid-thumbnail; the view-count wall IS the
            // consistency proof).
            const satCh = others[0];
            saturationSlots = [
              {
                slot_id: `niche_${niche_index}_saturation_0`,
                beat_id: 'saturation_callout',
                narration: `And there's another channel doing the same thing,`,
                gems: [
                  { id: 'narr', tool: 'tts', args: { text: `And there's another channel doing the same thing,`, voice: 'money_groot' } },
                  { id: 'main', tool: 'yt_capture', args: { channelId: satCh, kind: 'channel_page', mode: 'static' } },
                  { id: 'sfx', tool: 'sfx_render', args: { tokens: ['whoosh'] } },
                ],
                compose: {
                  bg: 'dark_gray' as const,
                  hold_s: '{{narr.duration_s}}',
                  layers: [
                    { from: 'main', channel: 'video' as const, fit: 'contain' as const, crop_target: 'channel_page_full' },
                    { from: 'narr', channel: 'voice' as const },
                    { from: 'sfx', channel: 'fx' as const },
                  ],
                },
              },
              (() => {
                const s = makeFramingSlot(`niche_${niche_index}_saturation_verdict_0`, 'saturation_callout',
                  'and their view consistency is amazing.',
                  { composition: 'text_card', text: 'and their view consistency is amazing.', bg_mode: 'dark_gray', color_treatment: 'neutral' },
                  ['whoosh'], 'dark_gray');
                for (const l of s.compose.layers) if (l.channel === 'video') l.ken_burns = 'none';
                return s;
              })(),
              {
                slot_id: `niche_${niche_index}_saturation_1`,
                beat_id: 'saturation_callout',
                narration: `That consistency shows the real potential here.`,
                gems: [
                  { id: 'narr', tool: 'tts', args: { text: `That consistency shows the real potential here.`, voice: 'money_groot' } },
                  { id: 'main', tool: 'yt_capture', args: { channelId: satCh, kind: 'videos_tab', mode: 'static' } },
                ],
                compose: {
                  bg: 'dark_gray' as const,
                  hold_s: '{{narr.duration_s}}',
                  dwell_s: 0.6,
                  layers: [
                    { from: 'main', channel: 'video' as const, fit: 'contain' as const, crop_target: 'videos_wall' },
                    { from: 'narr', channel: 'voice' as const },
                  ],
                },
              },
            ];
          } else if (others.length >= 2) {
            const pageFrags = others.length === 3
              ? ['And when you look around,', `you'll see many channels`, 'doing this']
              : ['And when you look around,', `you'll see many channels doing this`];
            saturationSlots = others.map((satCh, si) => ({
              slot_id: `niche_${niche_index}_saturation_${si}`,
              beat_id: 'saturation_callout',
              narration: pageFrags[si],
              gems: [
                { id: 'narr', tool: 'tts', args: { text: pageFrags[si], voice: 'money_groot' } },
                { id: 'main', tool: 'yt_capture', args: { channelId: satCh, kind: 'channel_page', mode: 'static' } },
                ...(si === 0 ? [{ id: 'sfx', tool: 'sfx_render', args: { tokens: ['whoosh'] } }] : []),
              ],
              compose: {
                bg: 'dark_gray' as const,
                hold_s: '{{narr.duration_s}}',
                layers: [
                  { from: 'main', channel: 'video' as const, fit: 'contain' as const, crop_target: 'channel_page_full' },
                  { from: 'narr', channel: 'voice' as const },
                  ...(si === 0 ? [{ from: 'sfx', channel: 'fx' as const }] : []),
                ],
              },
            }));
            const verdicts = ['and performing well', 'with the same format.'].map((line, vi) => {
              // Reference SC1: first card pop-on regular; SECOND card is an
              // ITALIC word-by-word build.
              const s = makeFramingSlot(`niche_${niche_index}_saturation_verdict_${vi}`, 'saturation_callout', line,
                { composition: 'text_card', text: line, bg_mode: 'dark_gray', color_treatment: 'neutral', ...(vi === 1 ? { italic: true } : {}) },
                ['whoosh'], 'dark_gray');
              // Static cards (spec: no ken burns on these beats); second
              // card carries no extra whoosh — one cut cue is enough.
              for (const l of s.compose.layers) if (l.channel === 'video') l.ken_burns = 'none';
              if (vi === 1) {
                s.gems = s.gems.filter(g => g.id !== 'sfx');
                s.compose.layers = s.compose.layers.filter(l => l.from !== 'sfx');
              }
              return s;
            });
            saturationSlots.push(...verdicts);
          }
        }
        if (channelBSlots.length || saturationSlots.length) {
          const rel = (id: string) => {
            const v = verdicts.get(id);
            return v ? `${v.format_match[0]}fmt/${v.subject_match[0]}subj/${v.confidence[0]}` : '?';
          };
          console.log(`[similar] niche ${niche_index}: B=${b.channel_name} (${b.similarity}, ${rel(b.channel_id)}), sat=${sim.saturationCount}, slots=${channelBSlots.length}+${saturationSlots.length}, pool=[${sim.montagePool.slice(0, 6).map(c => rel(c)).join(' ')}]`);
        }
      }
    } catch (e) {
      console.warn(`[similar] lookup failed for ${cid}: ${(e as Error).message.slice(0, 120)}`);
    }

    // concept_tag — BENCHED (user request 2026-06-11): commented out of
    // the render sequence for now. The essence/insight data still
    // generates and caches (concept_word + concept_insight in
    // content_gen_channel_analysis); to re-enable, uncomment this block
    // and the nicheGroup line below.
    // const conceptLine = vars.concept_insight
    //   ?? (vars.concept_word
    //     ? banks.pick('concept_tag', niche_index)?.replace('{WORD}', vars.concept_word.toLowerCase()) ?? null
    //     : null);
    // const conceptSlot = vars.concept_word && conceptLine
    //   ? buildConceptSlot(niche_index, vars.concept_word, conceptLine)
    //   : null;
    const conceptSlot: Slot | null = null;
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
      ...channelBSlots,
      ...saturationSlots,
      ...(conceptSlot ? [conceptSlot] : []),
      transitionSlot,
    ];
    applyBgPolicy(nicheGroup);
    await applyContinuousNarration(nicheGroup);
    allSlots.push(...nicheGroup);
    acceptedCount++;
  }

  if (acceptedCount === 0) {
    return { script: null, channelEvents, failures, error: 'every channel failed to author' };
  }
  // CTA cards are white-locked by the policy.
  const ctaGroup = buildCtaSlots(acceptedCount, {
    valueLine: banks.pick('cta_value_card', 0),
    actionLine: banks.pick('cta_action_card', 0),
  });
  applyBgPolicy(ctaGroup);
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
