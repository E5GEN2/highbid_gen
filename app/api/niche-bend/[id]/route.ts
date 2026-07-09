import { NextRequest, NextResponse } from 'next/server';
import { getBend } from '@/lib/niche-bend';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/niche-bend/{id} — the bend row + generated-thumbnail URL once ready. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const bendId = Number(id);
  if (!Number.isFinite(bendId)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  try {
    const bend = await getBend(bendId);
    if (!bend) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(bend);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
