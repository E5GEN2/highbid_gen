'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ExecutionGraph from './ExecutionGraph';

/**
 * Admin → Producer tab.
 *
 * Overwatch for the producer pipeline. Three rows:
 *   1. Status chips + start form
 *   2. Recent jobs list (auto-polls while anything is running)
 *   3. Per-job detail: timeline of slots × gems with status pills,
 *      elapsed_ms, tool outputs, final video player
 *
 * Polls /api/admin/content-gen/producer/status?list=1 every 4s when
 * jobs are in flight; otherwise on activate + manual refresh only.
 */

interface ProducerJob {
  id: number;
  channel_id: string | null;
  channel_name: string | null;
  niche_index: number | null;
  video_id: string | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  final_video_url: string | null;
  gems_total: number;
  gems_done: number;
  gems_failed: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProducerGem {
  slot_id: string;
  slot_index: number;
  gem_id: string;
  tool: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  output_jsonb: Record<string, unknown> | null;
  error: string | null;
  elapsed_ms: number | null;
  started_at: string | null;
  finished_at: string | null;
  args_jsonb: Record<string, unknown>;
}

const STATUS_STYLE: Record<string, string> = {
  pending:   'border-[#444] text-[#888]',
  running:   'border-blue-500 text-blue-300 bg-blue-500/10',
  done:      'border-green-600 text-green-300 bg-green-600/10',
  failed:    'border-red-500 text-red-300 bg-red-500/10',
  cancelled: 'border-[#555] text-[#888]',
  skipped:   'border-[#555] text-[#888]',
};

const TOOL_COLOR: Record<string, string> = {
  yt_capture:    'bg-purple-600/30 text-purple-200',
  tts:           'bg-blue-600/30 text-blue-200',
  sfx_render:    'bg-yellow-600/30 text-yellow-200',
  image_gen:     'bg-pink-600/30 text-pink-200',
  audio_mix:     'bg-orange-600/30 text-orange-200',
  video_compose: 'bg-emerald-600/30 text-emerald-200',
};

export default function ProducerTab({ active }: { active: boolean }) {
  const [jobs, setJobs] = useState<ProducerJob[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  // Execution graph overlay — when set, the live DAG for that job is shown
  // as a full-screen panel over the producer tab.
  const [graphJobId, setGraphJobId] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ job: ProducerJob; gems: ProducerGem[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [startForm, setStartForm] = useState({ channelId: '', beat_id: 'channel_proof_1', sync: false });
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/content-gen/producer/status?list=1&limit=50').then(r => r.json());
      if (r.ok) { setJobs(r.jobs ?? []); setCounts(r.counts ?? {}); }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);

  const fetchDetail = useCallback(async (id: number) => {
    setDetailLoading(true);
    try {
      const r = await fetch(`/api/admin/content-gen/producer/status?id=${id}`).then(r => r.json());
      if (r.ok) setDetail({ job: r.job, gems: r.gems });
    } catch { /* */ } finally { setDetailLoading(false); }
  }, []);

  useEffect(() => { if (active) refresh(); }, [active, refresh]);

  // Auto-poll while jobs are running.
  useEffect(() => {
    if (!active) return;
    const inFlight = (counts.running ?? 0) + (counts.pending ?? 0);
    if (pollRef.current) clearTimeout(pollRef.current);
    if (inFlight > 0) pollRef.current = setTimeout(() => {
      refresh();
      if (selectedJobId) fetchDetail(selectedJobId);
    }, 4000);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [active, counts, jobs, selectedJobId, refresh, fetchDetail]);

  const startJob = async () => {
    if (!startForm.channelId.trim()) { setMsg('channelId required'); return; }
    setSubmitting(true); setMsg(null);
    try {
      const r = await fetch('/api/admin/content-gen/producer/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: startForm.channelId.trim(),
          beat_id: startForm.beat_id,
          sync: startForm.sync,
        }),
      }).then(r => r.json());
      if (r.ok) {
        setMsg(`✓ Started job ${r.job_id} (${r.mode ?? 'sync'})`);
        await refresh();
        setSelectedJobId(r.job_id);
        await fetchDetail(r.job_id);
      } else {
        setMsg(`✗ ${r.error ?? 'failed'}${r.detail ? ': ' + r.detail : ''}`);
      }
    } catch (e) { setMsg((e as Error).message); } finally { setSubmitting(false); }
  };

  const select = (id: number) => { setSelectedJobId(id); fetchDetail(id); };

  return (
    <div className="max-w-[1600px] mx-auto px-6 py-6 text-[#ddd]">
      {graphJobId != null && (
        <ExecutionGraph jobId={graphJobId} onClose={() => setGraphJobId(null)} />
      )}

      <div className="mb-5">
        <h2 className="text-lg font-semibold text-white">Producer</h2>
        <p className="text-xs text-[#888] mt-1">
          Executes a ConcreteScript end-to-end: script-writer → per-slot gems (yt_capture / tts / sfx_render / image_gen) → video_compose → final mp4.
          One row per (slot, gem). Auto-refreshes every 4s while jobs are in flight. Click <span className="text-[#ddd]">Execution →</span> on any job to open the live DAG.
        </p>
      </div>

      {msg && <div className="mb-4 text-xs text-[#bbb] bg-[#101010] border border-[#222] rounded px-3 py-2">{msg}</div>}

      {/* Status chips */}
      <div className="flex items-center gap-2 mb-5 text-xs flex-wrap">
        {(['pending', 'running', 'done', 'failed'] as const).map(s => (
          <span key={s} className={`px-2 py-1 rounded border ${STATUS_STYLE[s]}`}>
            {s}: {counts[s] ?? 0}
          </span>
        ))}
        <button onClick={refresh} disabled={loading}
          className="ml-auto px-3 py-1 rounded border border-[#2a2a2a] hover:border-[#444] text-[#aaa] disabled:opacity-50">
          {loading ? 'Refresh…' : 'Refresh'}
        </button>
      </div>

      {/* Start form */}
      <div className="rounded-lg border border-[#1f1f1f] bg-[#101010] p-4 mb-6 flex items-center gap-3 flex-wrap">
        <label className="text-xs text-[#888]">channelId</label>
        <input
          value={startForm.channelId}
          onChange={e => setStartForm(f => ({ ...f, channelId: e.target.value }))}
          placeholder="UCM6UaLvydAAnhWP-g_Ra9yw"
          className="flex-1 min-w-[280px] bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-1.5 text-sm text-white placeholder-[#555] outline-none font-mono"
        />
        <label className="text-xs text-[#888]">beat_id</label>
        <select
          value={startForm.beat_id}
          onChange={e => setStartForm(f => ({ ...f, beat_id: e.target.value }))}
          className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white outline-none"
        >
          <option value="channel_proof_1">channel_proof_1 (1 slot)</option>
          <option value="channel_proof_2">channel_proof_2 (1 slot)</option>
          <option value="top_video_callout">top_video_callout (1 slot)</option>
          <option value="niche_segment_3">niche_segment_3 (3 screenshots)</option>
          <option value="niche_segment_full">niche_segment_full (6 mixed: cards+screens+chalkboard)</option>
        </select>
        <label className="text-xs text-[#888] flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={startForm.sync}
            onChange={e => setStartForm(f => ({ ...f, sync: e.target.checked }))}
            className="accent-blue-500" />
          sync (block until render)
        </label>
        <button onClick={startJob} disabled={submitting}
          className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium">
          {submitting ? 'Starting…' : 'Start render'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4">
        {/* Job list */}
        <div className="rounded-lg border border-[#1f1f1f] bg-[#101010] p-3 max-h-[800px] overflow-y-auto">
          <div className="text-xs uppercase tracking-wide text-[#888] mb-2">Jobs</div>
          {jobs.length === 0 && <div className="text-[#555] text-sm py-8 text-center">No jobs yet</div>}
          <div className="flex flex-col gap-1">
            {jobs.map(j => (
              <button key={j.id} onClick={() => select(j.id)}
                className={`text-left rounded px-2 py-2 border ${selectedJobId === j.id ? 'border-blue-500 bg-blue-500/5' : 'border-transparent hover:bg-[#161616]'}`}>
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-[#888] w-10">#{j.id}</span>
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] ${STATUS_STYLE[j.status]}`}>{j.status}</span>
                  <span className="text-white truncate flex-1">{j.channel_name ?? j.channel_id ?? '—'}</span>
                </div>
                <div className="text-[10px] text-[#666] mt-1 flex items-center gap-2">
                  <span>{j.video_id ?? ''}</span>
                  <span className="ml-auto">{j.gems_done}/{j.gems_total} gems</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Job detail */}
        <div className="rounded-lg border border-[#1f1f1f] bg-[#101010] p-4 min-h-[400px]">
          {!selectedJobId && <div className="text-[#555] text-center py-20">Click a job to see its timeline</div>}
          {selectedJobId && !detail && !detailLoading && <div className="text-[#555] py-20">Loading…</div>}
          {detailLoading && <div className="text-[#888] text-xs">Refreshing…</div>}
          {detail && <JobDetailView detail={detail} onOpenGraph={setGraphJobId} />}
        </div>
      </div>
    </div>
  );
}

/** Lazy-loads N frames from /producer/frames and renders them as a
 *  horizontal strip — fulfills the "cut frames to inspect important moments"
 *  loop in the user's original ask. Frames are cached server-side per job. */
function FrameStrip({ jobId }: { jobId: number }) {
  const [frames, setFrames] = useState<Array<{ index: number; ts: number; label: string; url: string }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/content-gen/producer/frames?id=${jobId}&count=8`).then(r => r.json());
      if (r.ok) setFrames(r.frames);
      else setErr(r.error ?? 'failed');
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  };

  return (
    <div className="border-t border-[#222] px-2 py-2 bg-[#0a0a0a]">
      <div className="flex items-center gap-2 mb-1">
        <button onClick={load} disabled={loading}
          className="text-[10px] px-2 py-0.5 rounded border border-[#333] hover:border-[#555] text-[#aaa] disabled:opacity-50">
          {loading ? 'Extracting…' : frames ? 'Re-extract frames' : 'Inspect frames'}
        </button>
        {err && <span className="text-[10px] text-red-300">{err}</span>}
      </div>
      {frames && frames.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {frames.map(f => (
            <div key={f.index} className="flex-shrink-0 flex flex-col">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.url} alt={f.label} className="h-32 w-auto rounded border border-[#222] object-contain bg-black" />
              <div className="text-[9px] text-[#777] mt-0.5 text-center font-mono">
                {f.label.length > 22 ? f.label.slice(0, 22) + '…' : f.label}
                <br />
                {f.ts.toFixed(1)}s
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JobDetailView({ detail, onOpenGraph }: { detail: { job: ProducerJob; gems: ProducerGem[] }; onOpenGraph: (id: number) => void }) {
  const { job, gems } = detail;
  // Group gems by slot_id, in slot_index order
  const slotsMap = new Map<string, { slot_index: number; gems: ProducerGem[] }>();
  for (const g of gems) {
    if (!slotsMap.has(g.slot_id)) slotsMap.set(g.slot_id, { slot_index: g.slot_index, gems: [] });
    slotsMap.get(g.slot_id)!.gems.push(g);
  }
  const slots = Array.from(slotsMap.entries()).sort((a, b) => a[1].slot_index - b[1].slot_index);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-lg text-white font-semibold">Job #{job.id} — {job.channel_name ?? job.channel_id}</div>
          <div className="text-xs text-[#888] mt-1">
            video_id={job.video_id} · {job.gems_done}/{job.gems_total} gems done · {job.gems_failed} failed
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onOpenGraph(job.id)}
            className="px-3 py-1 text-xs rounded border border-[#333] bg-[#1a1a1a] hover:bg-[#222] text-[#ddd]"
            title="Open the live execution graph for this render"
          >
            Execution →
          </button>
          <span className={`px-2 py-1 rounded border text-xs ${STATUS_STYLE[job.status]}`}>{job.status}</span>
        </div>
      </div>

      {job.error && (
        <div className="rounded border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-200 font-mono whitespace-pre-wrap">
          {job.error}
        </div>
      )}

      {/* Final video player + frame inspection */}
      {job.final_video_url && (
        <div className="rounded border border-[#222] overflow-hidden bg-black">
          <video src={job.final_video_url} controls className="w-full max-h-[600px]" />
          <div className="text-[10px] text-[#666] px-2 py-1 font-mono">{job.final_video_url}</div>
          <FrameStrip jobId={job.id} />
        </div>
      )}

      {/* Timeline */}
      <div className="flex flex-col gap-2">
        <div className="text-xs uppercase tracking-wide text-[#888]">Timeline</div>
        {slots.map(([slot_id, info]) => (
          <div key={slot_id} className="rounded border border-[#222] bg-[#0a0a0a] p-3">
            <div className="text-xs text-white font-mono mb-2">slot #{info.slot_index} · {slot_id}</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {info.gems.map(g => (
                <div key={g.gem_id} className="rounded border border-[#1a1a1a] bg-[#0a0a0a] px-2 py-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${TOOL_COLOR[g.tool] ?? 'bg-[#222] text-[#aaa]'}`}>{g.tool}</span>
                    <span className="text-white font-mono">{g.gem_id}</span>
                    <span className={`ml-auto px-1.5 py-0.5 rounded border text-[10px] ${STATUS_STYLE[g.status]}`}>{g.status}</span>
                  </div>
                  {g.elapsed_ms != null && (
                    <div className="text-[10px] text-[#666] mt-1">{(g.elapsed_ms / 1000).toFixed(2)}s</div>
                  )}
                  {g.output_jsonb?.file_url && (
                    <div className="text-[10px] text-[#888] mt-1 truncate font-mono" title={String(g.output_jsonb.file_url)}>
                      {String(g.output_jsonb.file_url).slice(0, 60)}
                    </div>
                  )}
                  {g.output_jsonb?.duration_s != null && (
                    <div className="text-[10px] text-[#888] mt-1">dur: {(g.output_jsonb.duration_s as number).toFixed(2)}s</div>
                  )}
                  {g.error && (
                    <div className="text-[10px] text-red-300 mt-1 font-mono whitespace-pre-wrap line-clamp-3" title={g.error}>
                      {g.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
