import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { fetchRunpodLogs } from '@/lib/vector-db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/tools/runpod-logs?job_id=X&since=0&limit=5000
 *
 * Surfaces every line the container streamed into runpod_job_logs for
 * a given RunPod job id. Used to reconstruct progress for runs whose
 * Node-side dispatcher timed out (the container kept running but the
 * Node poll loop exited), and as a general forensics window into any
 * GPU job — cheap SELECT on an indexed (job_id, id) pair.
 *
 * Also computes a quick summary of [bake] / [cluster] markers so the
 * operator gets a one-glance "how deep are we" without scrolling.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const jobId = sp.get('job_id') || sp.get('jobId') || '';
  if (!jobId) return NextResponse.json({ error: 'job_id query param required' }, { status: 400 });

  const since = parseInt(sp.get('since') || '0', 10) || 0;
  const limit = Math.min(parseInt(sp.get('limit') || '5000', 10) || 5000, 20000);

  const rows = await fetchRunpodLogs(jobId, since, limit);

  // Bake-progress summary: count L2 starts / completions, last seen
  // marker, L1 HDBSCAN result, total L1 cluster count if we already
  // know it. Cheap regex pass; lets the operator answer "how deep is
  // it?" at a glance without scrolling 4k lines.
  let l1Clusters: number | null = null;
  let l1Noise: number | null = null;
  let l2Started = 0;
  let l2Done = 0;
  let l2Failed = 0;
  let lastL2Idx: number | null = null;
  let lastBakeLine: string | null = null;
  let bakeDoneLine: string | null = null;
  for (const r of rows) {
    const line = r.line;
    // L1 HDBSCAN result — first one is the global L1 (others are per-L2)
    if (l1Clusters == null) {
      const m = /^\[bake\] L1 done in [\d.]+s: (\d+) clusters, (\d+) noise/.exec(line);
      if (m) { l1Clusters = parseInt(m[1]); l1Noise = parseInt(m[2]); }
    }
    // L2 markers
    const start = /^\[bake\] L2 cluster (\d+) \((\d+) vids\) starting/.exec(line);
    if (start) {
      l2Started++;
      lastL2Idx = parseInt(start[1]);
      lastBakeLine = line;
    }
    if (/^\[bake\] L2 cluster (\d+) done in /.test(line)) l2Done++;
    if (/^\[bake\] L2 cluster (\d+) FAILED/.test(line)) l2Failed++;
    if (line.startsWith('[bake] done in')) bakeDoneLine = line;
  }

  return NextResponse.json({
    job_id: jobId,
    since,
    returned: rows.length,
    lastId: rows.length > 0 ? rows[rows.length - 1].id : since,
    summary: {
      l1_clusters: l1Clusters,
      l1_noise:    l1Noise,
      l2_started:  l2Started,
      l2_done:     l2Done,
      l2_failed:   l2Failed,
      l2_inflight: Math.max(0, l2Started - l2Done - l2Failed),
      l2_remaining_estimate: (l1Clusters != null) ? Math.max(0, l1Clusters - l2Started) : null,
      last_l2_index: lastL2Idx,
      last_bake_line: lastBakeLine,
      bake_done_line: bakeDoneLine,
    },
    // Tail of the most recent lines for context. Full set is in `rows`.
    tail: rows.slice(-40).map(r => r.line),
    rows: sp.get('full') === '1' ? rows : undefined,
  });
}
