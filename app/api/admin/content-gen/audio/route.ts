import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { composeAudioBed } from '@/lib/content-gen/audio-bed';
import { warmAllSfx } from '@/lib/content-gen/sfx';
import { reflowTimelineWithVoice } from '@/lib/content-gen/voice-reflow';
import type { Timeline } from '@/lib/content-gen/timeline';
import type { ReflowedTimeline } from '@/lib/content-gen/voice-reflow';

/**
 * Audio-bed composer for a group.
 *
 *   POST { videoIds?, channelIds?, voiceFirst?, warm?, force? }
 *     - Loads the stored (reflowed) timeline; if it isn't voice-locked yet
 *       and voiceFirst=true (default), runs TTS-reflow first.
 *     - Optionally warm=true → pre-generate every SFX/music token in the
 *       registry before composing (so the ffmpeg run finds everything cached).
 *     - Composes narration + ducked music bed + SFX → single MP3, persists.
 *
 *   GET ?action=warm                 → POST warmAllSfx() (utility)
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

async function resolveChannels(videoIds: number[], channelIds: string[]): Promise<string[]> {
  let out = [...channelIds];
  if (videoIds.length > 0) {
    const pool = await getPool();
    const r = await pool.query<{ id: number; channel_id: string }>(
      `SELECT id, channel_id FROM niche_spy_videos WHERE id = ANY($1::int[]) AND channel_id IS NOT NULL`,
      [videoIds],
    );
    const byVid = new Map(r.rows.map(x => [x.id, x.channel_id]));
    out = Array.from(new Set([...out, ...videoIds.map(v => byVid.get(v)).filter((c): c is string => !!c)]));
  }
  return Array.from(new Set(out));
}

async function loadStoredTimeline(channelIds: string[]): Promise<{ groupKey: string; timeline: Timeline } | null> {
  const groupKey = [...channelIds].sort().join(',').slice(0, 500);
  const pool = await getPool();
  const r = await pool.query<{ timeline_jsonb: Timeline | null }>(
    `SELECT timeline_jsonb FROM content_gen_scripts WHERE group_key = $1`, [groupKey],
  );
  const tl = r.rows[0]?.timeline_jsonb;
  if (!tl) return null;
  return { groupKey, timeline: tl };
}

function isReflowed(tl: Timeline): tl is ReflowedTimeline {
  return Boolean((tl as ReflowedTimeline).voice && tl.segments.some(s => 'audio_duration_s' in s));
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    videoIds?: number[]; channelIds?: string[];
    voiceFirst?: boolean; warm?: boolean; force?: boolean;
  };
  const videoIds = (body.videoIds ?? []).map(Number).filter(n => Number.isFinite(n));
  const channelIds = (body.channelIds ?? []).map(String).filter(Boolean);
  const ch = await resolveChannels(videoIds, channelIds);
  if (ch.length === 0) return NextResponse.json({ error: 'videoIds or channelIds required' }, { status: 400 });

  const loaded = await loadStoredTimeline(ch);
  if (!loaded) return NextResponse.json({ error: 'no stored timeline for this group — run /timeline first' }, { status: 404 });

  // Ensure the timeline is voice-locked. If not + voiceFirst (default true),
  // reflow with TTS now and persist.
  let timeline: ReflowedTimeline;
  if (isReflowed(loaded.timeline)) {
    timeline = loaded.timeline;
  } else if (body.voiceFirst !== false) {
    timeline = await reflowTimelineWithVoice(loaded.timeline);
    const pool = await getPool();
    await pool.query(
      `UPDATE content_gen_scripts SET timeline_jsonb = $2, est_duration_s = $3, updated_at = NOW() WHERE group_key = $1`,
      [loaded.groupKey, JSON.stringify(timeline), timeline.duration_s],
    );
  } else {
    return NextResponse.json({ error: 'timeline is not voice-locked; pass voiceFirst=true or run /voice first' }, { status: 400 });
  }

  // Optional pre-warm so the ffmpeg run isn't gated on a slow 11labs call.
  let warmed: Awaited<ReturnType<typeof warmAllSfx>> | null = null;
  if (body.warm) warmed = await warmAllSfx();

  const t0 = Date.now();
  const bed = await composeAudioBed(loaded.groupKey, timeline, { force: body.force });
  return NextResponse.json({
    ok: true,
    channels: ch.length,
    elapsed_ms: Date.now() - t0,
    voice: timeline.voice,
    sfx_warm: warmed ? { ok: warmed.ok, failed: warmed.failed } : null,
    bed,
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  if (sp.get('action') === 'warm') {
    const r = await warmAllSfx();
    return NextResponse.json({ ok: true, ...r });
  }
  return NextResponse.json({ error: 'pass action=warm or POST to compose' }, { status: 400 });
}
