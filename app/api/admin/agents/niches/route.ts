import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { listNiches, createNiche } from '@/lib/agent-niche';

/**
 * Seed-mode niche registry.
 *
 * GET  /api/admin/agents/niches
 *   List recent niches (for the deploy UI's "add seeds to existing niche"
 *   picker). Returns { niches: AgentNiche[] }.
 *
 * POST /api/admin/agents/niches
 *   Pre-create a niche without deploying (e.g. from the novelty seed
 *   candidates "Send to xgodo" flow, where we want a nicheId before
 *   choosing how many threads). Body: { label, seedUrl?, createdFrom? }.
 *   Returns { ok, nicheId }.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const niches = await listNiches(100);
  return NextResponse.json({ niches });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const label = (body.label || '').toString().trim();
  if (!label) return NextResponse.json({ error: 'label required' }, { status: 400 });
  const nicheId = await createNiche({
    label,
    seedUrl: body.seedUrl || null,
    createdFrom: body.createdFrom || 'manual',
  });
  return NextResponse.json({ ok: true, nicheId });
}
