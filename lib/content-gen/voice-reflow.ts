/**
 * Voice reflow — lock the timeline's hold_s to MEASURED TTS duration.
 *
 * The tri-track timeline was compiled with estimated holds (words / 2.8s).
 * Now that ElevenLabs has spoken every line, we know the real durations.
 * For each spoken segment:
 *   - hold_s = max(audio_duration + tail, baseline_hold)
 *     `tail` is a small silence buffer so beats don't slam into each other.
 * For recipe `mini_player` segments (real video clips):
 *   - hold_s = max(clip_duration, audio_duration + tail)
 * For silent visual beats (panoramic grid, transitions):
 *   - keep planned hold_s as-is (no audio to lock to).
 *
 * Re-cumulates t_start/t_end across the whole timeline, augments each
 * segment with audio_path + audio_duration_s + voice_hash, and persists
 * the reflowed timeline back to content_gen_scripts.timeline_jsonb.
 */

import type { Timeline, TimelineSegment } from './timeline';
import { ttsBatch, type VoiceOpts, type VoiceAsset } from './voice';

const TAIL_S = 0.12;   // silence pad after each spoken beat

export interface ReflowedSegment extends TimelineSegment {
  audio_path?: string;       // /api/admin/content-gen/voice/file?hash=... at the route layer
  audio_duration_s?: number;
  voice_hash?: string;
  hold_baseline_s?: number;  // the pre-voice estimate (for diff display)
}

export interface ReflowedTimeline extends Timeline {
  segments: ReflowedSegment[];
  voice: {
    voice_id: string;
    model_id: string;
    spoken_segments: number;
    chars_total: number;
    audio_total_s: number;
    cache_hits: number;
    cache_misses: number;
    errors: Array<{ text: string; error: string }>;
  };
}

function isMiniPlayer(s: TimelineSegment): boolean {
  return s.visual?.composition === 'mini_player_card' || s.beat_id.startsWith('recipe_showcase');
}

function recipeClipDur(s: TimelineSegment): number {
  const a = s.visual?.asset;
  if (!a || a.kind !== 'video_clip') return 0;
  const cs = Number(a.clip_start ?? 0);
  const ce = Number(a.clip_end ?? cs);
  return Math.max(0, ce - cs);
}

/** TTS every spoken segment, then rebuild holds + timecodes. */
export async function reflowTimelineWithVoice(timeline: Timeline, opts: VoiceOpts = {}): Promise<ReflowedTimeline> {
  // Collect distinct spoken texts (dedup → caches more cleanly + saves chars).
  const spoken = timeline.segments
    .map((s, i) => ({ i, text: s.speech?.trim() ?? '' }))
    .filter(x => x.text.length > 0);

  const uniqTexts = Array.from(new Set(spoken.map(x => x.text)));
  const results = await ttsBatch(uniqTexts, opts);
  const byText = new Map<string, VoiceAsset>();
  const errors: Array<{ text: string; error: string }> = [];
  results.forEach((r, k) => {
    const text = uniqTexts[k];
    if ('error' in r) errors.push({ text, error: r.error });
    else byText.set(text, r);
  });

  // Build reflowed segments.
  const segs: ReflowedSegment[] = [];
  let t = 0;
  let chars = 0, audioTotal = 0, cacheHits = 0, cacheMisses = 0;

  for (const seg of timeline.segments) {
    const baseline = seg.t_end - seg.t_start;
    const speech = seg.speech?.trim() ?? '';
    const asset = speech ? byText.get(speech) : undefined;

    let hold: number;
    let extra: Partial<ReflowedSegment> = {};

    if (asset) {
      const need = asset.duration_s + TAIL_S;
      const minHold = isMiniPlayer(seg) ? Math.max(recipeClipDur(seg), baseline) : baseline;
      hold = Math.max(need, minHold);
      chars += asset.char_count;
      audioTotal += asset.duration_s;
      if (asset.cached) cacheHits++; else cacheMisses++;
      extra = {
        audio_path: `/api/admin/content-gen/voice/file?hash=${asset.text_hash}`,
        audio_duration_s: Math.round(asset.duration_s * 100) / 100,
        voice_hash: asset.text_hash,
        hold_baseline_s: Math.round(baseline * 10) / 10,
      };
    } else if (isMiniPlayer(seg)) {
      hold = Math.max(recipeClipDur(seg), baseline);
      extra = { hold_baseline_s: Math.round(baseline * 10) / 10 };
    } else {
      hold = baseline;
    }

    segs.push({
      ...seg,
      ...extra,
      t_start: Math.round(t * 10) / 10,
      t_end: Math.round((t + hold) * 10) / 10,
    });
    t += hold;
  }

  return {
    ...timeline,
    segments: segs,
    duration_s: Math.round(t),
    voice: {
      voice_id: opts.voice_id ?? 'onwK4e9ZLuTAKqWW03F9',
      model_id: opts.model_id ?? 'eleven_multilingual_v2',
      spoken_segments: spoken.length,
      chars_total: chars,
      audio_total_s: Math.round(audioTotal * 10) / 10,
      cache_hits: cacheHits,
      cache_misses: cacheMisses,
      errors,
    },
  };
}
