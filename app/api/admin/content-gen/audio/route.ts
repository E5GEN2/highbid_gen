import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { composeAudioBed } from '@/lib/content-gen/audio-bed';
import { warmAllSfx, TOKENS } from '@/lib/content-gen/sfx';
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

/**
 * GET overwatch — returns the three asset panels the Audio Gen GUI shows:
 *   tokens (the SFX/music vocabulary + which are cached)
 *   voice  (TTS'd phrase library, recent first)
 *   beds   (composed group beds)
 *
 * GET ?action=warm just runs warmAllSfx() and returns the result.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  if (sp.get('action') === 'warm') {
    const r = await warmAllSfx();
    return NextResponse.json({ ok: true, ...r });
  }

  const pool = await getPool();

  // SFX/music token panel — every token in TOKENS, joined with its newest
  // cached asset (if any). LATERAL gives us one row per token, joined to its
  // most-recent generation at default duration.
  const sfxRows = (await pool.query<{ sfx_hash: string; token: string; kind: string; duration_s: number; bytes: number; last_used_at: string }>(
    `SELECT DISTINCT ON (token) sfx_hash, token, kind, duration_s, bytes, last_used_at
       FROM content_gen_sfx_assets
      ORDER BY token, last_used_at DESC`,
  )).rows;
  const sfxByToken = new Map(sfxRows.map(r => [r.token, r]));
  const tokens = Object.entries(TOKENS).map(([token, spec]) => {
    const a = sfxByToken.get(token);
    return {
      token, kind: spec.kind, prompt: spec.prompt,
      default_duration_s: spec.default_duration_s,
      cached: !!a,
      duration_s: a?.duration_s ?? null,
      bytes: a?.bytes ?? null,
      last_used_at: a?.last_used_at ?? null,
      file_url: a ? `/api/admin/content-gen/sfx/file?hash=${a.sfx_hash}` : null,
    };
  });

  // Voice library — recent first, cap reasonable.
  const voiceLimit = Math.max(1, Math.min(500, parseInt(sp.get('voiceLimit') ?? '50')));
  const voices = (await pool.query<{ text_hash: string; text: string; voice_id: string; model_id: string; duration_s: number; bytes: number; char_count: number; created_at: string; last_used_at: string }>(
    `SELECT text_hash, text, voice_id, model_id, duration_s, bytes, char_count, created_at, last_used_at
       FROM content_gen_voice_assets ORDER BY last_used_at DESC LIMIT $1`, [voiceLimit],
  )).rows.map(r => ({ ...r, file_url: `/api/admin/content-gen/voice/file?hash=${r.text_hash}` }));

  // Group beds — every group that has a stored timeline; pair with channel
  // names. Detect bed presence by checking the volume? The composer caches
  // by hash(group_key + timeline_signature), which we can't recompute here
  // without re-reflowing. So the listing returns whether a script's timeline
  // is voice-locked (=> a bed CAN be composed) + composes only on demand.
  // voice_locked: the reflowed timeline has a top-level "voice" key.
  // (timeline_jsonb->'voice') IS NOT NULL is equivalent to JSONB has-key,
  // and doesn't trip the pg driver's `?` parameter handling.
  const groups = (await pool.query<{ group_key: string; title: string | null; channel_ids: string[]; est_duration_s: number | null; voice_locked: boolean; updated_at: string; word_count: number | null }>(
    `SELECT group_key, title, channel_ids, est_duration_s, word_count, updated_at,
            (timeline_jsonb->'voice') IS NOT NULL AS voice_locked
       FROM content_gen_scripts
      WHERE timeline_jsonb IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 50`,
  )).rows;

  // Resolve channel names for display.
  const allChannelIds = Array.from(new Set(groups.flatMap(g => g.channel_ids ?? [])));
  let nameByCid = new Map<string, string>();
  if (allChannelIds.length > 0) {
    const r = await pool.query<{ channel_id: string; channel_name: string | null }>(
      `SELECT channel_id, channel_name FROM niche_spy_channels WHERE channel_id = ANY($1::text[])`, [allChannelIds],
    );
    nameByCid = new Map(r.rows.map(x => [x.channel_id, x.channel_name ?? x.channel_id]));
  }

  const groupsOut = groups.map(g => ({
    group_key: g.group_key,
    title: g.title,
    channels: (g.channel_ids ?? []).map(cid => ({ channel_id: cid, name: nameByCid.get(cid) ?? cid })),
    est_duration_s: g.est_duration_s,
    word_count: g.word_count,
    voice_locked: g.voice_locked,
    updated_at: g.updated_at,
  }));

  return NextResponse.json({ ok: true, tokens, voices, groups: groupsOut });
}
