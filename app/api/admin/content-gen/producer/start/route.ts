/**
 * POST /api/admin/content-gen/producer/start
 *
 * Body: { script: ConcreteScript }  OR  { channelId, beat_id } (auto-runs
 * the script-writer + immediately enqueues producer for the resulting
 * single-beat script — vertical slice convenience for first renders).
 *
 * Returns { job_id }. Job runs ASYNC — poll /producer/status?id=N.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { startJob, runJob } from '@/lib/content-gen/producer';
import { writeScript, type ScriptWriterInput, type ChannelData, type NarrationBeat } from '@/lib/content-gen/script-writer';
import { assertValidScript, type ConcreteScript } from '@/lib/content-gen/concrete-script';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 600;

async function loadChannel(channelId: string): Promise<ChannelData | null> {
  const pool = await getPool();
  const r = await pool.query<{
    channel_id: string; channel_name: string | null; channel_handle: string | null;
    subscriber_count: number | null;
    video_count: number | null; channel_created_at: string | null; first_upload_at: string | null;
    recent_videos_avg_views: number | null;
  }>(
    `SELECT channel_id, channel_name, channel_handle, subscriber_count, video_count,
            channel_created_at, first_upload_at, recent_videos_avg_views
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
  const totalApprox = ch.recent_videos_avg_views != null && ch.video_count != null
    ? Number(ch.recent_videos_avg_views) * Number(ch.video_count) : undefined;
  return {
    channelId: ch.channel_id,
    channel_name: ch.channel_name ?? ch.channel_id,
    channel_handle: ch.channel_handle ?? undefined,
    subscriber_count: ch.subscriber_count != null ? Number(ch.subscriber_count) : undefined,
    total_views: totalApprox,
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

function stubNarration(beat_id: string, ch: ChannelData): NarrationBeat[] {
  const sub = ch.subscriber_count != null ? humanizeNumber(ch.subscriber_count) : 'thousands of';
  const tv = ch.total_views != null ? humanizeNumber(ch.total_views) : 'millions of';
  const vv = ch.top_video_view_count != null ? humanizeNumber(ch.top_video_view_count) : 'a million';
  switch (beat_id) {
    case 'channel_proof_1': return [{ beat_id, text: `This channel already has more than ${sub} subscribers.`, hold_s: 1.8, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'channel_proof_2': return [{ beat_id, text: `The channel has already gained over ${tv} total views.`, hold_s: 1.5, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'top_video_callout': return [{ beat_id, text: `Their most popular video has more than ${vv} views.`, hold_s: 2.0, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'niche_segment_3':
      // Compound: a full 3-beat per-niche segment. The script-writer
      // expands this into 3 slots: subs reveal → total views reveal →
      // top video callout. Producer composes all 3 into one mp4.
      return [
        { beat_id: 'channel_proof_1',   text: `This channel already has more than ${sub} subscribers.`, hold_s: 1.8, audio_cue: { sfx: ['whoosh', 'ding'] } },
        { beat_id: 'channel_proof_2',   text: `The channel has already gained over ${tv} total views.`,  hold_s: 1.5, audio_cue: { sfx: ['whoosh', 'ding'] } },
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
function humanizeNumber(n: number): string {
  if (n >= 1e9) return `${(n/1e9).toFixed(1)} billion`;
  if (n >= 1e6) return `${(n/1e6).toFixed(1)} million`;
  if (n >= 1e3) return `${Math.round(n/1e3)} thousand`;
  return `${n}`;
}

/** Hand-authored slots — bypass the writer for purely structural cards. */
type Slot = ConcreteScript['slots'][number];

function makeFramingSlot(slot_id: string, beat_id: string, narration: string, mainTextCardArgs: Record<string, unknown>, sfxTokens: string[] = ['whoosh'], bg: 'white' | 'dark_gray' = 'white'): Slot {
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

function buildNicheIntroSlots(niche_index: number, niche_label: string): Slot[] {
  const base = `niche_${niche_index}`;
  return [
    makeFramingSlot(`${base}_intro_card`, 'intro_card', `Number ${niche_index}.`,
      { composition: 'text_card', text: `Number ${niche_index}.`, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot(`${base}_niche_name_card`, 'niche_name_card', `${niche_label}.`,
      { composition: 'text_card', text: `${niche_label}.`, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
  ];
}

/** Round a lump-sum dollar figure to "nice" tier per visual grammar spec
 *  (2 sig figs, ladder of $1K / $5K / $10K / $25K / $50K / $100K …). */
function roundLumpSum(n: number): number {
  if (n < 100) return Math.max(0, Math.round(n));
  // Round to 2 significant figures
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}

function formatDollars(n: number): string {
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
function buildMoneyMathSlots(niche_index: number, ch: ChannelData): Slot[] {
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
  const rpm = v >= 10_000_000 ? 6 : v >= 1_000_000 ? 3 : 1;
  const lumpSum = (v / 1000) * rpm;
  const formatted = formatDollars(lumpSum);
  // Per skeleton rpm_modifier_rule:
  //   low RPM ($1-$3) → use "just a" / "Even if we assume" minimizer
  //   higher RPM ($6+) → drop the minimizer ("if we assume")
  const rpmNarration = rpm <= 3 ? `just a $${rpm} RPM,` : `a $${rpm} RPM,`;
  const assumptionPhrase = rpm <= 3 ? 'Even if we assume' : 'If we assume';
  const base = `niche_${niche_index}`;
  return [
    makeFramingSlot(`${base}_mm_assumption`, 'money_math', assumptionPhrase,
      { composition: 'text_card', text: assumptionPhrase, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot(`${base}_mm_rpm`, 'money_math', rpmNarration,
      { composition: 'icon_card', text: `$${rpm} RPM`, bg_mode: 'white', color_treatment: 'inline_green', icon: 'shrug_with_question_marks' },
      ['whoosh']),
    makeFramingSlot(`${base}_mm_translates`, 'money_math', `that one video alone has probably made around`,
      { composition: 'text_card', text: `that one video alone has probably made around`, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot(`${base}_mm_lump_sum`, 'money_math', `${formatted}.`,
      { composition: 'text_card', text: formatted, bg_mode: 'white', color_treatment: 'money_shot_green' },
      ['ding']),
    makeFramingSlot(`${base}_mm_closer`, 'money_math', `from ads.`,
      { composition: 'text_card', text: `from ads`, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
  ];
}

/** 4-card CTA at the end of a listicle. The action card MUST contain
 *  "check out [this/next] video" (winner-coded 17×). */
function buildCtaSlots(niche_count: number): Slot[] {
  // CTA arc per visual-packaging-class-b.json:
  //   1. Wrap-up text on white       (neutral text_card)
  //   2. Affirmation (checkmark)      (icon_card on white, green ✓)
  //   3. "Discover more…"             (pointing_hand + text on white)
  //   4. Outro: "if you're watching this far, I appreciate it"
  //                                   (cat_thumbs_up icon on dark_gray)
  //   ↑ ascending_electronic_sting SFX on the final card per audio-sfx spec.
  return [
    makeFramingSlot('cta_card_1', 'video_cta', `So these are the ${niche_count} faceless niches.`,
      { composition: 'text_card', text: `So these are the ${niche_count} faceless niches.`, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot('cta_card_2', 'video_cta', `And each one has huge potential.`,
      { composition: 'icon_card', text: `Huge potential.`, bg_mode: 'white', icon: 'checkmark_green_circle', color_treatment: 'money_shot_green' },
      ['whoosh', 'ding']),
    makeFramingSlot('cta_card_3', 'video_cta', `If you want to discover more faceless niches like these,`,
      { composition: 'icon_card', text: `Discover more.`, bg_mode: 'white', icon: 'pointing_hand', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot('cta_card_4', 'video_cta', `check out this video right here.`,
      { composition: 'icon_card', text: `Check out this video.`, bg_mode: 'dark_gray', icon: 'cat_thumbs_up', color_treatment: 'neutral' },
      ['ascending_electronic_sting'],
      'dark_gray'),
  ];
}

function nicheLabelFor(ch: ChannelData, fallbackIdx: number): string {
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
function relativeAge(postedAt: string | undefined | null): string {
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
function ytSubFormat(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '— subscribers';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M subscribers`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k subscribers`;
  return `${n} subscribers`;
}
function ytVideoCountFormat(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '— videos';
  return `${n} ${n === 1 ? 'video' : 'videos'}`;
}
function ytViewsFormat(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '— views';
  // Comma-grouped, matches YT's actual format ("110,311,861 views").
  return `${Math.round(n).toLocaleString('en-US')} views`;
}
function ytJoinedFormat(iso: string | undefined): string {
  if (!iso) return 'Joined';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'Joined';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `Joined ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Insert a `top_videos_pano` slot immediately after channel_proof_2 for a
 *  given niche. Per user correction: this is NOT a data-driven mockup —
 *  it's a real yt_capture(videos_tab) screenshot cropped to the videos_grid
 *  composite bbox (union of the first 8 video cards). YT dark mode is on
 *  globally so the captured bg is dark gray + white text — matching MG.
 *
 *  Skips entirely if the channel has < 4 videos in DB (the grid would
 *  look broken). */
async function buildTopVideosPanoSlot(niche_index: number, ch: ChannelData): Promise<Slot | null> {
  const pool = await getPool();
  const cnt = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM niche_spy_videos
      WHERE channel_id = $1 AND view_count IS NOT NULL AND title IS NOT NULL`,
    [ch.channelId],
  );
  if (parseInt(cnt.rows[0]?.n ?? '0', 10) < 4) return null;

  // Narration is generic — describes the channel's overall popularity.
  // Keeps the writer out of the loop for this slot (no IP risk).
  const narration = `And look at their hottest videos.`;
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
      bg: 'white',
      hold_s: '{{narr.duration_s}}',
      layers: [
        // crop_target=videos_grid → video-compose unions video_card_0..7
        // bboxes and crops the screenshot to just the 4×2 grid.
        { from: 'main', channel: 'video', fit: 'contain', ken_burns: 'zoom_in_8pct', crop_target: 'videos_grid' },
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
function swapChannelProof(slots: Slot[], ch: ChannelData): Slot[] {
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
async function swapMostPopularCallout(slots: Slot[], ch: ChannelData): Promise<Slot[]> {
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

function injectCropTargets(slots: Slot[]): Slot[] {
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
function forceProofKind(slots: Slot[]): Slot[] {
  return slots.map(slot => {
    // channel_proof_1 → about_page + subscriber_count vertical_bar
    // channel_proof_2 → about_page + total_views vertical_bar
    if (slot.beat_id !== 'channel_proof_1' && slot.beat_id !== 'channel_proof_2') return slot;
    const element = slot.beat_id === 'channel_proof_1' ? 'subscriber_count' : 'total_views';
    return {
      ...slot,
      gems: slot.gems.map(g => {
        if (g.id !== 'main') return g;
        if (g.tool !== 'yt_capture') return g;
        return {
          ...g,
          args: {
            ...g.args,
            kind: 'about_page',
            annotate_element: element,
            // MG-style thin yellow vertical bar to the LEFT of the row,
            // NOT the sharpie circle (which is messy on small modal text).
            annotate_kind: 'composite',
            annotate_shape: 'vertical_bar',
          },
        };
      }),
    };
  });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    script?: ConcreteScript;
    channelId?: string;
    /** When set, treats this as a multi-niche listicle. Producer runs the
     *  writer once per channel, merges the per-niche scripts into one
     *  ConcreteScript with niche_index 1..N, and renders as a single mp4. */
    channels?: string[];
    beat_id?: string;
    sync?: boolean;
  };

  let script: ConcreteScript | undefined;

  if (body.script) {
    script = body.script;
  } else if (body.channels && body.channels.length > 0 && body.beat_id) {
    // Multi-channel listicle path. Per channel:
    //   1. Hand-authored intro_card "Number N" + niche_name_card (no writer needed).
    //   2. Writer call for the proof beats (channel_proof_1/2 + top_video_callout).
    // After all niches: hand-authored 4-card video_cta.
    // Total slots = N * (2 framing + writer's slots) + 4 CTA.
    const beat_id = body.beat_id;
    const channels = body.channels.slice(0, 16);
    const allSlots: ConcreteScript['slots'] = [];
    const failures: Array<{ channelId: string; reason: string }> = [];
    let acceptedCount = 0;
    for (let i = 0; i < channels.length; i++) {
      const cid = channels[i];
      const ch = await loadChannel(cid);
      if (!ch) { failures.push({ channelId: cid, reason: 'not in DB' }); continue; }
      const beats = stubNarration(beat_id, ch);
      if (beats.length === 0) { failures.push({ channelId: cid, reason: `no stub narration for ${beat_id}` }); continue; }
      const niche_index = acceptedCount + 1;
      // 1. Framing slots (no writer): intro_card "Number N" + niche_name_card.
      const framing = buildNicheIntroSlots(niche_index, nicheLabelFor(ch, niche_index));
      // 2. Writer call for the proof beats.
      const input: ScriptWriterInput = {
        channel: ch,
        niche_index,
        video_id: `listicle-${beat_id}-${cid.slice(-6)}`,
        beats,
        voice: 'money_groot',
        width: 1920, height: 1080,
      };
      const result = await writeScript(input);
      if (!result.ok || !result.script) {
        failures.push({ channelId: cid, reason: result.errors?.[0]?.message?.slice(0, 200) ?? 'writer failed' });
        continue;
      }
      // 3. Money_math sequence — 5 cards calculating $X,XXX from top-video
      //    views. Skips if channel has no top-video data.
      const moneyMath = buildMoneyMathSlots(niche_index, ch);
      // 4. Post-processors on the writer's proof slots, in order:
      //    (a) Force channel_proof_1 to use kind=about_page so the
      //        about_panel crop lands on the modal stats column.
      //    (b) Inject crop_target on the visual layer so video-compose
      //        crops the YT screenshot to the relevant region:
      //          channel_proof_1/2 → about_panel (stats column)
      //          top_video_callout → top_video_card (single thumb card)
      //    (c) If channel has top_video data, swap top_video_callout
      //        from yt_capture to the composed most_popular_callout card
      //        (per MG's videos-tab grid → cropped single thumb on white).
      //
      //  YT now renders these screenshots in DARK MODE (PREF cookie f6=400 +
      //  Playwright colorScheme:dark), so the naturally-captured bg is dark
      //  gray + white text — matching MG without any mockup composer.
      const proofSwapped = forceProofKind(result.script.slots);
      const callouttSwapped = await swapMostPopularCallout(proofSwapped, ch);
      const writerSlotsTransformed = injectCropTargets(callouttSwapped);
      // 5. Insert a top_videos_pano slot (yt_capture(videos_tab) cropped
      //    to videos_grid) right after channel_proof_2. Skipped if the
      //    channel has < 4 videos in DB.
      const panoSlot = await buildTopVideosPanoSlot(niche_index, ch);
      const withPano: Slot[] = [];
      for (const slot of writerSlotsTransformed) {
        withPano.push(slot);
        if (panoSlot && slot.beat_id === 'channel_proof_2') withPano.push(panoSlot);
      }
      const hasPano = withPano.some(s => s.beat_id === 'top_videos_pano');
      if (panoSlot && !hasPano) withPano.push(panoSlot);
      allSlots.push(...framing, ...withPano, ...moneyMath);
      acceptedCount++;
    }
    if (acceptedCount === 0) {
      return NextResponse.json({ error: 'every channel failed to author', failures }, { status: 500 });
    }
    // 3. Append CTA (4 cards) — uses real accepted niche count.
    allSlots.push(...buildCtaSlots(acceptedCount));

    script = {
      schema_version: '1',
      context: {
        channelId: channels.join(','),
        channel_name: `listicle-${acceptedCount}-niches`,
        video_id: `listicle-${Date.now()}`,
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
  } else if (body.channelId && body.beat_id) {
    // Vertical-slice path: auto-author a single-beat script via script-writer.
    const ch = await loadChannel(body.channelId);
    if (!ch) return NextResponse.json({ error: `channel ${body.channelId} not in DB` }, { status: 404 });
    const beats = stubNarration(body.beat_id, ch);
    if (beats.length === 0) return NextResponse.json({ error: `no stub narration for beat_id=${body.beat_id}` }, { status: 400 });
    const input: ScriptWriterInput = {
      channel: ch,
      niche_index: 1,
      video_id: `producer-${body.beat_id}-${ch.channelId.slice(-6)}`,
      beats,
      voice: 'money_groot',
      // Long-form 16:9 (MG videos are ~14-min YT long-form, not Shorts).
      width: 1920,
      height: 1080,
    };
    const result = await writeScript(input);
    if (!result.ok || !result.script) {
      return NextResponse.json({ error: 'script-writer failed', writer_errors: result.errors, raw_response: result.raw_response }, { status: 500 });
    }
    script = result.script;
  } else {
    return NextResponse.json({ error: 'one of: body.script | (channelId + beat_id) | (channels[] + beat_id) required' }, { status: 400 });
  }

  // Validate before we burn a job row.
  try { assertValidScript(script); }
  catch (e) { return NextResponse.json({ error: 'invalid script', detail: (e as Error).message }, { status: 400 }); }

  const job_id = await startJob({ script });

  if (body.sync) {
    const result = await runJob(job_id);
    return NextResponse.json({ ok: result.ok, job_id, ...result });
  }
  // Fire and forget — the GUI polls status.
  void runJob(job_id).catch((e: Error) => console.error(`[producer:${job_id}] runJob threw`, e));
  return NextResponse.json({ ok: true, job_id, mode: 'async', status_url: `/api/admin/content-gen/producer/status?id=${job_id}` });
}
