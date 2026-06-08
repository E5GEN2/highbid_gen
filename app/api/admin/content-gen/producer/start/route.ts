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
    channel_id: string; channel_name: string | null; subscriber_count: number | null;
    video_count: number | null; channel_created_at: string | null; first_upload_at: string | null;
    recent_videos_avg_views: number | null;
  }>(
    `SELECT channel_id, channel_name, subscriber_count, video_count,
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
  const topVideoId = topRow?.url?.match(/(?:shorts\/|watch\?v=)([A-Za-z0-9_-]{6,})/)?.[1];
  const totalApprox = ch.recent_videos_avg_views != null && ch.video_count != null
    ? Number(ch.recent_videos_avg_views) * Number(ch.video_count) : undefined;
  return {
    channelId: ch.channel_id,
    channel_name: ch.channel_name ?? ch.channel_id,
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
  return [
    makeFramingSlot('cta_card_1', 'video_cta', `So these are the ${niche_count} faceless niches.`,
      { composition: 'text_card', text: `So these are the ${niche_count} faceless niches.`, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot('cta_card_2', 'video_cta', `And each one has huge potential.`,
      { composition: 'text_card', text: `And each one has huge potential.`, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot('cta_card_3', 'video_cta', `If you want to discover more faceless niches like these,`,
      { composition: 'text_card', text: `If you want to discover more faceless niches,`, bg_mode: 'white', color_treatment: 'neutral' },
      ['whoosh']),
    makeFramingSlot('cta_card_4', 'video_cta', `check out this video right here.`,
      { composition: 'text_card', text: `check out this video right here.`, bg_mode: 'white', color_treatment: 'money_shot_green' },
      ['ascending_electronic_sting']),
  ];
}

function nicheLabelFor(ch: ChannelData, fallbackIdx: number): string {
  // ch.niche is already preferring content_gen_channel_analysis.niche_label
  // (set in loadChannel above). Fall through to sub_niche, then a generic.
  return ch.niche || ch.sub_niche || `Faceless niche ${fallbackIdx}`;
}

/** Post-process writer-emitted slots: inject crop_target on the visual layer
 *  for known beat_ids that should show MG-style cropped close-ups rather
 *  than full screenshots. Per mg-decoded-visual-timeline.json + spec audit:
 *    channel_proof_1   → crop to subscriber_count bbox (about-modal close-up)
 *    channel_proof_2   → crop to total_views bbox
 *    top_video_callout → crop to top_video_card bbox (single card close-up)
 *  Writer doesn't emit crop_target (it doesn't know about it) — we annotate
 *  here on the way through so the changes don't require a prompt iteration. */
function injectCropTargets(slots: Slot[]): Slot[] {
  const beatToCrop: Record<string, string> = {
    channel_proof_1:   'subscriber_count',
    channel_proof_2:   'total_views',
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
      // 4. Inject crop_target on the writer's proof slots so the visuals
      //    are MG-style cropped close-ups instead of full page screenshots.
      const writerSlotsCropped = injectCropTargets(result.script.slots);
      allSlots.push(...framing, ...writerSlotsCropped, ...moneyMath);
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
