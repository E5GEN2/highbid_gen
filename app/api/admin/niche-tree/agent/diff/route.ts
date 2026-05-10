import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/niche-tree/agent/diff?runId=X
 *
 * Returns the lifecycle diff for a clustering run — what was born, what
 * died, what grew/shrank, what split/merged, computed from the stitcher's
 * niche_cluster_events output. Each event row gets enriched with the
 * cluster's auto_label/label so you can see "what" not just "stable_id".
 *
 * Defaults to the most recent global L1 run if runId omitted.
 *
 * Response shape:
 *   {
 *     runId, prevRunId, totals: { born, died, same, grew, shrank, split, merged },
 *     events: [{
 *       event, stable_id, parent_stable_id, size_before, size_after,
 *       jaccard, label, auto_label, video_count, payload
 *     }]
 *   }
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();

  let runId: number | null = null;
  const param = req.nextUrl.searchParams.get('runId');
  if (param) runId = parseInt(param);
  if (!runId) {
    const r = await pool.query<{ id: number }>(
      `SELECT id FROM niche_tree_runs WHERE kind='global' AND level=1 ORDER BY started_at DESC LIMIT 1`,
    );
    runId = r.rows[0]?.id ?? null;
  }
  if (!runId) return NextResponse.json({ error: 'No global L1 run found' }, { status: 404 });

  // Fetch events for this run, joined to the cluster row that owns the
  // stable_id. For BORN/SAME/GREW/SHRANK/SPLIT/MERGED, the cluster lives
  // in the current run. For DIED, the cluster lives in some PRIOR run
  // (the predecessor whose identity vanished). DISTINCT ON (stable_id,
  // most-recent run) picks the right row regardless of event type so the
  // labels are always populated.
  const eventsRes = await pool.query<{
    event: string;
    stable_id: string;
    parent_stable_id: string | null;
    size_before: number | null;
    size_after: number | null;
    jaccard: number | null;
    payload: Record<string, unknown> | null;
    label: string | null;
    auto_label: string | null;
    video_count: number | null;
    cluster_id: number | null;
  }>(
    `WITH latest_cluster_per_stable AS (
       SELECT DISTINCT ON (stable_id) stable_id, id, label, auto_label, video_count
         FROM niche_tree_clusters
        WHERE stable_id IS NOT NULL
        ORDER BY stable_id, run_id DESC
     )
     SELECT e.event, e.stable_id, e.parent_stable_id, e.size_before, e.size_after,
            e.jaccard, e.payload,
            c.label, c.auto_label, c.video_count, c.id AS cluster_id
       FROM niche_cluster_events e
       LEFT JOIN latest_cluster_per_stable c ON c.stable_id = e.stable_id
      WHERE e.run_id = $1
      ORDER BY
        CASE e.event
          WHEN 'born'   THEN 1
          WHEN 'split'  THEN 2
          WHEN 'merged' THEN 3
          WHEN 'grew'   THEN 4
          WHEN 'shrank' THEN 5
          WHEN 'same'   THEN 6
          WHEN 'died'   THEN 7
          ELSE 8
        END,
        ABS(COALESCE(e.size_after, 0) - COALESCE(e.size_before, 0)) DESC`,
    [runId],
  );

  // Find prev run id from the first event's payload (all events share it)
  const firstPrev = eventsRes.rows[0]?.payload?.prev_run_id;
  const prevRunId = typeof firstPrev === 'number' ? firstPrev : null;

  const totals = { born: 0, died: 0, same: 0, grew: 0, shrank: 0, split: 0, merged: 0 };
  for (const row of eventsRes.rows) {
    if (row.event in totals) totals[row.event as keyof typeof totals]++;
  }

  return NextResponse.json({
    runId,
    prevRunId,
    totals,
    eventCount: eventsRes.rows.length,
    events: eventsRes.rows.map(r => ({
      event: r.event,
      stable_id: r.stable_id,
      parent_stable_id: r.parent_stable_id,
      size_before: r.size_before,
      size_after: r.size_after,
      delta: r.size_before != null && r.size_after != null ? r.size_after - r.size_before : null,
      jaccard: r.jaccard,
      label: r.label,
      auto_label: r.auto_label,
      video_count: r.video_count,
      cluster_id: r.cluster_id,
      payload: r.payload,
    })),
  });
}
