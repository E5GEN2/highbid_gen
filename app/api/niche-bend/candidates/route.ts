import { NextRequest, NextResponse } from 'next/server';
import { getBendCandidates } from '@/lib/niche-bend';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/niche-bend/candidates
 *   minOutlier, minViews, postedWithin (days), type=long|short, limit
 * Returns proven-outlier videos that each carry an active-tree L1 niche, so
 * every card can participate in a distinct-niche bend.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const numOrNull = (s: string | null): number | null => {
    if (s == null || s.trim() === '') return null;
    const n = Number(s); return Number.isFinite(n) ? n : null;
  };
  try {
    const candidates = await getBendCandidates({
      limit: numOrNull(sp.get('limit')) ?? 120,
      minOutlier: numOrNull(sp.get('minOutlier')) ?? 5,
      minViews: numOrNull(sp.get('minViews')),
      postedWithinDays: sp.get('postedWithin') === null ? 240 : numOrNull(sp.get('postedWithin')),
      type: (sp.get('type') as 'long' | 'short' | null) ?? '',
    });
    return NextResponse.json({ candidates, total: candidates.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
