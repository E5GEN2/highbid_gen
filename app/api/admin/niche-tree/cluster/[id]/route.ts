import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getClusterChildren } from '@/lib/niche-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/niche-tree/cluster/:id
 *
 * Returns the cluster's children (sub-niches) joined with rep-video
 * data + L3 grandchild counts, plus the ancestor chain for breadcrumb
 * rendering and the latest subdivide run (so the UI can show live
 * progress while a re-subdivide is in flight).
 *
 * Same admin-only gating as the rest of /api/admin/niche-tree/*.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const { id } = await ctx.params;
  const parentClusterId = parseInt(id);
  if (Number.isNaN(parentClusterId)) {
    return NextResponse.json({ error: 'invalid cluster id' }, { status: 400 });
  }

  const result = await getClusterChildren(parentClusterId);
  if (!result.parent) {
    return NextResponse.json({ error: 'cluster not found' }, { status: 404 });
  }
  return NextResponse.json(result);
}
