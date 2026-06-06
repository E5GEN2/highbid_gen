'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Admin → Image Gen tab.
 *
 * Submit prompts to xgodo's image-gen flow ({prompt, aspect, model}), watch
 * the queue, and view the downloaded results. The on-demand icon / asset
 * factory for content-gen. Wires to /api/admin/imagegen (GET polls + lists,
 * POST submits) and /api/admin/imagegen/file (serves downloaded images).
 *
 * The GET endpoint runs a tick on every call (polls in-flight tasks +
 * downloads finished temp urls), so simply refreshing this view advances the
 * queue. We auto-poll every 5s while anything is queued/running.
 */

const MODELS = ['nanobananapro', 'nanobanana', 'imagen4'];
const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'];

interface ImageRow {
  id: number;
  purpose: string | null;
  prompt: string;
  aspect: string | null;
  model: string | null;
  status: string;
  planned_task_id: string | null;
  xgodo_temp_url: string | null;
  expires_at: string | null;
  image_name: string | null;
  worker_name: string | null;
  error: string | null;
  downloaded: boolean;
  file_url: string | null;
  submitted_at: string | null;
  finished_at: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  queued: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  running: 'bg-amber-500/15 text-amber-300 border-amber-500/30 animate-pulse',
  done: 'bg-green-500/15 text-green-300 border-green-500/30',
  failed: 'bg-red-500/15 text-red-300 border-red-500/30',
};

export default function ImageGenTab({ active }: { active: boolean }) {
  const [images, setImages] = useState<ImageRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState('1:1');
  const [model, setModel] = useState('nanobananapro');
  const [purpose, setPurpose] = useState('');
  const [count, setCount] = useState(1);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/imagegen?limit=120').then(r => r.json());
      if (r.ok) { setImages(r.images || []); setCounts(r.counts || {}); }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);

  // Auto-poll while anything is in flight.
  useEffect(() => {
    if (!active) return;
    refresh();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return;
    const inFlight = (counts.queued ?? 0) + (counts.running ?? 0);
    if (pollRef.current) clearTimeout(pollRef.current);
    if (inFlight > 0) pollRef.current = setTimeout(refresh, 5000);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [active, counts, images, refresh]);

  const submit = async () => {
    if (!prompt.trim()) { setMsg('Enter a prompt'); return; }
    setSubmitting(true); setMsg(null);
    try {
      const r = await fetch('/api/admin/imagegen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), aspect, model, purpose: purpose.trim() || undefined, count }),
      }).then(r => r.json());
      if (r.ok) { setMsg(`Submitted ${r.submitted} task${r.submitted === 1 ? '' : 's'}${r.failed ? `, ${r.failed} failed` : ''}`); setPrompt(''); refresh(); }
      else setMsg(r.error || 'submit failed');
    } catch (e) { setMsg((e as Error).message); } finally { setSubmitting(false); }
  };

  const expiryLabel = (iso: string | null) => {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'temp expired';
    const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
    return `temp expires in ${h ? h + 'h' : ''}${m}m`;
  };

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-6 text-[#ddd]">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-white">Image Gen</h2>
        <p className="text-xs text-[#888] mt-1">Submit prompts to xgodo&apos;s image-gen workers. Results land as temp urls and are downloaded to the volume automatically. Use it to generate the icon library + card assets on demand.</p>
      </div>

      {/* ── submit form ── */}
      <div className="rounded-lg border border-[#1f1f1f] bg-[#101010] p-4 mb-6">
        <label className="block text-xs text-[#888] mb-1">Prompt</label>
        <textarea
          value={prompt} onChange={e => setPrompt(e.target.value)}
          placeholder="e.g. a minimal flat single-color line-drawing icon of a shrugging figure with two question marks, black on white, centered, thick strokes"
          rows={3}
          className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-white placeholder-[#555] focus:border-lime-500/60 outline-none resize-y"
        />
        <div className="flex flex-wrap items-end gap-3 mt-3">
          <div>
            <label className="block text-xs text-[#888] mb-1">Aspect</label>
            <select value={aspect} onChange={e => setAspect(e.target.value)} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-white outline-none">
              {ASPECTS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[#888] mb-1">Model</label>
            <select value={model} onChange={e => setModel(e.target.value)} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-white outline-none">
              {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[#888] mb-1">Purpose <span className="text-[#555]">(optional tag)</span></label>
            <input value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="icon:shrug" className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-white placeholder-[#555] outline-none w-40" />
          </div>
          <div>
            <label className="block text-xs text-[#888] mb-1">Count</label>
            <input type="number" min={1} max={10} value={count} onChange={e => setCount(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-white outline-none w-16" />
          </div>
          <button onClick={submit} disabled={submitting} className="px-4 py-1.5 rounded bg-lime-600 hover:bg-lime-500 disabled:opacity-50 text-white text-sm font-medium">
            {submitting ? 'Submitting…' : `Generate${count > 1 ? ` ×${count}` : ''}`}
          </button>
          {msg && <span className="text-xs text-[#aaa]">{msg}</span>}
        </div>
      </div>

      {/* ── status bar ── */}
      <div className="flex items-center gap-2 mb-4 text-xs">
        {(['queued', 'running', 'done', 'failed'] as const).map(s => (
          <span key={s} className={`px-2 py-1 rounded border ${STATUS_STYLE[s]}`}>{s}: {counts[s] ?? 0}</span>
        ))}
        <button onClick={refresh} disabled={loading} className="ml-auto px-3 py-1 rounded border border-[#2a2a2a] hover:border-[#444] text-[#aaa] disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* ── grid ── */}
      {images.length === 0 ? (
        <div className="text-center text-[#666] text-sm py-16 border border-dashed border-[#222] rounded-lg">No images yet. Submit a prompt above.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {images.map(img => (
            <div key={img.id} className="rounded-lg border border-[#1f1f1f] bg-[#101010] overflow-hidden flex flex-col">
              <div className="aspect-square bg-[#0a0a0a] flex items-center justify-center relative">
                {img.file_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img.file_url} alt={img.prompt.slice(0, 40)} className="w-full h-full object-contain" />
                ) : (
                  <span className={`text-[11px] px-2 py-1 rounded border ${STATUS_STYLE[img.status] ?? ''}`}>{img.status}</span>
                )}
                <span className={`absolute top-1.5 left-1.5 text-[10px] px-1.5 py-0.5 rounded border ${STATUS_STYLE[img.status] ?? ''}`}>{img.status}</span>
              </div>
              <div className="p-2 flex-1 flex flex-col gap-1">
                <p className="text-[11px] text-[#bbb] line-clamp-2" title={img.prompt}>{img.prompt}</p>
                <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-[#777]">
                  {img.purpose && <span className="px-1 py-0.5 rounded bg-lime-500/10 text-lime-300/90 border border-lime-500/20">{img.purpose}</span>}
                  <span>{img.model}</span><span>·</span><span>{img.aspect}</span>
                  {img.worker_name && <><span>·</span><span>{img.worker_name}</span></>}
                </div>
                {img.error && <p className="text-[10px] text-red-400/90 line-clamp-2" title={img.error}>{img.error}</p>}
                {img.status === 'done' && img.expires_at && <p className="text-[10px] text-[#555]">{expiryLabel(img.expires_at)}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
