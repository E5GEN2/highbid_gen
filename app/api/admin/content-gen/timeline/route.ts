import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { generateGroupTimeline } from '@/lib/content-gen/timeline';
import type { GenerateOpts } from '@/lib/content-gen/script-gen';

/**
 * Full aud2vis timeline for a GROUP of channels (Stage D, the deliverable).
 *
 * Orchestrates: narration script (recipe beats omitted) + per-channel
 * transcript-grounded recipe showcase + deterministic tri-track compile.
 * Returns { timeline, script, showcase_errors } and persists the timeline.
 *
 *   POST { videoIds?, channelIds?, title?, preamble?, ctaTopicPhrase?, sortByMoney? }
 *   GET  ?videoIds=1,2,3
 *
 * NOTE: a cold call also generates any missing recipe showcases (one Gemini
 * call each). Pre-warm via /recipe-showcase to keep this request fast.
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

async function handle(channelIds: string[], opts: GenerateOpts) {
  if (channelIds.length === 0) return NextResponse.json({ error: 'videoIds or channelIds required' }, { status: 400 });
  const t0 = Date.now();
  const { script, timeline, showcase_errors } = await generateGroupTimeline(channelIds, opts);
  return NextResponse.json({ ok: true, channels: channelIds.length, elapsed_ms: Date.now() - t0, timeline, script, showcase_errors });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const channelIds = (sp.get('channelIds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const videoIds = (sp.get('videoIds') ?? '').split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));
  const opts: GenerateOpts = {
    title: sp.get('title') ?? undefined,
    preamble: sp.get('preamble') === '1',
    ctaTopicPhrase: sp.get('ctaTopicPhrase') ?? undefined,
    sortByMoney: sp.get('sortByMoney') !== '0',
  };
  return handle(await resolveChannels(videoIds, channelIds), opts);
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { videoIds?: number[]; channelIds?: string[]; title?: string; preamble?: boolean; ctaTopicPhrase?: string; sortByMoney?: boolean };
  const videoIds = (body.videoIds ?? []).map(Number).filter(n => Number.isFinite(n));
  const channelIds = (body.channelIds ?? []).map(String).filter(Boolean);
  const opts: GenerateOpts = { title: body.title, preamble: body.preamble, ctaTopicPhrase: body.ctaTopicPhrase, sortByMoney: body.sortByMoney ?? true };
  return handle(await resolveChannels(videoIds, channelIds), opts);
}
