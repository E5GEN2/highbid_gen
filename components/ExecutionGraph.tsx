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

  // Live updates: prefer SSE (instant push) with polling as fallback.
  //
  // SSE delivers events as nodes transition state on the server (~500ms
  // poll on the server side, but only changed rows are pushed). Falls
  // back to 1.5s polling if EventSource fails (proxy strips event-stream,
  // CORS issue, etc.). Polling is also the recovery path when SSE returns
  // 'end' with reason='hard-deadline-client-should-reconnect' on long
  // renders past the 5-minute server cap.
  useEffect(() => {
    if (jobId == null) return;
    void fetchGraph();  // always seed via the regular endpoint

    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let useFallbackPoll = false;

    const startPolling = () => {
      if (pollTimer) clearTimeout(pollTimer);
      const tick = () => {
        void fetchGraph();
        pollTimer = setTimeout(tick, 1500);
      };
      pollTimer = setTimeout(tick, 1500);
    };

    try {
      es = new EventSource(`/api/admin/content-gen/producer/graph/stream?id=${jobId}`, { withCredentials: true });
      // Initial snapshot or delta — both merge into local graph state.
      const applyNodes = (incoming: GraphNode[], edges?: GraphEdge[]) => {
        setGraph(prev => {
          if (!prev) return prev;
          const byId = new Map(prev.nodes.map(n => [n.node_key, n] as const));
          for (const n of incoming) byId.set(n.node_key, n);
          const mergedNodes = Array.from(byId.values()).sort((a, b) => a.id - b.id);
          const mergedEdges = edges
            ? Array.from(new Map([...prev.edges, ...edges].map(e => [`${e.from_key}${e.to_key}${e.kind}`, e])).values())
            : prev.edges;
          return { ...prev, nodes: mergedNodes, edges: mergedEdges, server_time: new Date().toISOString() };
        });
      };
      es.addEventListener('snapshot', ev => {
        try {
          const d = JSON.parse((ev as MessageEvent).data);
          setGraph({ job: d.job, nodes: d.nodes, edges: d.edges, server_time: d.server_time });
        } catch { /* ignore parse */ }
      });
      es.addEventListener('delta', ev => {
        try {
          const d = JSON.parse((ev as MessageEvent).data);
          applyNodes(d.nodes ?? [], d.edges ?? []);
        } catch { /* ignore */ }
      });
      es.addEventListener('job', ev => {
        try {
          const d = JSON.parse((ev as MessageEvent).data);
          setGraph(prev => prev ? { ...prev, job: { ...prev.job, ...d.job } } : prev);
        } catch { /* ignore */ }
      });
      es.addEventListener('end', () => {
        es?.close();
        es = null;
        // If server ended via hard-deadline while job still running,
        // fall back to polling so we keep updating.
        void fetchGraph();
      });
      es.onerror = () => {
        // EventSource auto-reconnects on transient errors; we only escalate
        // to polling fallback after a sustained failure (3+ retries).
        // For simplicity: switch to polling immediately on first error,
        // since polling is cheap.
        if (!useFallbackPoll) {
          useFallbackPoll = true;
          es?.close();
          es = null;
          startPolling();
        }
      };
    } catch {
      // EventSource not available (e.g. very old browser). Polling fallback.
      startPolling();
    }

    return () => {
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
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
  const dbSaveNodes  = (graph?.nodes ?? []).filter(n => n.node_type === 'db_save');

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

      <DagCanvas
        graph={graph}
        slotKeyToGems={slotKeyToGems}
        dbSaveNodes={dbSaveNodes}
        writerNodes={writerNodes}
        slotNodes={slotNodes}
        composeNodes={composeNodes}
        onSelect={setSelected}
      />

      {!err && graph && graph.nodes.length === 0 && (
        <div className="text-center text-[#666] py-8 text-sm">Loading…</div>
      )}

      {selected && (
        <NodeDetail
          node={selected}
          onClose={() => setSelected(null)}
          toolCalls={
            // Sub-events for the selected gem — surface yt_capture's
            // browser:launch / page:goto / screenshot:* steps under the
            // gem detail. Filtered via the depends_on edges that
            // exec-context emits when emitToolCall runs.
            selected.node_type === 'gem'
              ? (graph?.nodes ?? []).filter(n =>
                  n.node_type === 'tool_call' &&
                  (graph?.edges ?? []).some(e =>
                    e.kind === 'sequence' &&
                    e.from_key === selected.node_key &&
                    e.to_key === n.node_key,
                  ),
                )
              : []
          }
        />
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-[#666] mb-1 select-none">{children}</div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Custom DAG canvas — absolute-positioned nodes with SVG edges drawn
// between them by node_key. Layout is deterministic so SVG paths can
// reference computed node centers without needing DOM measurement.
//
// Lane stack (top → bottom):
//   db_save      (lane 0)
//   writer       (lane 1)
//   slot rows    (lanes 2..N; each slot row has slot card + child gem cards)
//   compose      (last lane)
// ───────────────────────────────────────────────────────────────────

const NODE_W = 180;
const NODE_H = 56;
const SLOT_W = 220;
const COMPOSE_W = 280;
const NODE_GAP_X = 12;
const LANE_GAP_Y = 56;
const SLOT_GAP_Y = 14;
const LANE_PAD_X = 24;

interface PlacedNode {
  n: GraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Slot keys follow the pattern `slot:niche_<N>_<beat>` in listicle
 *  renders; CTA / non-niche slots fall into the `__other__` bucket. */
function nicheOfSlot(slotKey: string): string | null {
  // node_key is "slot:niche_3_channel_proof_1" etc.
  const m = /^slot:niche_(\d+)_/.exec(slotKey);
  if (m) return m[1];
  if (/^slot:cta_/.test(slotKey)) return null; // CTA shares with __other__
  return null;
}

function DagCanvas({
  graph, slotKeyToGems, dbSaveNodes, writerNodes, slotNodes, composeNodes, onSelect,
}: {
  graph: GraphResponse | null;
  slotKeyToGems: Record<string, GraphNode[]>;
  dbSaveNodes: GraphNode[];
  writerNodes: GraphNode[];
  slotNodes: GraphNode[];
  composeNodes: GraphNode[];
  onSelect: (n: GraphNode) => void;
}) {
  // Niche collapse state — keyed by niche index ('1', '2', …, '__other__').
  // Multi-channel listicle renders produce ~120 slots; without grouping the
  // panel is overwhelming. Niches start collapsed when there are many.
  const niches = Array.from(new Set(slotNodes.map(s => nicheOfSlot(s.node_key) ?? '__other__')));
  const manyNiches = niches.length > 3;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(manyNiches ? niches : []));
  const toggle = (k: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  // Layout pass — compute (x,y,w,h) per node_key. Lane-by-lane top-down.
  const positions: Record<string, PlacedNode> = {};
  // Niche group headers (clickable bars).
  const groupBars: Array<{ key: string; y: number; w: number; slotCount: number; gemCount: number; doneCount: number; cachedCount: number; failedCount: number; stuckCount: number; collapsed: boolean }> = [];
  let y = 16;

  const placeLane = (label: string | null, nodes: GraphNode[], w: number) => {
    if (nodes.length === 0) return;
    let x = LANE_PAD_X;
    for (const n of nodes) {
      positions[n.node_key] = { n, x, y: y + (label ? 16 : 0), w, h: NODE_H };
      x += w + NODE_GAP_X;
    }
    y += (label ? 16 : 0) + NODE_H + LANE_GAP_Y;
  };

  placeLane('db_save',  dbSaveNodes, NODE_W);
  placeLane('writer',   writerNodes, NODE_W);

  // Group slots by niche. Each group renders a clickable bar; expanded
  // groups then render slot rows the normal way.
  const slotsByNiche: Record<string, GraphNode[]> = {};
  for (const s of slotNodes) {
    const k = nicheOfSlot(s.node_key) ?? '__other__';
    (slotsByNiche[k] ??= []).push(s);
  }
  const orderedNicheKeys = Object.keys(slotsByNiche).sort((a, b) => {
    if (a === '__other__') return 1;
    if (b === '__other__') return -1;
    return parseInt(a, 10) - parseInt(b, 10);
  });

  const nowMs = Date.now();
  for (const nKey of orderedNicheKeys) {
    const slots = slotsByNiche[nKey];
    const allGems = slots.flatMap(s => slotKeyToGems[s.node_key] ?? []);
    const doneCount   = allGems.filter(g => g.status === 'done').length;
    const cachedCount = allGems.filter(g => g.status === 'cached').length;
    const failedCount = allGems.filter(g => g.status === 'failed').length;
    const stuckCount = allGems.filter(g =>
      g.status === 'running' && g.started_at &&
      (nowMs - new Date(g.started_at).getTime()) > 90_000
    ).length;
    const isCollapsed = collapsed.has(nKey);

    // Reserve canvas room for the group bar at this y.
    const barW = Math.max(
      LANE_PAD_X * 2 + SLOT_W + NODE_GAP_X +
        Math.max(...slots.map(s => (slotKeyToGems[s.node_key] ?? []).length)) * (NODE_W + NODE_GAP_X),
      800,
    );
    groupBars.push({ key: nKey, y, w: barW, slotCount: slots.length, gemCount: allGems.length, doneCount, cachedCount, failedCount, stuckCount, collapsed: isCollapsed });
    y += 32;

    if (!isCollapsed) {
      for (const slot of slots) {
        const gems = slotKeyToGems[slot.node_key] ?? [];
        positions[slot.node_key] = { n: slot, x: LANE_PAD_X, y, w: SLOT_W, h: NODE_H };
        let gemX = LANE_PAD_X + SLOT_W + NODE_GAP_X;
        for (const g of gems) {
          positions[g.node_key] = { n: g, x: gemX, y, w: NODE_W, h: NODE_H };
          gemX += NODE_W + NODE_GAP_X;
        }
        y += NODE_H + SLOT_GAP_Y;
      }
    }
    y += LANE_GAP_Y - SLOT_GAP_Y;
  }

  placeLane('compose', composeNodes, COMPOSE_W);

  const canvasH = y + 24;
  const canvasW = Math.max(
    LANE_PAD_X * 2 + writerNodes.length * (NODE_W + NODE_GAP_X),
    LANE_PAD_X * 2 + dbSaveNodes.length * (NODE_W + NODE_GAP_X),
    ...slotNodes.map(s => {
      const gems = slotKeyToGems[s.node_key] ?? [];
      return LANE_PAD_X * 2 + SLOT_W + NODE_GAP_X + gems.length * (NODE_W + NODE_GAP_X);
    }),
    LANE_PAD_X * 2 + COMPOSE_W,
    800,
  );

  // Edge paths — center-to-center curves.
  const edgePaths: Array<{ id: number; d: string; kind: GraphEdge['kind'] }> = [];
  for (const e of graph?.edges ?? []) {
    const a = positions[e.from_key];
    const b = positions[e.to_key];
    if (!a || !b) continue;
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    // Cubic Bezier for vertical-ish edges; straight-ish for sibling edges (same y).
    const dy = Math.abs(y2 - y1);
    const dx = Math.abs(x2 - x1);
    let d: string;
    if (dy < 8) {
      // Same lane — short horizontal connector.
      d = `M ${a.x + a.w} ${a.y + a.h / 2} L ${b.x} ${b.y + b.h / 2}`;
    } else {
      const cy1 = y1 + Math.min(40, dy * 0.4);
      const cy2 = y2 - Math.min(40, dy * 0.4);
      d = `M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`;
    }
    edgePaths.push({ id: e.id, d, kind: e.kind });
    void dx;
  }

  return (
    <div className="flex-1 overflow-auto bg-[#050505] relative">
      <div style={{ position: 'relative', width: canvasW, height: canvasH }}>
        {/* Lane separator labels (purely decorative, fixed at left edge). */}
        {dbSaveNodes.length > 0 && (
          <div style={{ position: 'absolute', left: 4, top: 0, fontSize: 9 }} className="uppercase tracking-wider text-[#444]">db_save</div>
        )}
        {writerNodes.length > 0 && (() => {
          const first = positions[writerNodes[0].node_key];
          return first ? (
            <div style={{ position: 'absolute', left: 4, top: first.y - 12, fontSize: 9 }} className="uppercase tracking-wider text-[#444]">writer</div>
          ) : null;
        })()}
        {composeNodes.length > 0 && (() => {
          const first = positions[composeNodes[0].node_key];
          return first ? (
            <div style={{ position: 'absolute', left: 4, top: first.y - 12, fontSize: 9 }} className="uppercase tracking-wider text-[#444]">compose</div>
          ) : null;
        })()}

        <svg
          width={canvasW} height={canvasH}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
        >
          <defs>
            <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="#555" />
            </marker>
          </defs>
          {edgePaths.map(ep => (
            <path
              key={ep.id}
              d={ep.d}
              fill="none"
              stroke={ep.kind === 'depends_on' ? '#3a3a3a' : ep.kind === 'compose_input' ? '#444' : '#555'}
              strokeWidth={ep.kind === 'compose_input' ? 1.5 : 1}
              strokeDasharray={ep.kind === 'depends_on' ? '4 3' : undefined}
              markerEnd="url(#arrowhead)"
            />
          ))}
        </svg>

        {/* Niche group bars — click to collapse/expand all of that niche's slots+gems. */}
        {groupBars.map(bar => {
          const label = bar.key === '__other__' ? 'Framing / CTA' : `Niche ${bar.key}`;
          const ratio = bar.gemCount > 0 ? Math.round(100 * (bar.doneCount + bar.cachedCount) / bar.gemCount) : 0;
          return (
            <button
              key={`bar:${bar.key}`}
              onClick={() => toggle(bar.key)}
              style={{ position: 'absolute', left: LANE_PAD_X, top: bar.y, width: bar.w - LANE_PAD_X * 2, height: 24 }}
              className="text-left rounded px-2 py-0.5 bg-[#0f0f0f] border border-[#1f1f1f] hover:bg-[#161616] flex items-center gap-2 text-[11px]"
            >
              <span className="text-[#666]">{bar.collapsed ? '▸' : '▾'}</span>
              <span className="text-[#ddd] font-semibold">{label}</span>
              <span className="text-[#666]">·</span>
              <span className="text-[#999]">{bar.slotCount} slots · {bar.gemCount} gems</span>
              {bar.cachedCount > 0 && (
                <span className="text-purple-300">· ⚡{bar.cachedCount}</span>
              )}
              {bar.failedCount > 0 && (
                <span className="text-red-300">· ✕{bar.failedCount}</span>
              )}
              {bar.stuckCount > 0 && (
                <span className="text-amber-300 animate-pulse" title="Gems running >90s — likely stuck">· ⚠️{bar.stuckCount}</span>
              )}
              <span className="ml-auto text-[#777] text-[10px] font-mono">{ratio}%</span>
            </button>
          );
        })}

        {Object.values(positions).map(p => (
          <div
            key={p.n.node_key}
            style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h }}
          >
            <NodeCard n={p.n} width={p.w} onSelect={() => onSelect(p.n)} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Threshold past which a running gem is considered "stuck" — long enough
 *  to be worth flagging visually so the user spots wedged Playwright /
 *  ffmpeg / API calls. 90s = same as yt_capture's hard-timeout window;
 *  if a gem is still running past this it's either close to timing out
 *  or it's a tool without timeout protection (which is itself a signal). */
const STUCK_THRESHOLD_MS = 90_000;

function NodeCard({ n, width, onSelect }: { n: GraphNode; width?: number; onSelect: () => void }) {
  const elapsedMs = n.payload?.elapsed_ms as number | undefined;
  const cached = n.status === 'cached';
  // Stuck detection: gem has been 'running' for too long. Computed against
  // started_at since elapsed_ms is only stamped after the gem finishes.
  // Re-evaluated on every render; the 1.5s polling cadence keeps it fresh.
  const runningMs = n.status === 'running' && n.started_at
    ? Date.now() - new Date(n.started_at).getTime()
    : 0;
  const stuck = runningMs > STUCK_THRESHOLD_MS;
  const stuckLabel = stuck
    ? runningMs < 60_000 ? `${Math.floor(runningMs/1000)}s`
      : `${Math.floor(runningMs/60_000)}m${Math.round((runningMs%60_000)/1000)}s`
    : null;
  return (
    <button
      onClick={onSelect}
      className={`text-left rounded-md px-2.5 py-1.5 text-xs hover:brightness-125 transition ${
        stuck
          ? 'ring-2 ring-amber-500 bg-amber-500/15 text-amber-100 animate-pulse'
          : STATUS_RING[n.status]
      }`}
      style={{ width: width ?? 180 }}
      title={stuck ? `${n.node_key} — stuck ${stuckLabel}` : n.node_key}
    >
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="font-mono truncate" style={{ maxWidth: '85%' }}>
          {NODE_TYPE_BADGE[n.node_type]} {n.label}
        </span>
        {cached && <span className="text-[10px]">⚡</span>}
        {stuck && <span className="text-[10px]" title={`stuck ${stuckLabel}`}>⚠️</span>}
      </div>
      <div className="flex items-center justify-between text-[10px] opacity-70">
        <span>{stuck ? `stuck ${stuckLabel}` : n.status}</span>
        {elapsedMs != null && <span>{elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs/1000).toFixed(1)}s`}</span>}
      </div>
    </button>
  );
}

function NodeDetail({ node, onClose, toolCalls }: { node: GraphNode; onClose: () => void; toolCalls?: GraphNode[] }) {
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
        {node.payload && (() => {
          // Inline asset preview when the gem payload references a file_url.
          // YT capture / image_gen produce PNGs; video_compose produces mp4.
          // (See toolCalls section below for sub-event timeline.)
          const fileUrl = (node.payload as Record<string, unknown>).file_url;
          if (typeof fileUrl === 'string' && fileUrl) {
            const isVideo = /\.mp4(\?|$)|video_compose/.test(fileUrl);
            return (
              <div>
                <div className="text-[#666] mb-1">Asset preview</div>
                {isVideo ? (
                  <video src={fileUrl} controls className="w-full rounded border border-[#222] bg-black" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={fileUrl} alt="gem output" className="w-full rounded border border-[#222] bg-black" />
                )}
                <div className="text-[10px] text-[#666] mt-1 font-mono break-all">{fileUrl}</div>
              </div>
            );
          }
          return null;
        })()}
        {toolCalls && toolCalls.length > 0 && (
          <div>
            <div className="text-[#666] mb-1">Tool calls ({toolCalls.length})</div>
            <ol className="text-[10px] text-[#bbb] space-y-0.5 font-mono">
              {toolCalls.map((tc, i) => {
                const elapsedMs = (tc.payload as Record<string, unknown>)?.elapsed_ms as number | undefined;
                return (
                  <li key={tc.id} className="flex items-baseline gap-2">
                    <span className="text-[#666] tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                    <span className={tc.status === 'failed' ? 'text-red-300' : tc.status === 'running' ? 'text-blue-300' : 'text-[#bbb]'}>
                      {tc.label}
                    </span>
                    {elapsedMs != null && (
                      <span className="text-[#666] ml-auto">
                        {elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(2)}s`}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
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
