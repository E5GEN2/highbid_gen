import { NextRequest, NextResponse } from 'next/server';
import { listBends } from '@/lib/niche-bend';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/niche-bend/list?limit=60 — the feed of pre-baked bends (ready first). */
export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get('limit')) || 60;
  const before = Number(req.nextUrl.searchParams.get('before')) || undefined;
  try {
    const bends = await listBends(limit, before);
    return NextResponse.json({ bends, count: bends.length, hasMore: bends.length === limit });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
