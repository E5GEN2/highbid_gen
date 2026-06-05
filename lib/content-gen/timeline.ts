/**
 * Tri-track aud2vis timeline compiler + group orchestrator (Stage D.2).
 *
 * Turns the narration script + slot data + recipe showcase into the full
 * timeline in the MG-transcript schema, enriched into a render spec:
 *
 *   segment = { t_start, t_end, speech, visual, audio, beat_id, niche_index }
 *
 * The visual/audio/timing tracks are a DETERMINISTIC lookup into the
 * winner-mined slot-rendering-class-b grammar (subs → annotated channel
 * screenshot, views → rapid thumbnails, money → green card + ding…), bound
 * to REAL assets from slot data. The one exception is the recipe section:
 * those beats come from the transcript-grounded recipe showcase, each bound
 * to a real clip moment in the channel's own video (diegetic audio).
 *
 * Same schema in (analysis) and out (generation) → a generated timeline can
 * be diffed against a winner's transcript segment by segment.
 */

import { getPool } from '../db';
import { generateListicleScript, type GeneratedScript, type ScriptBeat, type GenerateOpts } from './script-gen';
import { assembleChannelSlots, type ChannelSlots } from './slot-fill';
import { getOrGenerateRecipeShowcase, type RecipeShowcase } from './recipe-showcase';

export const TIMELINE_VERSION = 1;

// ── output shape ──
// Composition + primitive vocabulary is the full Class-B grammar
// (visual-packaging-class-b.json), empirically validated against the
// decoded Money-Groot timeline (docs/content-gen/mg-decoded-visual-timeline.json):
//   text_card · money_shot_card · title_card
//   yt_channel_page · yt_about_page · yt_search_results · yt_thumbnail_card · thumbnail_grid
//   most_popular_callout_card · mini_player_card · chalkboard_card · icon_card
export interface VisualSpec {
  composition: string;
  bg: 'white' | 'dark_gray' | 'mixed';
  primitive: string | null;            // named primitive (yellow_circle_screenshot_annotation, most_popular_callout_card, chalkboard_concept_tag, ...)
  asset: { kind: string; ref?: string | null; refs?: string[]; video_url?: string | null; clip_start?: number; clip_end?: number; note?: string } | null;
  overlay: string | null;              // on-screen text
  emphasis: string | null;             // phrase to color inline (green/red span)
  annotation: string | null;           // human-readable, e.g. "yellow highlight on '160K subscribers'"
  annotation_target: string | null;    // the specific element annotated
  annotation_style: string | null;     // yellow_circle | yellow_box | yellow_fill_behind | yellow_highlight
  color: string;                        // neutral | money_shot_green | inline_green | inline_red | yellow_highlight | chalk_cream
  icon: string | null;                  // from the 15-icon host-reaction library
  token_role: string | null;            // connector | emphasis | money_shot
  diegetic?: boolean;                   // play source video's native audio (recipe clips)
  big?: boolean;                        // oversized money-shot text
}
export interface AudioSpec { music: string; sfx: string[]; }
export interface TimelineSegment {
  t_start: number;
  t_end: number;
  speech: string;                 // '' for silent visual beats
  visual: VisualSpec;
  audio: AudioSpec;
  beat_id: string;
  niche_index: number | null;     // null for intro/cta
}
export interface Timeline {
  title: string;
  segments: TimelineSegment[];
  duration_s: number;
  meta: {
    version: number;
    niche_count: number;
    segment_count: number;
    word_count: number;
    recipe_clips: number;         // how many beats are real-clip showcase beats
    channels_with_showcase: number;
  };
}

const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:[KMB]|million|thousand)?/i;

function words(s: string): number { return s.trim() ? s.trim().split(/\s+/).length : 0; }
function holdFor(s: string, min = 0.6): number { return Math.max(min, Math.round((words(s) / 2.8) * 10) / 10); }

const ENUMERATED = new Set(['money_math', 'top_views_seq', 'recipe_demo']);
/** strip n{idx}_ prefix; strip trailing _N only for enumerated card-runs. */
function baseBeat(beatId: string): string {
  const b = beatId.replace(/^n\d+_/, '');
  const stripped = b.replace(/_\d+$/, '');
  return ENUMERATED.has(stripped) ? stripped : b;
}

function channelHandleUrl(slot: ChannelSlots): string {
  const h = slot.channel_handle;
  return h ? `youtube.com/${h.startsWith('@') ? h : '@' + h}` : `youtube.com/channel/${slot.channel_id}`;
}

/** The salient number/$ phrase to emphasize inline (green) within a text card. */
function salientPhrase(text: string): string | null {
  const m = text.match(/\$\s?\d[\d,]*(?:\.\d+)?\s*(?:[KMB]|million|thousand)?|\b\d[\d,]*(?:\.\d+)?\s*(?:million|thousand|K|M|subscribers|views|videos|months|years|days)\b/i);
  return m ? m[0].trim() : null;
}

/**
 * Map one narration fragment → {visual, audio} using the FULL Class-B visual
 * grammar (visual-packaging-class-b.json), calibrated to the decoded MG
 * frequencies: YT-native screens for proof, the host-reaction icon library,
 * inline green/red emphasis, specific yellow annotations, money-shot card.
 * bg semantics: white = narration, dark_gray = YouTube-world / proof.
 */
function renderVisual(base: string, text: string, slot: ChannelSlots, localIdx: number): { visual: VisualSpec; audio: AudioSpec } {
  const tv = slot.top_video;
  const handle = channelHandleUrl(slot);
  const V = (v: Partial<VisualSpec>): VisualSpec => ({
    composition: 'text_card', bg: 'white', primitive: null, asset: null, overlay: null, emphasis: null,
    annotation: null, annotation_target: null, annotation_style: null, color: 'neutral', icon: null, token_role: null, ...v,
  });

  switch (base) {
    case 'intro_card':
      return { visual: V({ composition: 'text_card', overlay: text.trim() }), audio: { music: 'niche_in', sfx: ['whoosh', 'ding'] } };
    case 'niche_name_card':
      return { visual: V({ composition: 'text_card', overlay: slot.niche_label, emphasis: slot.niche_label, color: 'inline_green', token_role: 'emphasis' }), audio: { music: 'bed', sfx: ['whoosh'] } };

    case 'channel_proof_1': { // subscribers — annotated YT channel page (MG's most-used proof screen)
      const target = `${slot.subscribers_display} subscribers`;
      return {
        visual: V({ composition: 'yt_channel_page', bg: 'dark_gray', primitive: 'yellow_circle_screenshot_annotation',
          asset: { kind: 'yt_channel_page', ref: handle }, annotation: `yellow highlight on '${target}'`,
          annotation_target: target, annotation_style: 'yellow_highlight', color: 'yellow_highlight' }),
        audio: { music: 'bed', sfx: ['whoosh_on_load', 'ding_on_circle'] },
      };
    }
    case 'channel_proof_2': { // total views / growth — annotated YT About page
      const target = slot.growth?.phrase ?? 'total views';
      return {
        visual: V({ composition: 'yt_about_page', bg: 'dark_gray', primitive: 'yellow_circle_screenshot_annotation',
          asset: { kind: 'yt_about_page', ref: `${handle}/about` }, annotation: `yellow box on '${target}'`,
          annotation_target: target, annotation_style: 'yellow_box', color: 'yellow_highlight' }),
        audio: { music: 'bed', sfx: ['whoosh', 'ding'] },
      };
    }
    case 'top_video_callout':
      return {
        visual: V({ composition: 'most_popular_callout_card', bg: 'dark_gray', primitive: 'most_popular_callout_card',
          asset: { kind: 'yt_thumbnail_card', ref: tv?.thumbnail ?? null, video_url: tv?.url ?? null },
          overlay: tv ? `${(tv.title ?? '').slice(0, 42)} · ${tv.views_display} views` : null,
          annotation: 'yellow circle on view count', annotation_target: tv?.views_display ?? null, annotation_style: 'yellow_circle' }),
        audio: { music: 'bed', sfx: ['ding_on_card_entry'] },
      };
    case 'top_views_seq': {   // rapid-fire: one real YT thumbnail card per fragment
      const v = slot.top_videos[localIdx];
      return {
        visual: V({ composition: 'yt_thumbnail_card', bg: 'dark_gray',
          asset: { kind: 'yt_thumbnail_card', ref: v?.thumbnail ?? null, video_url: v?.url ?? null },
          overlay: v?.views_display ?? null }),
        audio: { music: 'bed', sfx: ['whoosh'] },
      };
    }
    case 'money_math': {
      const hasRpm = /RPM/i.test(text);
      const moneyShot = MONEY_RE.test(text) && !hasRpm;
      // card 1: re-show the top video we're estimating on
      if (/top video/i.test(text) && localIdx === 0) {
        return {
          visual: V({ composition: 'most_popular_callout_card', bg: 'dark_gray', primitive: 'most_popular_callout_card',
            asset: { kind: 'yt_thumbnail_card', ref: tv?.thumbnail ?? null, video_url: tv?.url ?? null },
            overlay: tv ? `${tv.views_display} views` : null }),
          audio: { music: 'bed', sfx: ['whoosh'] },
        };
      }
      // the "$X RPM" assumption — shrug icon (host signals "we're estimating") + green RPM
      if (hasRpm) {
        const rpm = text.match(/\$\s?\d[\d.]*\s*RPM/i);
        return { visual: V({ composition: 'icon_card', icon: 'shrug_with_question_marks', overlay: text.trim(),
            emphasis: rpm ? rpm[0] : null, color: 'inline_green', token_role: 'emphasis' }),
          audio: { music: 'bed', sfx: ['subtle_whoosh'] } };
      }
      // the money shot — big green figure + ding
      if (moneyShot) {
        const m = text.match(MONEY_RE);
        return { visual: V({ composition: 'money_shot_card', overlay: m ? m[0].trim() : text.trim(),
            emphasis: m ? m[0].trim() : null, color: 'money_shot_green', token_role: 'money_shot', big: true }),
          audio: { music: 'bed', sfx: ['ding_high_pitch'] } };
      }
      // "from ads." closer → dollar-sign host icon (monetization punctuation)
      if (/from ads/i.test(text)) {
        return { visual: V({ composition: 'icon_card', icon: 'dollar_sign_green_circle', overlay: text.trim(), token_role: 'connector' }), audio: { music: 'bed', sfx: ['subtle_whoosh'] } };
      }
      // connectors ("Even if we assume", "that one video alone")
      return { visual: V({ composition: 'text_card', overlay: text.trim(), token_role: 'connector' }), audio: { music: 'bed', sfx: ['subtle_whoosh'] } };
    }
    case 'competition': { // proprietary cohort count → clean stat card (our index, NOT a faked search page)
      const n = slot.cohort?.channel_count ?? null;
      const low = n != null && n < 25;
      const card = n != null ? (low ? `only ${n} channels` : `${n} channels`) : slot.niche_label;
      return {
        visual: V({ composition: low ? 'icon_card' : 'text_card', bg: 'white',
          overlay: card, emphasis: n != null ? String(n) : null,
          color: low ? 'inline_green' : 'neutral', token_role: 'emphasis',
          icon: low ? 'checkmark_green_circle' : null }),
        audio: { music: 'bed', sfx: low ? ['whoosh', 'subtle_ding'] : ['whoosh'] },
      };
    }
    case 'concept_tag': {
      const word = text.replace(/[^A-Za-z ]/g, '').trim().split('.')[0];
      return { visual: V({ composition: 'chalkboard_card', bg: 'dark_gray', primitive: 'chalkboard_concept_tag', overlay: word, color: 'chalk_cream' }),
        audio: { music: 'bed', sfx: ['soft_chimes'] } };
    }
    case 'appreciation': // viewer-appreciation beat → cat-thumbs-up host icon
      return { visual: V({ composition: 'icon_card', icon: 'cat_thumbs_up', overlay: text.trim() }), audio: { music: 'duck_deeper', sfx: [] } };

    default: {
      // generic narration text card. Friction/caution → inline_red; else a
      // salient number gets inline-green emphasis.
      const friction = /\b(but|however|careful|copyright|avoid|downside|the catch|risk|don't|do not|only catch)\b/i.test(text);
      const emph = salientPhrase(text);
      const color = friction ? 'inline_red' : (emph ? 'inline_green' : 'neutral');
      return { visual: V({ composition: 'text_card', overlay: text.trim(), emphasis: friction ? null : emph, color, token_role: friction ? 'emphasis' : null }),
        audio: { music: 'bed', sfx: [] } };
    }
  }
}

/** Panoramic thumbnail grid (video.views_panoramic) — a silent 3s reveal of
 *  the channel's top videos, shown right after the rapid-fire view sequence. */
function gridSegment(slot: ChannelSlots, startT: number, nicheIndex: number): TimelineSegment {
  const refs = slot.top_videos.map(v => v.thumbnail).filter((x): x is string => !!x);
  return {
    t_start: Math.round(startT * 10) / 10, t_end: Math.round((startT + 3) * 10) / 10, speech: '',
    visual: {
      composition: 'thumbnail_grid', bg: 'dark_gray', primitive: null,
      asset: { kind: 'thumbnail_grid', refs }, overlay: null, emphasis: null,
      annotation: null, annotation_target: null, annotation_style: null, color: 'neutral', icon: null, token_role: null,
    },
    audio: { music: 'bed', sfx: ['whoosh_on_grid_reveal'] },
    beat_id: 'top_views_pano', niche_index: nicheIndex,
  };
}

/** Build the recipe-showcase segments for one niche (real clip moments). */
function showcaseSegments(showcase: RecipeShowcase, startT: number, nicheIndex: number): { segs: TimelineSegment[]; t: number } {
  const segs: TimelineSegment[] = [];
  let t = startT;
  for (let i = 0; i < showcase.beats.length; i++) {
    const b = showcase.beats[i];
    const clipDur = Math.max(2, (b.clip_end ?? b.clip_start + 3) - b.clip_start);
    const dur = Math.max(clipDur, holdFor(b.narration, 2));
    segs.push({
      t_start: Math.round(t * 10) / 10,
      t_end: Math.round((t + dur) * 10) / 10,
      speech: b.narration,
      visual: {
        composition: 'mini_player_card', bg: 'dark_gray', primitive: 'content_demo_mini_player',
        asset: { kind: 'video_clip', video_url: b.source_video_url, ref: String(b.source_video_id), clip_start: b.clip_start, clip_end: b.clip_end, note: b.shows },
        overlay: null, emphasis: null, annotation: null, annotation_target: null, annotation_style: null, color: 'neutral', icon: null, token_role: null, diegetic: true,
      },
      audio: { music: 'duck_under_diegetic', sfx: ['whoosh_on_transition'] },
      beat_id: `recipe_showcase_${i + 1}`,
      niche_index: nicheIndex,
    });
    t += dur;
  }
  return { segs, t };
}

export function compileTimeline(
  script: GeneratedScript,
  slotsByChannel: Map<string, ChannelSlots>,
  showcaseByChannel: Map<string, RecipeShowcase>,
): Timeline {
  const segments: TimelineSegment[] = [];
  let t = 0;

  const push = (speech: string, visual: VisualSpec, audio: AudioSpec, beat_id: string, niche: number | null, hold: number) => {
    segments.push({ t_start: Math.round(t * 10) / 10, t_end: Math.round((t + hold) * 10) / 10, speech, visual, audio, beat_id, niche_index: niche });
    t += hold;
  };

  const blank = (v: Partial<VisualSpec>): VisualSpec => ({
    composition: 'text_card', bg: 'white', primitive: null, asset: null, overlay: null, emphasis: null,
    annotation: null, annotation_target: null, annotation_style: null, color: 'neutral', icon: null, token_role: null, ...v,
  });

  // intro (usually null — cold open)
  if (script.intro) {
    push(script.intro.text, blank({ composition: 'title_card', overlay: script.title }),
      { music: 'intro', sfx: ['whoosh'] }, 'intro', null, script.intro.duration_s || 4);
  }

  let recipeClips = 0;
  const showcasedChannels = new Set<string>();

  for (const niche of script.niches) {
    const slot = slotsByChannel.get(niche.channel_id);
    if (!slot) continue;
    const showcase = showcaseByChannel.get(niche.channel_id) ?? null;

    // Render the niche's narration beats, tracking where money_math ends so
    // the recipe showcase slots in right after it (before concept_tag).
    const beats = niche.beats;
    let lastMoneyIdx = -1;
    beats.forEach((b, i) => { if (baseBeat(b.beat_id) === 'money_math') lastMoneyIdx = i; });
    const insertAfter = lastMoneyIdx >= 0 ? lastMoneyIdx : beats.length - 1;

    // last rapid-fire view beat → follow it with the panoramic grid reveal
    let lastViewsSeqIdx = -1;
    beats.forEach((b, i) => { if (baseBeat(b.beat_id) === 'top_views_seq') lastViewsSeqIdx = i; });

    // per-base run index (for top_views_seq / money_math thumbnail binding)
    const runCounter = new Map<string, number>();

    beats.forEach((b: ScriptBeat, i: number) => {
      const base = baseBeat(b.beat_id);
      const idx = runCounter.get(base) ?? 0;
      runCounter.set(base, idx + 1);
      const { visual, audio } = renderVisual(base, b.text, slot, idx);
      const hold = b.hold_s && b.hold_s > 0 ? b.hold_s : holdFor(b.text);
      push(b.text, visual, audio, b.beat_id, niche.niche_index, hold);

      // After the rapid-fire sequence, a silent panoramic grid of their top
      // videos (video.views_panoramic) — MG's "consistent views" beat.
      if (i === lastViewsSeqIdx && slot.top_videos.filter(v => v.thumbnail).length >= 4) {
        const g = gridSegment(slot, t, niche.niche_index);
        segments.push(g);
        t = g.t_end;
      }

      // After the last money_math beat, splice in the transcript-grounded
      // recipe showcase (the content highlights with real clips).
      if (i === insertAfter && showcase && showcase.beats.length > 0) {
        const { segs, t: nt } = showcaseSegments(showcase, t, niche.niche_index);
        for (const s of segs) segments.push(s);
        recipeClips += segs.length;
        showcasedChannels.add(niche.channel_id);
        t = nt;
      }
    });
  }

  // cta — final card is the next-video pitch (pointing-hand icon + green
  // "check out this video" + ascending sting); earlier cards plain text.
  const cards = script.cta?.cards ?? [];
  cards.forEach((c, i) => {
    const last = i === cards.length - 1;
    const visual = last
      ? blank({ composition: 'icon_card', icon: 'pointing_hand', overlay: c.text, emphasis: 'check out this video', color: 'inline_green', token_role: 'emphasis' })
      : blank({ composition: 'text_card', overlay: c.text, token_role: 'connector' });
    push(c.text, visual, { music: 'bed', sfx: last ? ['ascending_sting'] : ['subtle_whoosh'] }, 'cta', null, c.hold_s && c.hold_s > 0 ? c.hold_s : holdFor(c.text, 0.8));
  });

  const wc = segments.reduce((a, s) => a + words(s.speech), 0);
  return {
    title: script.title,
    segments,
    duration_s: Math.round(t),
    meta: {
      version: TIMELINE_VERSION,
      niche_count: script.niches.length,
      segment_count: segments.length,
      word_count: wc,
      recipe_clips: recipeClips,
      channels_with_showcase: showcasedChannels.size,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Orchestrator: channels → narration script + recipe showcases → timeline
// ─────────────────────────────────────────────────────────────────────

export interface GroupTimelineResult {
  script: GeneratedScript;
  timeline: Timeline;
  showcase_errors: Array<{ channel_id: string; error: string }>;
}

export async function generateGroupTimeline(channelIds: string[], opts: GenerateOpts = {}): Promise<GroupTimelineResult> {
  if (channelIds.length === 0) throw new Error('no channels supplied');

  // 1) narration script (recipe beats deliberately omitted — showcase owns them)
  const script = await generateListicleScript(channelIds, opts);

  // 2) slots + recipe showcase per channel (in parallel)
  const uniqueIds = Array.from(new Set(script.niches.map(n => n.channel_id)));
  const slotsByChannel = new Map<string, ChannelSlots>();
  const showcaseByChannel = new Map<string, RecipeShowcase>();
  const showcase_errors: Array<{ channel_id: string; error: string }> = [];

  await Promise.all(uniqueIds.map(async (cid) => {
    try { slotsByChannel.set(cid, await assembleChannelSlots(cid)); } catch { /* skip */ }
    try { showcaseByChannel.set(cid, await getOrGenerateRecipeShowcase(cid)); }
    catch (e) { showcase_errors.push({ channel_id: cid, error: (e as Error).message }); }
  }));

  // 3) compile the tri-track timeline
  const timeline = compileTimeline(script, slotsByChannel, showcaseByChannel);

  // 4) persist the timeline alongside the script (best-effort)
  try {
    const pool = await getPool();
    const groupKey = [...uniqueIds].sort().join(',').slice(0, 500);
    await pool.query(
      `UPDATE content_gen_scripts SET timeline_jsonb = $2, updated_at = NOW() WHERE group_key = $1`,
      [groupKey, JSON.stringify(timeline)],
    );
  } catch { /* best-effort */ }

  return { script, timeline, showcase_errors };
}
