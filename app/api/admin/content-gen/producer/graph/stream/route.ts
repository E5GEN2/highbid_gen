/**
 * GET /api/admin/content-gen/producer/graph/stream?id=<job_id>
 *
 * Server-Sent Events stream of execution-graph deltas. Replaces the
 * 1.5s polling loop in ExecutionGraph.tsx so the UI gets instant
 * updates as nodes transition state on the server.
 *
 * Frame format:
 *   event: snapshot      — full graph (first frame only)
 *     data: { job, nodes, edges }
 *   event: delta         — only nodes with updated_at > last seen
 *     data: { nodes: [...], edges_added: [...] }
 *   event: job           — job-level status / counts change
 *     data: { status, gems_done, gems_failed, gems_total, final_video_url }
 *   event: ping          — keep-alive (every 20s, no payload)
 *   event: end           — terminal, sent once job is done/failed
 *
 * Polling cadence on the server side: 500ms while the job is running,
 * pushes only what changed since the last frame. Total bandwidth is
 * generally lower than the existing 1.5s full-snapshot polling because
 * idle ticks produce nothing.
 *
 * Falls back gracefully: if the client's EventSource fails for any
 * reason (proxy strips text/event-stream, etc.), ExecutionGraph.tsx
 * keeps its polling path as the backup.
 */

import { NextRequest } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { fetchGraph } from '@/lib/content-gen/exec-graph';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300; // 5 min — covers most renders; client reconnects after that.

const POLL_MS = 500;
const PING_MS = 20_000;
const HARD_DEADLINE_MS = 280_000;  // ~< maxDuration so we end cleanly

function sse(event: string, data: unknown): string {
  // Multi-line data must be prefixed with `data: ` on every line.
  const json = JSON.stringify(data);
  return `event: ${event}\ndata: ${json}\n\n`;
}

interface JobRow {
  id: number;
  status: string;
  started_at: Date | null;
  finished_at: Date | null;
  final_video_url: string | null;
  error: string | null;
  gems_done: number | null;
  gems_failed: number | null;
  gems_total: number | null;
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) {
    return new Response('Admin token required', { status: 403 });
  }
  const idStr = new URL(req.url).searchParams.get('id');
  if (!idStr) return new Response('id required', { status: 400 });
  const jobId = parseInt(idStr, 10);
  if (!Number.isFinite(jobId)) return new Response('bad id', { status: 400 });

  const pool = await getPool();
  // Sanity-check the job exists before we open the stream.
  const exists = await pool.query<{ id: number }>(`SELECT id FROM content_gen_producer_jobs WHERE id = $1`, [jobId]);
  if (exists.rows.length === 0) return new Response(`job ${jobId} not found`, { status: 404 });

  const startedAt = Date.now();
  let lastUpdatedMs = 0;
  let lastJobStateJson = '';
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (s: string) => {
        if (cancelled) return;
        try { controller.enqueue(enc.encode(s)); } catch { cancelled = true; }
      };

      // 1. Initial snapshot.
      try {
        const [graph, jobR] = await Promise.all([
          fetchGraph(jobId),
          pool.query<JobRow>(
            `SELECT id, status, started_at, finished_at, final_video_url, error,
                    gems_done, gems_failed, gems_total
               FROM content_gen_producer_jobs WHERE id = $1`,
            [jobId],
          ),
        ]);
        const job = jobR.rows[0];
        send(sse('snapshot', { job, nodes: graph.nodes, edges: graph.edges, server_time: new Date().toISOString() }));
        if (graph.nodes.length > 0) {
          lastUpdatedMs = Math.max(...graph.nodes.map(n => new Date(n.updated_at).getTime()));
        }
        lastJobStateJson = JSON.stringify({
          status: job.status, gems_done: job.gems_done, gems_failed: job.gems_failed,
          final_video_url: job.final_video_url, error: job.error,
        });

        // Done already? Send `end` and stop.
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
          send(sse('end', { reason: 'terminal-on-snapshot', status: job.status }));
          controller.close();
          return;
        }
      } catch (e) {
        send(sse('end', { reason: 'snapshot-failed', error: (e as Error).message.slice(0, 200) }));
        controller.close();
        return;
      }

      // 2. Poll loop — emit deltas + pings until the job finishes
      //    or we approach maxDuration.
      let lastPingAt = Date.now();
      const tick = async (): Promise<void> => {
        if (cancelled) return;
        if (Date.now() - startedAt > HARD_DEADLINE_MS) {
          send(sse('end', { reason: 'hard-deadline-client-should-reconnect' }));
          controller.close();
          return;
        }

        try {
          // Delta query — only nodes that moved since last frame.
          const nodes = await pool.query(
            `SELECT id, node_key, node_type, label, status, payload,
                    started_at, finished_at, created_at, updated_at
               FROM content_gen_producer_graph_nodes
              WHERE job_id = $1 AND updated_at > to_timestamp($2 / 1000.0)
              ORDER BY id ASC`,
            [jobId, lastUpdatedMs],
          );
          // Edges: hard to delta cleanly (no updated_at) — fetch all,
          // client dedupes by id. Cheap (one int + 3 short strings per row).
          const edges = await pool.query(
            `SELECT id, from_key, to_key, kind
               FROM content_gen_producer_graph_edges
              WHERE job_id = $1
              ORDER BY id ASC`,
            [jobId],
          );

          if (nodes.rows.length > 0) {
            send(sse('delta', { nodes: nodes.rows, edges: edges.rows }));
            lastUpdatedMs = Math.max(
              lastUpdatedMs,
              ...nodes.rows.map(r => new Date(r.updated_at as Date).getTime()),
            );
          }

          // Job-level changes
          const jr = await pool.query<JobRow>(
            `SELECT id, status, started_at, finished_at, final_video_url, error,
                    gems_done, gems_failed, gems_total
               FROM content_gen_producer_jobs WHERE id = $1`,
            [jobId],
          );
          const job = jr.rows[0];
          const jobStateJson = JSON.stringify({
            status: job.status, gems_done: job.gems_done, gems_failed: job.gems_failed,
            final_video_url: job.final_video_url, error: job.error,
          });
          if (jobStateJson !== lastJobStateJson) {
            send(sse('job', { job }));
            lastJobStateJson = jobStateJson;
          }

          if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
            send(sse('end', { reason: 'terminal', status: job.status }));
            controller.close();
            return;
          }

          // Keep-alive ping if nothing else got sent recently
          if (Date.now() - lastPingAt > PING_MS) {
            send(sse('ping', { t: new Date().toISOString() }));
            lastPingAt = Date.now();
          }
        } catch (e) {
          // Log and continue — a single failed poll shouldn't kill the stream.
          console.warn(`[graph/stream:${jobId}] poll failed: ${(e as Error).message.slice(0, 200)}`);
        }

        setTimeout(tick, POLL_MS);
      };
      setTimeout(tick, POLL_MS);
    },

    cancel() { cancelled = true; },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',  // disable nginx buffering if proxied
    },
  });
}
