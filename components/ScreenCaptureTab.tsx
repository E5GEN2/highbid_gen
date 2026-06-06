'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Admin → Screen Capture tab.
 *
 * Drives the YT-screen capture pipeline (Playwright + xgodo proxies). The
 * tab does three things in one view:
 *
 *   1. Trigger captures — single channel (handle/channel_id) or a batch of
 *      channel IDs. Defaults to channel_page; can pick about/videos/watch.
 *   2. Live overwatch — status counts + auto-poll while anything is in
 *      flight (status='capturing'), so the user can watch a batch land.
 *   3. Asset gallery — newest first, filterable by kind/status, with
 *      thumbnails (rendered from the served PNG), retry-on-fail, and a
 *      "view full" link.
 *
 * Wires to /api/admin/content-gen/yt-capture (POST batch, GET overwatch,
 * GET ?channelId for single-shot) and /yt-capture/file?id=... for images.
 */

const KINDS = ['channel_page', 'about_page', 'videos_tab', 'watch_page'] as const;
type Kind = typeof KINDS[number];
type CaptureMode = 'static' | 'scroll_record';
type AssetKind = 'image' | 'video';

interface BBox { x: number; y: number; w: number; h: number; }
type BBoxMap = Record<string, BBox>;

interface ScreenRow {
  id: number;
  channel_id: string;
  channel_name: string | null;
  handle: string | null;
  kind: Kind;
  url: string;
  geo: string | null;
  date_bucket: string;
  status: 'pending' | 'capturing' | 'done' | 'failed';
  has_file: boolean;
  file_url: string | null;
  bytes: number | null;
  page_width: number | null;
  page_height: number | null;
  proxy_country: string | null;
  proxy_device: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  asset_kind: AssetKind;
  capture_mode: CaptureMode;
  duration_s: number | null;
  bboxes_jsonb: BBoxMap | null;
}

const STATUS_STYLE: Record<string, string> = {
  pending:   'bg-slate-500/15 text-slate-300 border-slate-500/30',
  capturing: 'bg-amber-500/15 text-amber-300 border-amber-500/30 animate-pulse',
  done:      'bg-green-500/15 text-green-300 border-green-500/30',
  failed:    'bg-red-500/15 text-red-300 border-red-500/30',
};

function fmtBytes(n: number | null): string {
  if (!n) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}KB`;
  return `${n}B`;
}
function fmtTime(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

export default function ScreenCaptureTab({ active }: { active: boolean }) {
  const [rows, setRows] = useState<ScreenRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [kindCounts, setKindCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Filters
  const [filterKind, setFilterKind] = useState<Kind | ''>('');
  const [filterStatus, setFilterStatus] = useState<'' | 'pending' | 'capturing' | 'done' | 'failed'>('');

  // Form state
  const [channelInput, setChannelInput] = useState('');
  const [batchInput, setBatchInput] = useState('');
  const [kind, setKind] = useState<Kind>('channel_page');
  const [mode, setMode] = useState<CaptureMode | ''>('');  // '' = let server pick default per-kind
  const [watchVideoId, setWatchVideoId] = useState('');
  const [force, setForce] = useState(false);
  // Annotation: when set, the lib injects a yellow highlight on the matched
  // element BEFORE screenshotting. element='' = no annotation pass.
  const [annotateEl, setAnnotateEl] = useState<'' | 'subscriber_count' | 'video_count' | 'total_views' | 'joined_date' | 'view_count'>('');
  const [annotateStyle, setAnnotateStyle] = useState<'yellow_ring' | 'yellow_box' | 'yellow_highlight' | 'yellow_circle'>('yellow_circle');
  // Display toggles
  const [showBboxes, setShowBboxes] = useState(true);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filterKind) qs.set('kind', filterKind);
      if (filterStatus) qs.set('status', filterStatus);
      qs.set('limit', '120');
      const r = await fetch(`/api/admin/content-gen/yt-capture?${qs}`).then(r => r.json());
      if (r.ok) { setRows(r.rows ?? []); setCounts(r.counts ?? {}); setKindCounts(r.kindCounts ?? {}); }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [filterKind, filterStatus]);

  useEffect(() => { if (active) refresh(); }, [active, refresh]);

  // Auto-poll while anything is in flight.
  useEffect(() => {
    if (!active) return;
    const inFlight = (counts.capturing ?? 0) + (counts.pending ?? 0);
    if (pollRef.current) clearTimeout(pollRef.current);
    if (inFlight > 0) pollRef.current = setTimeout(refresh, 4000);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [active, counts, rows, refresh]);

  // ── Single channel capture (POST batch with one entry) ──────────
  const captureSingle = async () => {
    const cid = channelInput.trim();
    if (!cid) { setMsg('Enter a channel ID or handle'); return; }
    setSubmitting(true); setMsg(null);
    try {
      const r = await fetch('/api/admin/content-gen/yt-capture', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelIds: [cid], kind, mode: mode || undefined,
          watchVideoId: watchVideoId || undefined, force,
          annotate_element: annotateEl || undefined,
          annotate_style: annotateEl ? annotateStyle : undefined,
        }),
      }).then(r => r.json());
      if (r.ok) {
        const result = (r.results ?? [])[0];
        if (result && 'error' in result) setMsg(`✗ ${result.error}`);
        else {
          const annDbg = result?.annotation_debug;
          const annNote = annotateEl ? ` · annotation ${annDbg?.applied ? '✓ applied' : '✗ not applied'}` : '';
          setMsg(`✓ captured ${result?.handle ?? cid} (${kind}) in ${(r.elapsed_ms/1000).toFixed(1)}s${annNote}`);
        }
        setChannelInput('');
        refresh();
      } else setMsg(r.error || 'capture failed');
    } catch (e) { setMsg((e as Error).message); } finally { setSubmitting(false); }
  };

  // ── Batch capture ──────────────────────────────────────────────
  const captureBatch = async () => {
    const ids = batchInput.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) { setMsg('Paste channel IDs (whitespace or comma separated)'); return; }
    setSubmitting(true); setMsg(null);
    try {
      const r = await fetch('/api/admin/content-gen/yt-capture', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelIds: ids, kind, mode: mode || undefined, force, concurrency: 2 }),
      }).then(r => r.json());
      if (r.ok) {
        setMsg(`✓ ${r.ok_count}/${r.requested} captured · ${r.failed} failed · ${(r.elapsed_ms/1000).toFixed(1)}s`);
        setBatchInput('');
        refresh();
      } else setMsg(r.error || 'batch failed');
    } catch (e) { setMsg((e as Error).message); } finally { setSubmitting(false); }
  };

  // ── Retry a failed capture ─────────────────────────────────────
  const retry = async (row: ScreenRow) => {
    setMsg(null);
    try {
      const r = await fetch('/api/admin/content-gen/yt-capture', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelIds: [row.channel_id], kind: row.kind, force: true }),
      }).then(r => r.json());
      if (r.ok) setMsg(`retried ${row.channel_name ?? row.channel_id}`);
      refresh();
    } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-6 text-[#ddd]">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-white">Screen Capture</h2>
        <p className="text-xs text-[#888] mt-1">
          Captures real YouTube screens (channel page, about, videos tab, watch page) via Playwright through xgodo SOCKS5/HTTP proxies.
          Cached per (channel, kind, day) — same day = free disk hit. Drives the proof-side visuals of the listicle render.
        </p>
      </div>

      {msg && <div className="mb-4 text-xs text-[#bbb] bg-[#101010] border border-[#222] rounded px-3 py-2">{msg}</div>}

      {/* ── status counts ── */}
      <div className="flex items-center gap-2 mb-5 text-xs flex-wrap">
        {(['pending', 'capturing', 'done', 'failed'] as const).map(s => (
          <button key={s}
            onClick={() => setFilterStatus(filterStatus === s ? '' : s)}
            className={`px-2 py-1 rounded border ${STATUS_STYLE[s]} ${filterStatus === s ? 'ring-1 ring-white/30' : ''}`}>
            {s}: {counts[s] ?? 0}
          </button>
        ))}
        <span className="text-[#444]">|</span>
        {KINDS.map(k => (
          <button key={k}
            onClick={() => setFilterKind(filterKind === k ? '' : k)}
            className={`px-2 py-1 rounded border border-[#2a2a2a] text-[#aaa] hover:border-[#444] ${filterKind === k ? 'ring-1 ring-white/30 bg-[#151515]' : ''}`}>
            {k}: {kindCounts[k] ?? 0}
          </button>
        ))}
        <button onClick={refresh} disabled={loading} className="ml-auto px-3 py-1 rounded border border-[#2a2a2a] hover:border-[#444] text-[#aaa] disabled:opacity-50">
          {loading ? 'Refresh…' : 'Refresh'}
        </button>
      </div>

      {/* ── capture form ── */}
      <div className="rounded-lg border border-[#1f1f1f] bg-[#101010] p-4 mb-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-[#888] mb-1">Single channel</label>
          <div className="flex items-center gap-2">
            <input value={channelInput} onChange={e => setChannelInput(e.target.value)}
              placeholder="UC2RkPC-fzVCAdOEwc11Eesw  or  @finestexplainerr"
              className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-1.5 text-sm text-white placeholder-[#555] focus:border-blue-500/60 outline-none" />
            <button onClick={captureSingle} disabled={submitting}
              className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium">
              {submitting ? 'Capturing…' : 'Capture'}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs text-[#888] mb-1">Batch (space or comma separated channel IDs)</label>
          <div className="flex items-start gap-2">
            <textarea value={batchInput} onChange={e => setBatchInput(e.target.value)} rows={1}
              placeholder="UC2RkPC… UC6q… UCcK…"
              className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-1.5 text-xs text-white placeholder-[#555] focus:border-blue-500/60 outline-none resize-y font-mono" />
            <button onClick={captureBatch} disabled={submitting}
              className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium">
              {submitting ? '…' : 'Batch'}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap lg:col-span-2">
          <label className="text-xs text-[#888]">Kind</label>
          <select value={kind} onChange={e => setKind(e.target.value as Kind)} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white outline-none">
            {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          <label className="text-xs text-[#888]">Mode</label>
          <select value={mode} onChange={e => setMode(e.target.value as CaptureMode | '')} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white outline-none" title="Empty = auto (scroll_record for videos_tab, static for the rest)">
            <option value="">auto</option>
            <option value="static">static (PNG)</option>
            <option value="scroll_record">scroll_record (WebM)</option>
          </select>
          {kind === 'watch_page' && (
            <>
              <label className="text-xs text-[#888]">watchVideoId</label>
              <input value={watchVideoId} onChange={e => setWatchVideoId(e.target.value)} placeholder="zzH0tiIoBBA"
                className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white placeholder-[#555] outline-none w-32 font-mono" />
            </>
          )}
          <span className="text-[#333]">|</span>
          <label className="text-xs text-[#888]" title="DOM-injected highlight before screenshot. Bakes a yellow ring into the PNG.">
            Annotate
          </label>
          <select value={annotateEl} onChange={e => setAnnotateEl(e.target.value as typeof annotateEl)} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white outline-none">
            <option value="">none</option>
            <option value="subscriber_count">subscriber_count</option>
            <option value="video_count">video_count</option>
            <option value="total_views">total_views</option>
            <option value="joined_date">joined_date</option>
            <option value="view_count">view_count</option>
          </select>
          {annotateEl && (
            <select value={annotateStyle} onChange={e => setAnnotateStyle(e.target.value as typeof annotateStyle)} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white outline-none">
              <option value="yellow_circle">yellow_circle</option>
              <option value="yellow_ring">yellow_ring</option>
              <option value="yellow_box">yellow_box</option>
              <option value="yellow_highlight">yellow_highlight</option>
            </select>
          )}
          <label className="text-xs text-[#888] flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} className="accent-blue-500" />
            Force re-capture (ignore today&apos;s cache)
          </label>
          <label className="text-xs text-[#888] flex items-center gap-1.5 cursor-pointer ml-auto">
            <input type="checkbox" checked={showBboxes} onChange={e => setShowBboxes(e.target.checked)} className="accent-yellow-500" />
            Show bbox overlays
          </label>
        </div>
      </div>

      {/* ── gallery ── */}
      {rows.length === 0 ? (
        <div className="text-center text-[#666] text-sm py-16 border border-dashed border-[#222] rounded-lg">
          No captures yet. Try a single capture above to get started.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {rows.map(r => (
            <div key={r.id} className="rounded-lg border border-[#1f1f1f] bg-[#101010] overflow-hidden flex flex-col">
              <div className="aspect-video bg-[#0a0a0a] flex items-center justify-center relative overflow-hidden">
                {r.file_url ? (
                  r.asset_kind === 'video' ? (
                    <video
                      src={r.file_url} controls preload="metadata" muted playsInline
                      className="w-full h-full object-contain"
                      aria-label={r.channel_name ?? r.channel_id}
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.file_url} alt={r.channel_name ?? r.channel_id} className="w-full h-full object-contain" />
                  )
                ) : (
                  <span className={`text-[11px] px-2 py-1 rounded border ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                )}
                {/* Bbox overlays — scaled from page_width to displayed width.
                    Each rect is positioned absolutely + labeled.
                    Only shown for image captures (video coords drift per frame). */}
                {showBboxes && r.asset_kind === 'image' && r.page_width && r.page_height && r.bboxes_jsonb && Object.keys(r.bboxes_jsonb).length > 0 && (
                  <div className="absolute inset-0 pointer-events-none">
                    {Object.entries(r.bboxes_jsonb).map(([name, b]) => (
                      <div key={name}
                        className="absolute border border-yellow-400/80 bg-yellow-400/10"
                        style={{
                          left: `${(b.x / r.page_width!) * 100}%`,
                          top: `${(b.y / r.page_height!) * 100}%`,
                          width: `${(b.w / r.page_width!) * 100}%`,
                          height: `${(b.h / r.page_height!) * 100}%`,
                        }}
                      >
                        <span className="absolute -top-3 left-0 text-[8px] px-1 bg-yellow-400/90 text-black font-medium whitespace-nowrap rounded">
                          {name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <span className={`absolute top-1.5 left-1.5 text-[10px] px-1.5 py-0.5 rounded border ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                <span className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded border border-[#2a2a2a] bg-black/60 text-[#bbb]">{r.kind}</span>
                {r.asset_kind === 'video' && (
                  <span className="absolute bottom-1.5 left-1.5 text-[10px] px-1.5 py-0.5 rounded border border-purple-500/40 bg-purple-500/15 text-purple-300">
                    🎬 {r.capture_mode}{r.duration_s ? ` · ${r.duration_s.toFixed(1)}s` : ''}
                  </span>
                )}
              </div>
              <div className="p-2.5 flex-1 flex flex-col gap-1">
                <div className="flex items-baseline gap-1.5">
                  <p className="text-xs font-medium text-white truncate flex-1" title={r.channel_name ?? r.channel_id}>
                    {r.channel_name ?? r.channel_id}
                  </p>
                  {r.handle && <span className="text-[10px] text-[#666] shrink-0">{r.handle}</span>}
                </div>
                <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-[#888] hover:text-blue-400 truncate" title={r.url}>{r.url}</a>
                <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-[#666] mt-1">
                  <span className="text-[#888]">{r.date_bucket}</span><span>·</span>
                  <span>{fmtBytes(r.bytes)}</span>
                  {r.page_width && <><span>·</span><span>{r.page_width}×{r.page_height}</span></>}
                  {r.proxy_country && <><span>·</span><span title={r.proxy_device ?? ''}>proxy {r.proxy_country.toUpperCase()}</span></>}
                  {r.bboxes_jsonb && Object.keys(r.bboxes_jsonb).length > 0 && (
                    <><span>·</span><span className="text-yellow-400/80" title={Object.keys(r.bboxes_jsonb).join(', ')}>
                      🟡 {Object.keys(r.bboxes_jsonb).length} bbox{Object.keys(r.bboxes_jsonb).length === 1 ? '' : 'es'}
                    </span></>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-[#666]">
                  <span>{r.status === 'done' ? `done ${fmtTime(r.finished_at)}` : r.status === 'capturing' ? `started ${fmtTime(r.started_at)}` : fmtTime(r.updated_at)}</span>
                </div>
                {r.error && <p className="text-[10px] text-red-400/90 line-clamp-2 mt-1" title={r.error}>{r.error}</p>}
                {(r.status === 'failed' || r.status === 'done') && (
                  <div className="flex gap-1.5 mt-1.5 pt-1.5 border-t border-[#1a1a1a]">
                    {r.file_url && <a href={r.file_url} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] px-2 py-0.5 rounded border border-[#2a2a2a] text-[#aaa] hover:text-white hover:border-[#444]">
                      View full
                    </a>}
                    <button onClick={() => retry(r)}
                      className="text-[10px] px-2 py-0.5 rounded border border-blue-500/30 text-blue-300 hover:border-blue-500">
                      Re-capture
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
