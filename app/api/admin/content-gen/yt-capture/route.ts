import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { captureBatch, captureYtScreen, type ScreenKind } from '@/lib/content-gen/yt-capture';

/**
 * YT screen capture orchestrator.
 *
 *   POST { videoIds?: int[], channelIds?: string[], kind?, geo?, force?, concurrency? }
 *     → captures the channel_page (default) for each channel via Playwright
 *       through xgodo proxies. Cached per (channel, kind, date_bucket).
 *
 *   GET ?videoIds=...&kind=... — list current state (does NOT capture).
 *   GET /single?channelId=... — captures one synchronously (for debug).
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

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    videoIds?: number[]; channelIds?: string[];
    kind?: ScreenKind; geo?: string; force?: boolean; concurrency?: number;
  };
  const videoIds = (body.videoIds ?? []).map(Number).filter(n => Number.isFinite(n));
  const channelIds = (body.channelIds ?? []).map(String).filter(Boolean);
  const ch = await resolveChannels(videoIds, channelIds);
  if (ch.length === 0) return NextResponse.json({ error: 'videoIds or channelIds required' }, { status: 400 });

  const t0 = Date.now();
  const result = await captureBatch(ch, { kind: body.kind ?? 'channel_page', geo: body.geo, force: body.force, concurrency: body.concurrency });
  return NextResponse.json({
    ok: true,
    elapsed_ms: Date.now() - t0,
    requested: ch.length,
    ok_count: result.ok,
    failed: result.failed,
    results: result.results.map(r => 'error' in r ? r : { ...r, file_url: `/api/admin/content-gen/yt-capture/file?id=${r.id}` }),
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;

  // Debug single-capture path: GET /yt-capture?channelId=...&kind=...&force=1
  const singleChannel = sp.get('channelId');
  if (singleChannel) {
    const kind = (sp.get('kind') as ScreenKind) ?? 'channel_page';
    const force = sp.get('force') === '1';
    const t0 = Date.now();
    try {
      const r = await captureYtScreen(singleChannel, { kind, force });
      return NextResponse.json({ ok: true, elapsed_ms: Date.now() - t0, result: { ...r, file_url: `/api/admin/content-gen/yt-capture/file?id=${r.id}` } });
    } catch (e) { return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 }); }
  }

  // List mode: returns current rows for the requested channels (or recent).
  const channelIds = (sp.get('channelIds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const videoIds = (sp.get('videoIds') ?? '').split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));
  const ch = await resolveChannels(videoIds, channelIds);
  const pool = await getPool();
  const where: string[] = []; const args: unknown[] = [];
  if (ch.length > 0) { args.push(ch); where.push(`channel_id = ANY($${args.length}::text[])`); }
  const rows = (await pool.query(
    `SELECT id, channel_id, handle, kind, url, geo, date_bucket, status,
            (local_path IS NOT NULL) AS has_file, bytes, page_width, page_height,
            proxy_country, proxy_device, error, started_at, finished_at, updated_at
       FROM content_gen_yt_screens
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT 100`,
    args,
  )).rows;
  return NextResponse.json({
    ok: true,
    rows: rows.map(r => ({ ...r, file_url: r.has_file ? `/api/admin/content-gen/yt-capture/file?id=${r.id}` : null })),
  });
}
