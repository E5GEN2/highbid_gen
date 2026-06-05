import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { getOrGenerateRecipeShowcase } from '@/lib/content-gen/recipe-showcase';

/**
 * Transcript-grounded recipe showcase per channel — the content highlights
 * (paired narration + real clip moments) for the recipe section.
 *
 *   POST { videoIds?: number[], channelIds?: string[], force?: boolean }
 *   GET  ?videoIds=1,2,3   (cached only via getOrGenerate, generates if absent)
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 180;

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

async function handle(channelIds: string[], force: boolean) {
  if (channelIds.length === 0) return NextResponse.json({ error: 'videoIds or channelIds required' }, { status: 400 });
  const t0 = Date.now();
  const results = await Promise.all(channelIds.map(async (cid) => {
    try { return await getOrGenerateRecipeShowcase(cid, force); }
    catch (e) { return { channel_id: cid, error: (e as Error).message }; }
  }));
  const ok = results.filter(r => !('error' in r)).length;
  return NextResponse.json({ ok: true, channels: channelIds.length, generated_or_cached: ok, elapsed_ms: Date.now() - t0, showcases: results });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const channelIds = (sp.get('channelIds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const videoIds = (sp.get('videoIds') ?? '').split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));
  return handle(await resolveChannels(videoIds, channelIds), sp.get('force') === '1');
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { videoIds?: number[]; channelIds?: string[]; force?: boolean };
  const videoIds = (body.videoIds ?? []).map(Number).filter(n => Number.isFinite(n));
  const channelIds = (body.channelIds ?? []).map(String).filter(Boolean);
  return handle(await resolveChannels(videoIds, channelIds), body.force === true);
}
