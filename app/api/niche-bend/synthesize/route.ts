import { NextRequest, NextResponse } from 'next/server';
import { synthesizeBend } from '@/lib/niche-bend';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get('admin_token')?.value;
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    return decoded.startsWith('admin:') && decoded.endsWith(':rofe_admin_secret');
  } catch { return false; }
}

/**
 * POST /api/niche-bend/synthesize  { videoAId, videoBId }
 * Validates distinct L1 niches, synthesizes a fused idea (title + thumbnail),
 * kicks off the thumbnail render, returns { id }. Poll GET /api/niche-bend/{id}.
 */
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: { videoAId?: number; videoBId?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const a = Number(body.videoAId), b = Number(body.videoBId);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return NextResponse.json({ error: 'videoAId and videoBId required' }, { status: 400 });
  }
  try {
    const res = await synthesizeBend(a, b);
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json({ id: res.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
