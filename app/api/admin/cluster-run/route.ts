import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { startClusterRun, getClusterRunStatus, abortClusterRun } from '@/lib/cluster-snapshot';

/**
 * Distributed clustering run control (Inc 1).
 *
 * GET  → latest cluster_pull run + live tile drain (null if none ever).
 * POST → { action:'start', source?, sampleTarget?, k? }  — snapshot + tiles
 *        { action:'abort' }                              — error the building run
 *
 * The run is invisible to all existing tree consumers until finalized
 * (kind='cluster_pull', status='building' — see lib/cluster-worker.ts).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const status = await getClusterRunStatus();
  return NextResponse.json({ run: status });
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  if (body.action === 'start') {
    const res = await startClusterRun({
      source: body.source,
      sampleTarget: body.sampleTarget ? parseInt(String(body.sampleTarget)) : undefined,
      shardRows: body.shardRows ? parseInt(String(body.shardRows)) : undefined,
      queryBlock: body.queryBlock ? parseInt(String(body.queryBlock)) : undefined,
      k: body.k ? parseInt(String(body.k)) : undefined,
    });
    return NextResponse.json(res, { status: res.ok ? 200 : 409 });
  }
  if (body.action === 'abort') {
    return NextResponse.json(await abortClusterRun());
  }
  return NextResponse.json({ error: "action must be 'start' or 'abort'" }, { status: 400 });
}
