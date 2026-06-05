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
export interface VisualSpec {
  composition: string;            // text_card | annotated_screenshot | most_popular_callout_card | thumbnail_card_rapid_fire | thumbnail_card | money_card | icon_card | mini_player_card | chalkboard_card | title_sequence
  bg: 'white' | 'dark_gray' | 'mixed';
  asset: { kind: string; ref?: string | null; video_url?: string | null; clip_start?: number; clip_end?: number; note?: string } | null;
  overlay: string | null;         // on-screen text
  annotation: string | null;      // e.g. "yellow ring on '160K subscribers'"
  color: string;                  // neutral | money_shot_green | inline_green | yellow_ring | chalk_cream | ...
  icon: string | null;
  diegetic?: boolean;             // play source video's native audio (recipe clips)
  big?: boolean;                  // oversized money-shot text
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

/** Map one narration fragment → {visual, audio} per slot-rendering-class-b. */
function renderVisual(base: string, text: string, slot: ChannelSlots, localIdx: number): { visual: VisualSpec; audio: AudioSpec } {
  const tv = slot.top_video;
  const handle = channelHandleUrl(slot);
  const V = (v: Partial<VisualSpec>): VisualSpec => ({
    composition: 'text_card', bg: 'white', asset: null, overlay: null, annotation: null, color: 'neutral', icon: null, ...v,
  });

  switch (base) {
    case 'intro_card':
      return { visual: V({ composition: 'text_card', overlay: text.trim() }), audio: { music: 'niche_in', sfx: ['whoosh', 'ding'] } };
    case 'niche_name_card':
      return { visual: V({ composition: 'text_card', overlay: slot.niche_label, color: 'inline_green_on_keyword' }), audio: { music: 'bed', sfx: ['whoosh'] } };
    case 'channel_proof_1':  // subscribers — annotated channel-page screenshot
      return {
        visual: V({ composition: 'annotated_screenshot', bg: 'dark_gray', asset: { kind: 'yt_channel_page', ref: handle },
          annotation: `yellow ring on '${slot.subscribers_display} subscribers'`, color: 'yellow_ring' }),
        audio: { music: 'bed', sfx: ['whoosh_on_load', 'ding_on_circle'] },
      };
    case 'channel_proof_2': { // total views / growth — annotated about page
      const gp = slot.growth?.phrase;
      return {
        visual: V({ composition: 'annotated_screenshot', bg: 'dark_gray', asset: { kind: 'yt_about_page', ref: `${handle}/about` },
          annotation: `yellow ring on total-views (${gp ?? 'total views'})`, color: 'yellow_ring' }),
        audio: { music: 'bed', sfx: ['whoosh', 'ding'] },
      };
    }
    case 'top_video_callout':
      return {
        visual: V({ composition: 'most_popular_callout_card', bg: 'dark_gray',
          asset: { kind: 'thumbnail', ref: tv?.thumbnail ?? null, video_url: tv?.url ?? null },
          overlay: tv ? `${(tv.title ?? '').slice(0, 42)} · ${tv.views_display} views` : null,
          annotation: 'yellow ring on view count' }),
        audio: { music: 'bed', sfx: ['ding_on_card_entry'] },
      };
    case 'top_views_seq': {   // rapid-fire: one real thumbnail per fragment
      const v = slot.top_videos[localIdx];
      return {
        visual: V({ composition: 'thumbnail_card_rapid_fire', bg: 'dark_gray',
          asset: { kind: 'thumbnail', ref: v?.thumbnail ?? null, video_url: v?.url ?? null },
          overlay: v?.views_display ?? null }),
        audio: { music: 'bed', sfx: ['whoosh'] },
      };
    }
    case 'money_math': {
      const hasRpm = /RPM/i.test(text);
      const moneyShot = MONEY_RE.test(text) && !hasRpm;
      if (/top video/i.test(text) && localIdx === 0) {
        return {
          visual: V({ composition: 'thumbnail_card', bg: 'dark_gray',
            asset: { kind: 'thumbnail', ref: tv?.thumbnail ?? null, video_url: tv?.url ?? null },
            overlay: tv ? `${tv.views_display} views` : null }),
          audio: { music: 'bed', sfx: ['whoosh'] },
        };
      }
      if (hasRpm) {
        return { visual: V({ composition: 'icon_card', icon: 'shrug_with_question_marks', overlay: text.trim(), color: 'inline_green_on_rpm' }),
          audio: { music: 'bed', sfx: ['subtle_whoosh'] } };
      }
      if (moneyShot) {
        const m = text.match(MONEY_RE);
        return { visual: V({ composition: 'money_card', overlay: m ? m[0].trim() : text.trim(), color: 'money_shot_green', big: true }),
          audio: { music: 'bed', sfx: ['ding_high_pitch'] } };
      }
      return { visual: V({ composition: 'text_card', overlay: text.trim() }), audio: { music: 'bed', sfx: ['subtle_whoosh'] } };
    }
    case 'concept_tag': {
      const word = text.replace(/[^A-Za-z ]/g, '').trim().split('.')[0];
      return { visual: V({ composition: 'chalkboard_card', bg: 'dark_gray', overlay: word, color: 'chalk_cream' }),
        audio: { music: 'bed', sfx: ['soft_chimes'] } };
    }
    default:
      return { visual: V({ composition: 'text_card', overlay: text.trim() }), audio: { music: 'bed', sfx: [] } };
  }
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
        composition: 'mini_player_card', bg: 'dark_gray',
        asset: { kind: 'video_clip', video_url: b.source_video_url, ref: String(b.source_video_id), clip_start: b.clip_start, clip_end: b.clip_end, note: b.shows },
        overlay: null, annotation: null, color: 'neutral', icon: null, diegetic: true,
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

  // intro (usually null — cold open)
  if (script.intro) {
    push(script.intro.text, {
      composition: 'title_sequence', bg: 'white', asset: null, overlay: script.title, annotation: null, color: 'neutral', icon: null,
    }, { music: 'intro', sfx: ['whoosh'] }, 'intro', null, script.intro.duration_s || 4);
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

    // per-base run index (for top_views_seq / money_math thumbnail binding)
    const runCounter = new Map<string, number>();

    beats.forEach((b: ScriptBeat, i: number) => {
      const base = baseBeat(b.beat_id);
      const idx = runCounter.get(base) ?? 0;
      runCounter.set(base, idx + 1);
      const { visual, audio } = renderVisual(base, b.text, slot, idx);
      const hold = b.hold_s && b.hold_s > 0 ? b.hold_s : holdFor(b.text);
      push(b.text, visual, audio, b.beat_id, niche.niche_index, hold);

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

  // cta
  const cards = script.cta?.cards ?? [];
  cards.forEach((c, i) => {
    const last = i === cards.length - 1;
    push(c.text, {
      composition: 'icon_card', bg: 'white', asset: null, overlay: c.text,
      annotation: null, color: last ? "inline_green_on_'check out this video'" : 'neutral', icon: last ? 'pointing_hand' : null,
    }, { music: 'bed', sfx: last ? ['ascending_sting'] : [] }, 'cta', null, c.hold_s && c.hold_s > 0 ? c.hold_s : holdFor(c.text, 0.8));
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
