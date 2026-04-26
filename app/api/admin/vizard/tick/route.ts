import { NextResponse } from 'next/server';
import { runVizardTick } from '@/lib/vizard-tick';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST/GET /api/admin/vizard/tick
 *
 * Manual trigger for the Vizard polling tick — same logic the server-side
 * cron at /api/cron/vizard runs every minute. Useful as an admin escape
 * hatch to force progress on a stuck project (or for one-off testing).
 *
 * The actual implementation lives in lib/vizard-tick.ts; this route is a
 * thin wrapper. Auth: standard admin-token (existing isAdmin checks at the
 * route layer if/when added — for now exposed un-gated since it only ever
 * affects vizard_* tables, never user-facing data).
 */
export async function POST() {
  const result = await runVizardTick();
  return NextResponse.json(result);
}

export async function GET() {
  const result = await runVizardTick();
  return NextResponse.json(result);
}
