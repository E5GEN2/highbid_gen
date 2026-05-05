import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getClusterVideos, type ClusterVideoSort } from '@/lib/niche-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SORTS: readonly ClusterVideoSort[] = ['centroid', 'score', 'views', 'date', 'oldest', 'likes'];

/**
 * GET /api/admin/niche-tree/cluster/:id/videos?sort=centroid&limit=60&offset=0
 *
 * Paginated video grid for a single niche-tree cluster. Joins
 * niche_tree_assignments → niche_spy_videos and returns one card row
 * per video plus the same parent + ancestor metadata used elsewhere
 * so the admin tree drill-down can render a breadcrumb header.
 *
 * Sort defaults to `centroid` (closest to cluster centroid first) since
 * that's what the 4-thumb representative strip uses — opening videos on
 * a cluster shows the same logic, just paginated.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const { id } = await ctx.params;
  const clusterId = parseInt(id);
  if (Number.isNaN(clusterId)) {
    return NextResponse.json({ error: 'invalid cluster id' }, { status: 400 });
  }

  const sortParam = req.nextUrl.searchParams.get('sort') as ClusterVideoSort | null;
  const sort = sortParam && SORTS.includes(sortParam) ? sortParam : 'centroid';
  const limit  = parseInt(req.nextUrl.searchParams.get('limit')  || '60');
  const offset = parseInt(req.nextUrl.searchParams.get('offset') || '0');

  const result = await getClusterVideos({ clusterId, sort, limit, offset });
  if (!result.parent) {
    return NextResponse.json({ error: 'cluster not found' }, { status: 404 });
  }
  return NextResponse.json(result);
}
