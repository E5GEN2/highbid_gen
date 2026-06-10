/**
 * Execution graph append-only helpers.
 *
 * The producer calls these as it runs — script-writer events, slot
 * boundaries, every gem start/finish, cache hits, video_compose
 * milestones. The "Execution" tab in the producer admin GUI fetches
 * these rows + edges and renders a live top-to-bottom DAG.
 *
 * Each helper is idempotent via UPSERT on (job_id, node_key) — safe
 * to call multiple times for the same node as state transitions.
 *
 * node_type vocabulary:
 *   writer       — script-writer call (one per channel/niche)
 *   slot         — a script slot (groups its child gems)
 *   gem          — a (tool, args) invocation row in content_gen_producer_gems
 *   tool_call    — sub-event of a gem (HTTP request, ffmpeg invocation, etc.)
 *   cache_hit    — a gem served from content_gen_tool_cache
 *   db_save      — DB write (used for refresh-channel-stats, etc.)
 *   compose      — final video_compose step
 *
 * status vocabulary: pending | running | done | failed | cached
 * edge kind:        sequence | depends_on | output_of | compose_input
 */

import type { Pool } from 'pg';
import { getPool } from '../db';

export type NodeType =
  | 'writer'
  | 'slot'
  | 'gem'
  | 'tool_call'
  | 'cache_hit'
  | 'db_save'
  | 'compose';

export type NodeStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'cached';

export type EdgeKind =
  | 'sequence'
  | 'depends_on'
  | 'output_of'
  | 'compose_input';

export interface NodeUpsert {
  jobId: number;
  nodeKey: string;
  nodeType: NodeType;
  label: string;
  status?: NodeStatus;
  payload?: Record<string, unknown>;
}

/** Insert or update a node. status='running' stamps started_at on first
 *  transition; status='done'|'failed'|'cached' stamps finished_at. */
export async function upsertNode(n: NodeUpsert, pool?: Pool): Promise<void> {
  const p = pool ?? await getPool();
  const status = n.status ?? 'pending';
  await p.query(
    `INSERT INTO content_gen_producer_graph_nodes
       (job_id, node_key, node_type, label, status, payload,
        started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb,
             CASE WHEN $5 = 'running' THEN NOW() ELSE NULL END,
             CASE WHEN $5 IN ('done','failed','cached') THEN NOW() ELSE NULL END)
     ON CONFLICT (job_id, node_key) DO UPDATE
       SET node_type   = EXCLUDED.node_type,
           label       = EXCLUDED.label,
           status      = EXCLUDED.status,
           payload     = COALESCE(EXCLUDED.payload, content_gen_producer_graph_nodes.payload),
           started_at  = COALESCE(content_gen_producer_graph_nodes.started_at,
                                  CASE WHEN EXCLUDED.status = 'running' THEN NOW() ELSE NULL END),
           finished_at = CASE WHEN EXCLUDED.status IN ('done','failed','cached') THEN NOW()
                              ELSE content_gen_producer_graph_nodes.finished_at END,
           updated_at  = NOW()`,
    [n.jobId, n.nodeKey, n.nodeType, n.label, status, n.payload ? JSON.stringify(n.payload) : null],
  ).catch(e => {
    console.warn(`[exec-graph] upsertNode failed: ${(e as Error).message.slice(0, 200)}`);
  });
}

/** Add an edge. Idempotent on (job, from, to, kind). */
export async function addEdge(jobId: number, fromKey: string, toKey: string, kind: EdgeKind = 'sequence', pool?: Pool): Promise<void> {
  const p = pool ?? await getPool();
  await p.query(
    `INSERT INTO content_gen_producer_graph_edges (job_id, from_key, to_key, kind)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (job_id, from_key, to_key, kind) DO NOTHING`,
    [jobId, fromKey, toKey, kind],
  ).catch(e => {
    console.warn(`[exec-graph] addEdge failed: ${(e as Error).message.slice(0, 200)}`);
  });
}

// ───────────────────────────────────────────────────────────────────
// Convenience helpers — keyed by the producer's own ids so multiple
// callers can drive the same node without coordinating.
// ───────────────────────────────────────────────────────────────────

export const nodeKey = {
  writer: (jobId: number, channelId: string) => `writer:${channelId}`,
  slot:   (slotId: string) => `slot:${slotId}`,
  gem:    (slotId: string, gemId: string) => `gem:${slotId}:${gemId}`,
  cacheHit: (slotId: string, gemId: string) => `cache:${slotId}:${gemId}`,
  compose:  (jobId: number) => `compose:${jobId}`,
  toolCall: (slotId: string, gemId: string, callIdx: number) => `call:${slotId}:${gemId}:${callIdx}`,
  dbSave:   (slotId: string, gemId: string, table: string) => `db:${slotId}:${gemId}:${table}`,
};

/** Fetch the entire graph for a job. Used by the API endpoint serving
 *  the Execution tab. Returns nodes ordered by created_at ASC and edges
 *  in insertion order. */
export interface GraphSnapshot {
  nodes: Array<{
    id: number;
    node_key: string;
    node_type: NodeType;
    label: string;
    status: NodeStatus;
    payload: Record<string, unknown> | null;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  edges: Array<{
    id: number;
    from_key: string;
    to_key: string;
    kind: EdgeKind;
  }>;
}

export async function fetchGraph(jobId: number): Promise<GraphSnapshot> {
  const pool = await getPool();
  const [n, e] = await Promise.all([
    pool.query(
      `SELECT id, node_key, node_type, label, status, payload,
              started_at, finished_at, created_at, updated_at
         FROM content_gen_producer_graph_nodes
        WHERE job_id = $1
        ORDER BY id ASC`,
      [jobId],
    ),
    pool.query(
      `SELECT id, from_key, to_key, kind
         FROM content_gen_producer_graph_edges
        WHERE job_id = $1
        ORDER BY id ASC`,
      [jobId],
    ),
  ]);
  return { nodes: n.rows as GraphSnapshot['nodes'], edges: e.rows as GraphSnapshot['edges'] };
}
