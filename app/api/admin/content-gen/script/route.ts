import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { generateListicleScript, type GenerateOpts } from '@/lib/content-gen/script-gen';

/**
 * Generate the Stage-D narration script for a GROUP of channels.
 *
 *   POST /api/admin/content-gen/script
 *     body: { videoIds?: number[], channelIds?: string[],
 *             title?, preamble?, ctaTopicPhrase?, sortByMoney? }
 *   GET  /api/admin/content-gen/script?videoIds=1,2,3   (quick dry-run)
 *
 * Resolves videoIds → channels, assembles each channel's slot data, and
 * makes one Gemini call to produce the full timestamped script. Persists
 * to content_gen_scripts and returns the script inline.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 180;

async function resolveChannels(videoIds: number[], channelIds: string[]): Promise<string[]> {
  let out = [...channelIds];
  if (videoIds.length > 0) {
    const pool = await getPool();
    const r = await pool.query<{ channel_id: string; id: number }>(
      `SELECT id, channel_id FROM niche_spy_videos WHERE id = ANY($1::int[]) AND channel_id IS NOT NULL`,
      [videoIds],
    );
    // Preserve the caller's videoIds order, de-duped.
    const byVid = new Map(r.rows.map(x => [x.id, x.channel_id]));
    const ordered = videoIds.map(v => byVid.get(v)).filter((c): c is string => !!c);
    out = Array.from(new Set([...out, ...ordered]));
  }
  return Array.from(new Set(out));
}

async function handle(channelIds: string[], opts: GenerateOpts) {
  if (channelIds.length === 0) {
    return NextResponse.json({ error: 'videoIds or channelIds required' }, { status: 400 });
  }
  const t0 = Date.now();
  const script = await generateListicleScript(channelIds, opts);
  return NextResponse.json({
    ok: true,
    channels: channelIds.length,
    elapsed_ms: Date.now() - t0,
    script,
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const channelIds = (sp.get('channelIds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const videoIds = (sp.get('videoIds') ?? '').split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));
  const resolved = await resolveChannels(videoIds, channelIds);
  const opts: GenerateOpts = {
    title: sp.get('title') ?? undefined,
    preamble: sp.get('preamble') === '1' || sp.get('preamble') === 'true',
    ctaTopicPhrase: sp.get('ctaTopicPhrase') ?? undefined,
    sortByMoney: sp.get('sortByMoney') !== '0',
  };
  return handle(resolved, opts);
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    videoIds?: number[]; channelIds?: string[];
    title?: string; preamble?: boolean; ctaTopicPhrase?: string; sortByMoney?: boolean;
  };
  const videoIds = (body.videoIds ?? []).map(Number).filter(n => Number.isFinite(n));
  const channelIds = (body.channelIds ?? []).map(String).filter(Boolean);
  const resolved = await resolveChannels(videoIds, channelIds);
  const opts: GenerateOpts = {
    title: body.title,
    preamble: body.preamble,
    ctaTopicPhrase: body.ctaTopicPhrase,
    sortByMoney: body.sortByMoney ?? true,
  };
  return handle(resolved, opts);
}
