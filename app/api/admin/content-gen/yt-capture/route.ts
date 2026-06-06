import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { captureBatch, captureYtScreen, type ScreenKind, type CaptureMode, type AnnotateSpec, type AnnotateElement, type HighlightStyle, type AnnotateKind, type CompositeShapeStyle } from '@/lib/content-gen/yt-capture';

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
    kind?: ScreenKind; mode?: CaptureMode; geo?: string; force?: boolean; concurrency?: number;
    watchVideoId?: string | null;
    annotate_element?: AnnotateElement;
    annotate_kind?: AnnotateKind;
    annotate_style?: HighlightStyle;       // when kind='css'
    annotate_shape?: CompositeShapeStyle;  // when kind='composite'
    annotate_label?: string;
    annotate_arrow_from?: 'top' | 'bottom' | 'left' | 'right' | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
    annotate_color?: string;
  };
  const videoIds = (body.videoIds ?? []).map(Number).filter(n => Number.isFinite(n));
  const channelIds = (body.channelIds ?? []).map(String).filter(Boolean);
  const ch = await resolveChannels(videoIds, channelIds);
  if (ch.length === 0) return NextResponse.json({ error: 'videoIds or channelIds required' }, { status: 400 });

  // Annotation is only meaningful for single captures — we still pass it
  // through for batches, but consumers usually capture one + annotate at a
  // time. Composite needs an element only (shape defaults to sharpie_circle);
  // CSS needs element + style (legacy contract).
  const annKind: AnnotateKind = body.annotate_kind ?? (body.annotate_style ? 'css' : 'css');
  const annotate: AnnotateSpec | undefined = body.annotate_element
    ? {
        element: body.annotate_element,
        kind: annKind,
        style: body.annotate_style,
        shape: body.annotate_shape,
        label: body.annotate_label,
        arrow_from: body.annotate_arrow_from,
        color: body.annotate_color,
      }
    : undefined;

  const t0 = Date.now();
  const result = await captureBatch(ch, {
    kind: body.kind ?? 'channel_page',
    mode: body.mode,
    geo: body.geo,
    force: body.force,
    concurrency: body.concurrency,
    watchVideoId: body.watchVideoId,
    annotate,
  });
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

  // Debug single-capture path: GET /yt-capture?channelId=...&kind=...&mode=...&watchVideoId=...&force=1
  //   Optional CSS annotation: &annotate_element=subscriber_count&annotate_style=yellow_ring
  //   Optional composite annotation: &annotate_element=total_views&annotate_kind=composite&annotate_shape=sharpie_circle&annotate_label=...&annotate_arrow_from=top_right
  const singleChannel = sp.get('channelId');
  if (singleChannel) {
    const kind = (sp.get('kind') as ScreenKind) ?? 'channel_page';
    const modeParam = sp.get('mode');
    const mode = modeParam === 'scroll_record' || modeParam === 'static' ? modeParam as CaptureMode : undefined;
    const watchVideoId = sp.get('watchVideoId') || undefined;
    const force = sp.get('force') === '1';
    const annEl = sp.get('annotate_element') as AnnotateElement | null;
    const annStyle = sp.get('annotate_style') as HighlightStyle | null;
    const annKind = (sp.get('annotate_kind') as 'css' | 'composite' | null) || (annStyle ? 'css' : null);
    const annShape = sp.get('annotate_shape') as ('sharpie_circle' | 'arrow' | 'circle_with_label' | 'glow_ring' | 'underline') | null;
    const annLabel = sp.get('annotate_label') || undefined;
    const annArrowFrom = sp.get('annotate_arrow_from') as ('top' | 'bottom' | 'left' | 'right' | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right') | null;
    const annColor = sp.get('annotate_color') || undefined;
    const annotate = annEl ? ({
      element: annEl,
      kind: annKind || 'css',
      style: annStyle || undefined,
      shape: annShape || undefined,
      label: annLabel,
      arrow_from: annArrowFrom || undefined,
      color: annColor,
    } as AnnotateSpec) : undefined;
    const t0 = Date.now();
    try {
      const r = await captureYtScreen(singleChannel, { kind, mode, watchVideoId, force, annotate });
      return NextResponse.json({ ok: true, elapsed_ms: Date.now() - t0, result: { ...r, file_url: `/api/admin/content-gen/yt-capture/file?id=${r.id}` } });
    } catch (e) { return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 }); }
  }

  // List mode: returns recent captures + status counts. The GUI uses both.
  const channelIds = (sp.get('channelIds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const videoIds = (sp.get('videoIds') ?? '').split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));
  const kindFilter = sp.get('kind');
  const statusFilter = sp.get('status');
  const limit = Math.max(1, Math.min(500, parseInt(sp.get('limit') ?? '120')));
  const ch = await resolveChannels(videoIds, channelIds);
  const pool = await getPool();

  const where: string[] = []; const args: unknown[] = [];
  if (ch.length > 0) { args.push(ch); where.push(`channel_id = ANY($${args.length}::text[])`); }
  if (kindFilter) { args.push(kindFilter); where.push(`kind = $${args.length}`); }
  if (statusFilter) { args.push(statusFilter); where.push(`status = $${args.length}`); }
  args.push(limit);

  // Status + kind counts (across all rows, not filtered — gives the GUI a
  // health view of the whole library).
  const counts = (await pool.query<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM content_gen_yt_screens GROUP BY status`,
  )).rows.reduce((a, r) => { a[r.status] = r.n; return a; }, {} as Record<string, number>);
  const kindCounts = (await pool.query<{ kind: string; n: number }>(
    `SELECT kind, COUNT(*)::int AS n FROM content_gen_yt_screens GROUP BY kind`,
  )).rows.reduce((a, r) => { a[r.kind] = r.n; return a; }, {} as Record<string, number>);

  const rows = (await pool.query(
    `SELECT id, channel_id, handle, kind, url, geo, date_bucket, status,
            (local_path IS NOT NULL) AS has_file, bytes, page_width, page_height,
            proxy_country, proxy_device, error, started_at, finished_at, updated_at,
            COALESCE(asset_kind,'image') AS asset_kind,
            COALESCE(capture_mode,'static') AS capture_mode,
            duration_s, bboxes_jsonb
       FROM content_gen_yt_screens
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT $${args.length}`,
    args,
  )).rows;

  // Resolve channel names for display.
  const cids = Array.from(new Set(rows.map(r => r.channel_id).filter(Boolean)));
  let nameByCid = new Map<string, string>();
  if (cids.length > 0) {
    const r = await pool.query<{ channel_id: string; channel_name: string | null; subscriber_count: number | null }>(
      `SELECT channel_id, channel_name, subscriber_count FROM niche_spy_channels WHERE channel_id = ANY($1::text[])`, [cids],
    );
    nameByCid = new Map(r.rows.map(x => [x.channel_id, x.channel_name ?? x.channel_id]));
  }

  return NextResponse.json({
    ok: true,
    counts, kindCounts,
    rows: rows.map(r => ({
      ...r,
      channel_name: nameByCid.get(r.channel_id) ?? null,
      file_url: r.has_file ? `/api/admin/content-gen/yt-capture/file?id=${r.id}` : null,
    })),
  });
}
