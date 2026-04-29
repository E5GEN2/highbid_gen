import { NextRequest, NextResponse } from 'next/server';
import { refreshVizardAccounts } from '@/lib/yt-vizard-accounts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

/**
 * POST /api/admin/vizard/accounts/refresh
 *
 * Triggers a YouTube Data API pull for vizard_yt_accounts: resolves
 * channel_id for any accounts that don't have one yet, then fetches
 * subscriber/view/video counts for every account whose stats are stale
 * (>60min) or all of them when ?force=1.
 *
 * Body (optional): { emails?: string[], force?: boolean, staleMinutes?: number }
 *   - emails — restrict refresh to specific accounts
 *   - force  — ignore staleness gate, refresh everything
 *   - staleMinutes — override default 60min staleness threshold
 */
export async function POST(req: NextRequest) {
  let body: { emails?: string[]; force?: boolean; staleMinutes?: number } = {};
  try { body = await req.json(); } catch { /* allow empty body */ }

  const result = await refreshVizardAccounts({
    emails: body.emails,
    force: body.force,
    staleMinutes: body.staleMinutes,
  });

  if (result.ok === false) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ...result, ranAt: new Date().toISOString() });
}
