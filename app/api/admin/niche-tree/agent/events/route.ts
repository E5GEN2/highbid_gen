import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/niche-tree/agent/events
 *
 * Query the cluster lifecycle event log. Filters:
 *   - event:     comma-separated list of event types (born,died,split,merged,grew,shrank,same)
 *   - stable_id: only events for this cluster identity
 *   - since:     ISO timestamp; only events detected_at >= since
 *   - limit:     default 100, max 1000
 *
 * Returns chronological-descending by detected_at. Used for the lifecycle
 * timeline UI, alerting on births of high-velocity clusters, and digging
 * into the history of a specific niche over time.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const params = req.nextUrl.searchParams;

  const eventFilter = params.get('event');
  const stableFilter = params.get('stable_id');
  const since = params.get('since');
  const limit = Math.min(parseInt(params.get('limit') || '100') || 100, 1000);

  const conds: string[] = [];
  const args: (string | number | string[])[] = [];
  let i = 1;
  if (eventFilter) {
    const parts = eventFilter.split(',').map(s => s.trim()).filter(Boolean);
    conds.push(`e.event = ANY($${i++})`);
    args.push(parts);
  }
  if (stableFilter) {
    conds.push(`e.stable_id = $${i++}`);
    args.push(stableFilter);
  }
  if (since) {
    conds.push(`e.detected_at >= $${i++}`);
    args.push(since);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  args.push(limit);

  const res = await pool.query<{
    id: string;
    run_id: number;
    stable_id: string;
    parent_stable_id: string | null;
    event: string;
    level: number;
    size_before: number | null;
    size_after: number | null;
    jaccard: number | null;
    payload: Record<string, unknown> | null;
    detected_at: Date;
    label: string | null;
    auto_label: string | null;
  }>(
    `WITH latest_cluster_per_stable AS (
       SELECT DISTINCT ON (stable_id) stable_id, id, label, auto_label
         FROM niche_tree_clusters
        WHERE stable_id IS NOT NULL
        ORDER BY stable_id, run_id DESC
     )
     SELECT e.id, e.run_id, e.stable_id, e.parent_stable_id, e.event, e.level,
            e.size_before, e.size_after, e.jaccard, e.payload, e.detected_at,
            c.label, c.auto_label
       FROM niche_cluster_events e
       LEFT JOIN latest_cluster_per_stable c ON c.stable_id = e.stable_id
       ${where}
       ORDER BY e.detected_at DESC
       LIMIT $${i}`,
    args,
  );

  return NextResponse.json({
    count: res.rows.length,
    events: res.rows.map(r => ({
      id: r.id,
      run_id: r.run_id,
      stable_id: r.stable_id,
      parent_stable_id: r.parent_stable_id,
      event: r.event,
      level: r.level,
      size_before: r.size_before,
      size_after: r.size_after,
      delta: r.size_before != null && r.size_after != null ? r.size_after - r.size_before : null,
      jaccard: r.jaccard,
      label: r.label,
      auto_label: r.auto_label,
      payload: r.payload,
      detected_at: r.detected_at?.toISOString?.() ?? null,
    })),
  });
}
