'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Live execution-graph panel for the Producer tab.
 *
 * Polls /api/admin/content-gen/producer/graph?id=<job_id> every 1.5s
 * while the job is running. Renders the DAG as slot rows top-to-bottom
 * with gem cards arranged horizontally inside each slot, and a final
 * compose node at the bottom. SVG edges connect the lifecycle —
 * sequential between consecutive slots, slot→gem within a row,
 * slot→compose at the end.
 *
 * Custom layout (no React Flow dep). Each node ~180×60. Rows wrap at
 * the container width. Status pills color-code lifecycle states.
 */

type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'cached';

interface GraphNode {
  id: number;
  node_key: string;
  node_type: 'writer' | 'slot' | 'gem' | 'tool_call' | 'cache_hit' | 'db_save' | 'compose';
  label: string;
  status: NodeStatus;
  payload: Record<string, unknown> | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface GraphEdge {
  id: number;
  from_key: string;
  to_key: string;
  kind: 'sequence' | 'depends_on' | 'output_of' | 'compose_input';
}

interface GraphResponse {
  job: {
    id: number;
    status: string;
    started_at: string | null;
    finished_at: string | null;
    final_video_url: string | null;
    error: string | null;
    gems_done: number | null;
    gems_failed: number | null;
    gems_total: number | null;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  server_time: string;
}

const STATUS_RING: Record<NodeStatus, string> = {
  pending:  'ring-1 ring-[#3a3a3a] bg-[#1a1a1a] text-[#888]',
  running:  'ring-2 ring-blue-500 bg-blue-500/10 text-blue-100 animate-pulse',
  done:     'ring-1 ring-green-600 bg-green-600/10 text-green-200',
  failed:   'ring-2 ring-red-500 bg-red-500/15 text-red-200',
  cached:   'ring-1 ring-purple-500 bg-purple-500/10 text-purple-200',
};

const NODE_TYPE_BADGE: Record<GraphNode['node_type'], string> = {
  writer:    '✍️',
  slot:      '🎬',
  gem:       '💎',
  tool_call: '🔧',
  cache_hit: '⚡',
  db_save:   '💾',
  compose:   '🎞️',
};

interface Props {
  jobId: number | null;
  onClose: () => void;
}

export default function ExecutionGraph({ jobId, onClose }: Props) {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchGraph = useCallback(async () => {
    if (jobId == null) return;
    try {
      const r = await fetch(`/api/admin/content-gen/producer/graph?id=${jobId}`, { credentials: 'include' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j?.error ?? `HTTP ${r.status}`);
        return;
      }
      const data: GraphResponse = await r.json();
      setGraph(data);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [jobId]);

  // Polling lifecycle: 1.5s while job is running, stop when done/failed.
  useEffect(() => {
    if (jobId == null) return;
    void fetchGraph();
    const tick = () => {
      void fetchGraph();
      const running = graph?.job.status === 'running' || graph?.job.status === 'pending';
      if (running !== false) {
        pollRef.current = setTimeout(tick, 1500);
      }
    };
    pollRef.current = setTimeout(tick, 1500);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, fetchGraph]);

  // Restart polling when status changes (in case it went from running→done).
  useEffect(() => {
    if (!graph) return;
    const running = graph.job.status === 'running' || graph.job.status === 'pending';
    if (!running && pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, [graph]);

  if (jobId == null) return null;

  // Bucket nodes by type and lay them out.
  const slotNodes = (graph?.nodes ?? []).filter(n => n.node_type === 'slot');
  const gemNodes  = (graph?.nodes ?? []).filter(n => n.node_type === 'gem');
  const composeNodes = (graph?.nodes ?? []).filter(n => n.node_type === 'compose');
  const writerNodes  = (graph?.nodes ?? []).filter(n => n.node_type === 'writer');

  // Group gems by slot key via the `depends_on` edges (slot → gem). Falls
  // back to gem.node_key prefix when no edge is recorded yet.
  const slotKeyToGems: Record<string, GraphNode[]> = {};
  for (const slot of slotNodes) slotKeyToGems[slot.node_key] = [];
  const edges = graph?.edges ?? [];
  const slotKeySet = new Set(slotNodes.map(s => s.node_key));
  for (const gem of gemNodes) {
    let placed = false;
    for (const e of edges) {
      if (e.kind === 'depends_on' && e.to_key === gem.node_key && slotKeySet.has(e.from_key)) {
        slotKeyToGems[e.from_key].push(gem);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Fallback: gem key is "gem:<slot_id>:<gem_id>" — derive slot key.
      const parts = gem.node_key.split(':');
      if (parts[0] === 'gem' && parts.length >= 3) {
        const slotKey = `slot:${parts.slice(1, -1).join(':')}`;
        if (slotKeyToGems[slotKey]) slotKeyToGems[slotKey].push(gem);
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/85 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#222] bg-[#0a0a0a]">
        <div className="flex items-center gap-3 text-sm">
          <button
            onClick={onClose}
            className="px-3 py-1 bg-[#1a1a1a] hover:bg-[#222] text-[#ddd] rounded border border-[#333]"
          >
            ← back
          </button>
          <span className="text-[#aaa]">Execution graph</span>
          <span className="text-[#666]">·</span>
          <span className="text-[#ddd]">job #{jobId}</span>
          {graph && (
            <>
              <span className="text-[#666]">·</span>
              <span className={
                graph.job.status === 'running' ? 'text-blue-300' :
                graph.job.status === 'done'    ? 'text-green-300' :
                graph.job.status === 'failed'  ? 'text-red-300' :
                'text-[#888]'
              }>
                {graph.job.status}
              </span>
              {graph.job.gems_total != null && (
                <>
                  <span className="text-[#666]">·</span>
                  <span className="text-[#aaa]">
                    {graph.job.gems_done ?? 0} / {graph.job.gems_total}
                    {graph.job.gems_failed != null && graph.job.gems_failed > 0 && (
                      <span className="text-red-400 ml-1">({graph.job.gems_failed} failed)</span>
                    )}
                  </span>
                </>
              )}
            </>
          )}
        </div>
        <div className="text-xs text-[#666]">
          {graph?.nodes.length ?? 0} nodes · {graph?.edges.length ?? 0} edges
          {graph && ` · polled ${new Date(graph.server_time).toLocaleTimeString()}`}
        </div>
      </div>

      {err && (
        <div className="px-4 py-2 bg-red-500/15 text-red-300 text-sm border-b border-red-500/30">
          {err}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 bg-[#050505]">
        {writerNodes.length > 0 && (
          <div className="mb-4">
            <SectionLabel>Script writer</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {writerNodes.map(n => <NodeCard key={n.id} n={n} onSelect={() => setSelected(n)} />)}
            </div>
            <Connector />
          </div>
        )}

        {slotNodes.map((slot, slotIdx) => {
          const gems = slotKeyToGems[slot.node_key] ?? [];
          return (
            <div key={slot.id} className="mb-3">
              <div className="flex items-start gap-3">
                <NodeCard n={slot} width={220} onSelect={() => setSelected(slot)} />
                <div className="flex flex-wrap gap-2 items-start pt-1">
                  {gems.map(g => (
                    <NodeCard key={g.id} n={g} onSelect={() => setSelected(g)} />
                  ))}
                </div>
              </div>
              {slotIdx < slotNodes.length - 1 && <Connector />}
            </div>
          );
        })}

        {composeNodes.length > 0 && (
          <div className="mt-6 border-t border-[#222] pt-4">
            <SectionLabel>Final compose</SectionLabel>
            <div className="flex gap-2">
              {composeNodes.map(n => <NodeCard key={n.id} n={n} width={280} onSelect={() => setSelected(n)} />)}
            </div>
            {graph?.job.final_video_url && (
              <div className="mt-3">
                <a
                  href={graph.job.final_video_url}
                  className="text-sm text-blue-300 hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  → open final mp4
                </a>
              </div>
            )}
          </div>
        )}

        {slotNodes.length === 0 && writerNodes.length === 0 && !err && (
          <div className="text-center text-[#666] py-8 text-sm">
            {graph ? 'No graph nodes yet — waiting for first slot.' : 'Loading…'}
          </div>
        )}
      </div>

      {selected && (
        <NodeDetail node={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs uppercase tracking-wider text-[#666] mb-2">{children}</div>
  );
}

function Connector() {
  return (
    <div className="h-3 flex justify-start pl-[110px]">
      <div className="w-px bg-[#333]" />
    </div>
  );
}

function NodeCard({ n, width, onSelect }: { n: GraphNode; width?: number; onSelect: () => void }) {
  const elapsedMs = n.payload?.elapsed_ms as number | undefined;
  const cached = n.status === 'cached';
  return (
    <button
      onClick={onSelect}
      className={`text-left rounded-md px-2.5 py-1.5 text-xs ${STATUS_RING[n.status]} hover:brightness-125 transition`}
      style={{ width: width ?? 180 }}
      title={n.node_key}
    >
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="font-mono truncate" style={{ maxWidth: '85%' }}>
          {NODE_TYPE_BADGE[n.node_type]} {n.label}
        </span>
        {cached && <span className="text-[10px]">⚡</span>}
      </div>
      <div className="flex items-center justify-between text-[10px] opacity-70">
        <span>{n.status}</span>
        {elapsedMs != null && <span>{elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs/1000).toFixed(1)}s`}</span>}
      </div>
    </button>
  );
}

function NodeDetail({ node, onClose }: { node: GraphNode; onClose: () => void }) {
  return (
    <div className="absolute top-14 right-4 bottom-4 w-[420px] bg-[#0d0d0d] border border-[#333] rounded shadow-2xl flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#222]">
        <div className="font-mono text-xs text-[#ddd] truncate">{node.label}</div>
        <button onClick={onClose} className="text-[#888] hover:text-white text-sm">×</button>
      </div>
      <div className="p-3 overflow-auto text-xs text-[#ddd] space-y-3">
        <div>
          <div className="text-[#666] mb-1">Status</div>
          <div className={STATUS_RING[node.status] + ' inline-block px-2 py-0.5 rounded'}>
            {node.status}
          </div>
        </div>
        <div>
          <div className="text-[#666] mb-1">Key</div>
          <code className="text-[10px] text-[#aaa] break-all">{node.node_key}</code>
        </div>
        {node.started_at && (
          <div>
            <div className="text-[#666] mb-1">Started</div>
            <div className="text-[#bbb]">{new Date(node.started_at).toLocaleTimeString()}</div>
          </div>
        )}
        {node.finished_at && (
          <div>
            <div className="text-[#666] mb-1">Finished</div>
            <div className="text-[#bbb]">{new Date(node.finished_at).toLocaleTimeString()}</div>
          </div>
        )}
        {node.payload && (
          <div>
            <div className="text-[#666] mb-1">Payload</div>
            <pre className="text-[10px] bg-[#020202] border border-[#222] rounded p-2 overflow-auto max-h-96">
{JSON.stringify(node.payload, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
