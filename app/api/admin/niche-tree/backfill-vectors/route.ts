import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { backfillClusterVectors } from '@/lib/niche-search';
import { getClusterVectorCount } from '@/lib/vector-db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * Admin endpoint to populate niche_tree_cluster_vectors — copies each
 * cluster's representative video's combined_v2 embedding into the
 * cluster's signature row, so the user-facing semantic-niche-search
 * has something to cosine against.
 *
 *   GET    /api/admin/niche-tree/backfill-vectors
 *     → counts: { total, byLevel: { 1: N, 2: M, ... } }
 *
 *   POST   /api/admin/niche-tree/backfill-vectors
 *     body: { mode?: 'missing' | 'all'; threads?: number }
 *     → runs synchronously and returns counters when done.
 *       'missing' (default) skips clusters already done.
 *       'all' refreshes every cluster's signature.
 */

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const counts = await getClusterVectorCount();
  return NextResponse.json(counts);
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  let body: { mode?: 'missing' | 'all'; threads?: number } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const result = await backfillClusterVectors({
    mode: body.mode ?? 'missing',
    threads: body.threads ?? 10,
  });
  return NextResponse.json({ ok: true, ...result });
}
