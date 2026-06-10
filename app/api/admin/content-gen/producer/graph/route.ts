/**
 * GET /api/admin/content-gen/producer/graph?id=<job_id>[&since=<iso>]
 *
 * Returns the execution graph for a single render job. Used by the
 * "Execution" tab in the producer admin GUI to render the live DAG.
 *
 * Response shape:
 *   {
 *     job:   { id, status, started_at, finished_at, final_video_url },
 *     nodes: [{ id, node_key, node_type, label, status, payload,
 *               started_at, finished_at, created_at, updated_at }, ...],
 *     edges: [{ id, from_key, to_key, kind }, ...],
 *     server_time: ISO  // for client clock skew
 *   }
 *
 * `since` (optional): if provided, only nodes with updated_at > since are
 * returned. Edges are always returned in full (cheap; one int4 + two
 * strings + kind per row, max a few hundred per job).
 *
 * Polling: GUI polls this every 1-2s while a render is running. SSE/
 * websocket upgrade is a follow-up.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { fetchGraph } from '@/lib/content-gen/exec-graph';

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const url = new URL(req.url);
  const jobIdStr = url.searchParams.get('id');
  const since = url.searchParams.get('since');
  if (!jobIdStr) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const jobId = parseInt(jobIdStr, 10);
  if (!Number.isFinite(jobId)) return NextResponse.json({ error: 'id must be a number' }, { status: 400 });

  const pool = await getPool();
  const jobRow = await pool.query<{
    id: number; status: string; started_at: Date | null; finished_at: Date | null;
    final_video_url: string | null; error: string | null;
    gems_done: number | null; gems_failed: number | null; gems_total: number | null;
  }>(
    `SELECT id, status, started_at, finished_at, final_video_url, error,
            gems_done, gems_failed, gems_total
       FROM content_gen_producer_jobs WHERE id = $1`,
    [jobId],
  );
  if (jobRow.rows.length === 0) {
    return NextResponse.json({ error: `job ${jobId} not found` }, { status: 404 });
  }
  const job = jobRow.rows[0];

  let graph = await fetchGraph(jobId);

  // Optional delta — client polls with since=<last updated_at>, server
  // trims nodes to only those that moved.
  if (since) {
    const sinceMs = Date.parse(since);
    if (Number.isFinite(sinceMs)) {
      graph = {
        ...graph,
        nodes: graph.nodes.filter(n => new Date(n.updated_at).getTime() > sinceMs),
      };
    }
  }

  return NextResponse.json({
    job: {
      id: job.id,
      status: job.status,
      started_at: job.started_at,
      finished_at: job.finished_at,
      final_video_url: job.final_video_url,
      error: job.error,
      gems_done: job.gems_done,
      gems_failed: job.gems_failed,
      gems_total: job.gems_total,
    },
    nodes: graph.nodes,
    edges: graph.edges,
    server_time: new Date().toISOString(),
  });
}
