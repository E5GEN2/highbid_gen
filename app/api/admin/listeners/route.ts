import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { createListener, getListenerStats, refreshListenerMembers } from '@/lib/listener';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET  /api/admin/listeners            → all listeners + KPI (avg new videos/channel)
 * POST /api/admin/listeners            → create from a semantic niche query
 *        { name, query, maxClusters?, minSimilarity?, level? }
 *        e.g. { "name": "Faceless YT", "query": "faceless youtube" }
 * PATCH /api/admin/listeners           → { id, refresh: true } re-enrol members
 *        (do this after a re-cluster; membership is materialised on purpose so a
 *         rebuild never silently changes who a listener listens to)
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const id = req.nextUrl.searchParams.get('id');
  try {
    return NextResponse.json({ ok: true, listeners: await getListenerStats(id ? parseInt(id) : undefined) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  if (!body.query || !body.name) {
    return NextResponse.json({ ok: false, error: 'name and query are required' }, { status: 400 });
  }
  try {
    const r = await createListener({
      name: String(body.name),
      query: String(body.query),
      maxClusters: body.maxClusters ? parseInt(body.maxClusters) : undefined,
      minSimilarity: body.minSimilarity != null ? parseFloat(body.minSimilarity) : undefined,
      level: body.level != null ? parseInt(body.level) : undefined,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    const channels = await refreshListenerMembers(parseInt(body.id));
    return NextResponse.json({ ok: true, channels });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
