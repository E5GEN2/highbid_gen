import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { findRespyCandidates } from '@/lib/content-gen/respy-candidates';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/content-gen/respy-candidates?limit=20
 *
 * Preview which KNOWN niches the re-spy mode would revisit next, and why.
 * Read-only — dispatches nothing. Exists so the scorer can be validated against
 * real data before it is allowed to spend fleet time.
 *
 * Each row shows the score decomposition:
 *   expected_yield          mean new channels per past crawl of that cluster
 *                           (re-projected onto the CURRENT tree, so it survives
 *                           the ~weekly cluster rebuilds)
 *   hours_since_last_crawl  drives the recency factor (penalty only under 24h)
 *   prior_crawls            how much evidence the estimate rests on
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const limit = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('limit') || '20'), 1), 100);
  try {
    const candidates = await findRespyCandidates(limit);
    return NextResponse.json({
      ok: true,
      count: candidates.length,
      note: 'preview only — no dispatch. score = expected_yield x recency_factor + staleness',
      candidates,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
