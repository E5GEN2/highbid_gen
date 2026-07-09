'use client';

import React from 'react';

interface Candidate {
  id: number; url: string; title: string; thumbnail: string;
  viewCount: number; channelName: string; peerOutlierScore: number | null;
  nicheLabel: string; l1Id: number; l1Label: string;
}
interface Bend {
  id: number; bentTitle: string | null; thumbnailPrompt: string | null;
  status: string; error: string | null; thumbnailUrl: string | null;
  parents: { a: { title: string; thumb: string; niche: string }; b: { title: string; thumb: string; niche: string } };
}
interface ParentVideo {
  videoId: number; url: string | null; title: string; thumb: string; niche: string;
  viewCount: number | null; channelName: string | null; subscriberCount: number | null; peerOutlierScore: number | null;
}
interface BendDetail extends Omit<Bend, 'parents'> { parents: { a: ParentVideo; b: ParentVideo } }

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export default function NicheBending() {
  const [bends, setBends] = React.useState<Bend[]>([]);
  const [feedLoading, setFeedLoading] = React.useState(true);
  const [showMaker, setShowMaker] = React.useState(false);
  const [openId, setOpenId] = React.useState<number | null>(null);

  const loadFeed = React.useCallback(async () => {
    try {
      const r = await fetch('/api/niche-bend/list?limit=60');
      const d = await r.json();
      setBends(d.bends || []);
    } catch { /* keep old */ }
    setFeedLoading(false);
  }, []);

  React.useEffect(() => { loadFeed(); }, [loadFeed]);
  // Poll while anything is still rendering so thumbnails fill in live.
  React.useEffect(() => {
    if (!bends.some(b => b.status === 'rendering')) return;
    const t = setInterval(loadFeed, 5000);
    return () => clearInterval(t);
  }, [bends, loadFeed]);

  return (
    <div className="p-8 max-w-[1500px]">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Niche Bending</h1>
          <p className="text-[#888] text-sm mt-1">
            Fresh video ideas, auto-baked by fusing two proven outliers from <span className="text-amber-400">different</span> niches.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={loadFeed} className="px-3 py-2 bg-[#141414] border border-[#2a2a2a] text-white text-sm rounded-xl hover:border-[#555] transition">Refresh</button>
          <button onClick={() => setShowMaker(s => !s)}
            className={`px-4 py-2 text-sm font-medium rounded-xl transition ${showMaker ? 'bg-[#141414] border border-amber-500 text-amber-400' : 'bg-amber-500 text-black hover:bg-amber-400'}`}>
            {showMaker ? 'Close maker' : '+ Make your own'}
          </button>
        </div>
      </div>

      {showMaker && <Maker onDone={loadFeed} />}

      {/* Feed */}
      {feedLoading ? (
        <FeedSkeleton />
      ) : bends.length === 0 ? (
        <div className="text-center py-20 text-[#666]">
          <div className="text-lg mb-1">No baked ideas yet.</div>
          <div className="text-sm">The background baker fills this in once enabled — or hit <span className="text-amber-400">Make your own</span> to bend a pair now.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {bends.map(b => <BendCard key={b.id} b={b} onOpen={() => setOpenId(b.id)} />)}
        </div>
      )}

      {openId != null && <BendModal id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function BendModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [d, setD] = React.useState<BendDetail | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let live = true;
    (async () => {
      try { const r = await fetch(`/api/niche-bend/${id}`); const j = await r.json(); if (live) setD(j); }
      catch { /* ignore */ }
      if (live) setLoading(false);
    })();
    return () => { live = false; };
  }, [id]);

  // close on Escape
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-4xl bg-[#0e0e0e] border border-[#2a2a2a] rounded-2xl overflow-hidden my-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#1f1f1f]">
          <span className="text-[10px] uppercase tracking-wide text-amber-400/80">Bent idea · fused from two proven outliers</span>
          <button onClick={onClose} className="text-[#888] hover:text-white text-lg leading-none">✕</button>
        </div>

        {loading || !d ? (
          <div className="p-10 text-center text-[#666] text-sm animate-pulse">loading…</div>
        ) : (
          <div className="p-5">
            {/* synthetic idea */}
            <div className="rounded-xl overflow-hidden border border-amber-500/30 bg-[#0a0a0a] mb-5">
              <div className="aspect-video bg-[#0a0a0a] flex items-center justify-center">
                {d.thumbnailUrl
                  ? <ThumbImg src={d.thumbnailUrl} />
                  : <div className="text-[#666] text-xs animate-pulse">baking thumbnail…</div>}
              </div>
              <div className="p-4">
                <div className="text-[10px] uppercase tracking-wide text-amber-400/80 mb-1">Synthetic idea</div>
                <div className="text-white font-bold text-lg leading-snug">{d.bentTitle}</div>
              </div>
            </div>

            <div className="text-[11px] uppercase tracking-wide text-[#777] mb-2">Fused from</div>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-3 items-stretch">
              <ParentDetail p={d.parents.a} />
              <div className="flex items-center justify-center text-amber-500 text-2xl font-bold">×</div>
              <ParentDetail p={d.parents.b} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ParentDetail({ p }: { p: ParentVideo }) {
  return (
    <div className="bg-[#141414] border border-[#222] rounded-xl overflow-hidden flex flex-col">
      <a href={p.url || undefined} target="_blank" rel="noreferrer" className="relative block aspect-video bg-[#0a0a0a] group">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={p.thumb} alt="" className="w-full h-full object-cover" />
        {p.peerOutlierScore != null && (
          <span className="absolute top-2 right-2 text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-black/70 text-emerald-400">{p.peerOutlierScore.toFixed(1)}×</span>
        )}
        {p.url && <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition bg-black/40 text-white text-xs font-medium">Watch on YouTube ↗</span>}
      </a>
      <div className="p-3 flex-1 flex flex-col gap-1.5">
        <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-300 self-start">{p.niche}</span>
        <div className="text-sm text-white leading-snug line-clamp-2">{p.title}</div>
        <div className="mt-auto flex items-center justify-between text-[11px] text-[#888]">
          <span className="truncate max-w-[60%]">{p.channelName || '—'}</span>
          <span>{p.viewCount != null ? fmt(p.viewCount) + ' views' : ''}</span>
        </div>
      </div>
    </div>
  );
}

// Self-healing thumbnail: retries with a cache-bust on load error so a transient
// failure (deploy blip, render→done race) never leaves a permanently-broken card.
function ThumbImg({ src }: { src: string }) {
  const [attempt, setAttempt] = React.useState(0);
  const [dead, setDead] = React.useState(false);
  const url = attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}r=${attempt}`;
  if (dead) return <div className="text-red-400/60 text-xs">thumbnail unavailable</div>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className="w-full h-full object-cover"
      onError={() => {
        if (attempt < 6) setTimeout(() => setAttempt(a => a + 1), 1200 * (attempt + 1));
        else setDead(true);
      }} />
  );
}

function BendCard({ b, onOpen }: { b: Bend; onOpen: () => void }) {
  return (
    <div onClick={onOpen}
      className="bg-[#111] border border-[#1f1f1f] rounded-2xl overflow-hidden hover:border-amber-500/40 transition cursor-pointer">
      {/* synthetic thumbnail */}
      <div className="aspect-video bg-[#0a0a0a] flex items-center justify-center">
        {b.thumbnailUrl
          ? <ThumbImg src={b.thumbnailUrl} />
          : b.status === 'error'
            ? <div className="text-red-400/70 text-xs">thumbnail failed</div>
            : <div className="text-[#666] text-xs animate-pulse">baking thumbnail…</div>}
      </div>
      <div className="p-4">
        <div className="text-[10px] uppercase tracking-wide text-amber-400/80 mb-1">Synthetic idea</div>
        <div className="text-white font-semibold leading-snug mb-3">{b.bentTitle || '…'}</div>
        {/* parents */}
        <div className="flex items-center gap-2 text-[11px] text-[#888]">
          <Parent p={b.parents.a} />
          <span className="text-amber-500 font-bold">×</span>
          <Parent p={b.parents.b} />
        </div>
      </div>
    </div>
  );
}

function Parent({ p }: { p: { title: string; thumb: string; niche: string } }) {
  return (
    <div className="flex items-center gap-1.5 min-w-0 flex-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.thumb} alt="" className="w-9 h-5 object-cover rounded shrink-0" />
      <span className="truncate" title={`${p.niche} — ${p.title}`}>{p.niche}</span>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="bg-[#111] border border-[#1f1f1f] rounded-2xl overflow-hidden animate-pulse">
          <div className="aspect-video bg-[#1a1a1a]" />
          <div className="p-4 space-y-2"><div className="h-4 bg-[#1a1a1a] rounded w-3/4" /><div className="h-3 bg-[#151515] rounded w-1/2" /></div>
        </div>
      ))}
    </div>
  );
}

// ── "Make your own" — on-demand picker (candidate grid + A×B + surprise) ──
function Maker({ onDone }: { onDone: () => void }) {
  const [cands, setCands] = React.useState<Candidate[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [aId, setAId] = React.useState<number | null>(null);
  const [bId, setBId] = React.useState<number | null>(null);
  const [notice, setNotice] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try { const r = await fetch('/api/niche-bend/candidates?limit=90'); const d = await r.json(); setCands(d.candidates || []); }
      catch { setCands([]); }
      setLoading(false);
    })();
  }, []);

  const byId = React.useMemo(() => new Map(cands.map(c => [c.id, c])), [cands]);
  const a = aId != null ? byId.get(aId) : undefined;
  const b = bId != null ? byId.get(bId) : undefined;
  const distinctOk = a && b && a.l1Id !== b.l1Id;

  function toggle(c: Candidate) {
    setNotice('');
    if (aId === c.id) return setAId(null);
    if (bId === c.id) return setBId(null);
    const other = aId == null ? b : a;
    if (other && other.l1Id === c.l1Id) return setNotice('Pick a video from a DIFFERENT top-level niche.');
    if (aId == null) setAId(c.id); else if (bId == null) setBId(c.id); else setAId(c.id);
  }
  function surprise() {
    setNotice('');
    if (cands.length < 2) return;
    const pa = cands[0]; const pb = cands.find(c => c.l1Id !== pa.l1Id);
    if (!pb) return setNotice('Not enough distinct niches loaded.');
    setAId(pa.id); setBId(pb.id);
  }
  async function run() {
    if (!a || !b || !distinctOk || busy) return;
    setBusy(true); setNotice('');
    try {
      const r = await fetch('/api/niche-bend/synthesize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoAId: a.id, videoBId: b.id }),
      });
      const d = await r.json();
      if (!r.ok) { setNotice(d.error || 'bend failed'); setBusy(false); return; }
      setAId(null); setBId(null);
      setNotice('Baking… it will appear in the feed above shortly.');
      onDone();
      setBusy(false);
    } catch (e) { setNotice((e as Error).message); setBusy(false); }
  }

  return (
    <div className="mb-8 bg-[#0d0d0d] border border-[#222] rounded-2xl p-4">
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <Slot label="A" cand={a} onClear={() => setAId(null)} />
        <span className="text-amber-500 text-xl font-bold">×</span>
        <Slot label="B" cand={b} onClear={() => setBId(null)} />
        <button onClick={surprise} className="px-4 py-2 bg-[#141414] border border-[#2a2a2a] text-white text-sm rounded-xl hover:border-amber-500 transition">🎲 Surprise me</button>
        <button onClick={run} disabled={!distinctOk || busy}
          className={`px-5 py-2 text-sm font-medium rounded-xl transition ${distinctOk && !busy ? 'bg-amber-500 text-black hover:bg-amber-400' : 'bg-[#1a1a1a] text-[#555] cursor-not-allowed'}`}>
          {busy ? 'Bending…' : 'Bend →'}
        </button>
        {notice && <span className="text-xs text-amber-300">{notice}</span>}
      </div>
      {loading ? (
        <div className="text-xs text-[#666]">loading candidates…</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2 max-h-[420px] overflow-y-auto pr-1">
          {cands.map(c => {
            const sel = aId === c.id ? 'A' : bId === c.id ? 'B' : null;
            return (
              <button key={c.id} onClick={() => toggle(c)}
                className={`text-left bg-[#141414] border rounded-lg overflow-hidden transition ${sel ? 'border-amber-500 ring-1 ring-amber-500' : 'border-[#1f1f1f] hover:border-[#3a3a3a]'}`}>
                <div className="relative aspect-video bg-[#0a0a0a]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={c.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                  {sel && <span className="absolute top-1 left-1 w-5 h-5 rounded-full bg-amber-500 text-black text-[11px] font-bold flex items-center justify-center">{sel}</span>}
                  {c.peerOutlierScore != null && <span className="absolute top-1 right-1 text-[10px] font-semibold px-1 py-0.5 rounded bg-black/70 text-emerald-400">{c.peerOutlierScore.toFixed(0)}×</span>}
                </div>
                <div className="p-1.5">
                  <div className="text-[11px] text-white leading-tight line-clamp-2 mb-1">{c.title}</div>
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="px-1 py-0.5 rounded bg-amber-500/10 text-amber-300 truncate max-w-[70%]">{c.l1Label}</span>
                    <span className="text-[#777]">{fmt(c.viewCount)}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Slot({ label, cand, onClear }: { label: string; cand?: Candidate; onClear: () => void }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border ${cand ? 'border-amber-500/50 bg-amber-500/5' : 'border-dashed border-[#333] bg-[#111]'}`}>
      <span className="w-5 h-5 rounded-full bg-amber-500 text-black text-xs font-bold flex items-center justify-center">{label}</span>
      {cand ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cand.thumbnail} alt="" className="w-10 h-6 object-cover rounded" />
          <span className="text-xs text-white max-w-[140px] truncate">{cand.l1Label}</span>
          <button onClick={onClear} className="text-[#777] hover:text-white text-xs">✕</button>
        </>
      ) : <span className="text-xs text-[#666]">pick a video</span>}
    </div>
  );
}
