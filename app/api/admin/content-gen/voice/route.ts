import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { reflowTimelineWithVoice } from '@/lib/content-gen/voice-reflow';
import type { Timeline } from '@/lib/content-gen/timeline';

/**
 * Voice + reflow for a previously-generated group timeline.
 *
 *   POST { videoIds?, channelIds?, voice_id?, model_id?, settings?, force? }
 *     - Loads the stored timeline for the group (by sorted channel_ids key),
 *       TTSes every spoken beat (cache-hit fast path), reflows hold_s to
 *       measured durations, persists, returns the reflowed timeline.
 *
 *   GET ?videoIds=...   — quick: load + reflow the stored timeline.
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

async function handle(channelIds: string[], opts: { voice_id?: string; model_id?: string; settings?: Record<string, number | boolean> }) {
  if (channelIds.length === 0) return NextResponse.json({ error: 'videoIds or channelIds required' }, { status: 400 });
  const loaded = await loadStoredTimeline(channelIds);
  if (!loaded) return NextResponse.json({ error: 'no stored timeline for this group — generate one first via /timeline' }, { status: 404 });

  const t0 = Date.now();
  const reflowed = await reflowTimelineWithVoice(loaded.timeline, opts);

  // Persist the reflowed timeline back (replaces the pre-voice version).
  try {
    const pool = await getPool();
    await pool.query(
      `UPDATE content_gen_scripts SET timeline_jsonb = $2, est_duration_s = $3, updated_at = NOW() WHERE group_key = $1`,
      [loaded.groupKey, JSON.stringify(reflowed), reflowed.duration_s],
    );
  } catch { /* best-effort */ }

  return NextResponse.json({
    ok: true,
    channels: channelIds.length,
    elapsed_ms: Date.now() - t0,
    timeline: reflowed,
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const channelIds = (sp.get('channelIds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const videoIds = (sp.get('videoIds') ?? '').split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));
  return handle(await resolveChannels(videoIds, channelIds), {
    voice_id: sp.get('voice_id') ?? undefined,
    model_id: sp.get('model_id') ?? undefined,
  });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    videoIds?: number[]; channelIds?: string[];
    voice_id?: string; model_id?: string; settings?: Record<string, number | boolean>;
  };
  const videoIds = (body.videoIds ?? []).map(Number).filter(n => Number.isFinite(n));
  const channelIds = (body.channelIds ?? []).map(String).filter(Boolean);
  return handle(await resolveChannels(videoIds, channelIds), {
    voice_id: body.voice_id, model_id: body.model_id, settings: body.settings,
  });
}
