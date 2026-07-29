'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * rofe.ai landing — a live wall of the broadcast posts we push to Telegram.
 * Masonry grid of Telegram-styled cards (4 columns on desktop), infinite scroll
 * backwards through the archive, and a poll that prepends new posts as they go
 * out. Data: /api/broadcast-feed (public).
 *
 * Replaced the old marketing page (hero + feature grid) 2026-07-28 — the feed
 * IS the pitch: real channels we caught early, with their growth story.
 */

interface Post {
  id: number;
  kind: string;
  postedAt: string;
  channelId: string | null;
  channelName: string | null;
  channelAvatar: string | null;
  subscribers: number | null;
  channelUrl: string | null;
  html: string;
  thumbs: string[];
}

const KIND_LABEL: Record<string, { label: string; cls: string }> = {
  growth_story:       { label: 'Growth story',  cls: 'text-emerald-300 bg-emerald-500/10' },
  growth:             { label: 'Growth story',  cls: 'text-emerald-300 bg-emerald-500/10' },
  pulse:              { label: 'Mining pulse',  cls: 'text-sky-300 bg-sky-500/10' },
  eligible_spotlight: { label: 'Spotlight',     cls: 'text-amber-300 bg-amber-500/10' },
  spotlight:          { label: 'Spotlight',     cls: 'text-amber-300 bg-amber-500/10' },
};

function fmtSubs(n: number | null): string {
  if (n == null) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M subs';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K subs';
  return `${n} subs`;
}

function timeAgo(iso: string): string {
  const t = new Date(iso.replace(' ', 'T')).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function PostCard({ p }: { p: Post }) {
  const kind = KIND_LABEL[p.kind] ?? { label: p.kind, cls: 'text-[#888] bg-[#1f1f1f]' };
  const initial = (p.channelName || 'R').trim().charAt(0).toUpperCase();
  return (
    <article className="break-inside-avoid mb-4 rounded-2xl bg-[#17212b] border border-[#0f1620] overflow-hidden shadow-lg shadow-black/30">
      {/* sender row — telegram-ish */}
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
        <div className="w-9 h-9 rounded-full bg-[#2b5278] overflow-hidden flex-shrink-0 flex items-center justify-center">
          {p.channelAvatar
            ? <img src={p.channelAvatar} alt="" className="w-full h-full object-cover" loading="lazy" />
            : <span className="text-white text-sm font-semibold">{initial}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[#e9edf1] truncate">{p.channelName || 'rofe.ai'}</div>
          <div className="text-[11px] text-[#7d8e9e]">{fmtSubs(p.subscribers)}</div>
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${kind.cls}`}>{kind.label}</span>
      </div>

      {/* thumbnails — the imagery the telegram cards were built from */}
      {p.thumbs.length > 0 && (
        <div className={`grid gap-0.5 px-0.5 ${p.thumbs.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {p.thumbs.slice(0, 4).map((t, i) => (
            <div key={i} className="relative bg-[#0f1620] overflow-hidden" style={{ aspectRatio: '16/9' }}>
              {/* YouTube maxresdefault 404s on some uploads — drop the tile rather
                  than leave an empty dark box in the card. */}
              <img src={t} alt="" className="w-full h-full object-cover" loading="lazy"
                   onError={e => { const el = e.currentTarget.parentElement; if (el) el.style.display = 'none'; }} />
            </div>
          ))}
        </div>
      )}

      {/* message body */}
      <div
        className="px-4 py-3 text-[13px] leading-[1.55] text-[#e9edf1] tg-body"
        dangerouslySetInnerHTML={{ __html: p.html }}
      />

      <div className="px-4 pb-3 flex items-center justify-between gap-2">
        <span className="text-[11px] text-[#6d7f8f]">{timeAgo(p.postedAt)}</span>
        {p.channelUrl && (
          <a href={p.channelUrl} target="_blank" rel="noopener noreferrer"
             className="text-[11px] text-[#6ab3f3] hover:text-[#8ecbff] transition">
            View channel ↗
          </a>
        )}
      </div>
    </article>
  );
}

export function LandingPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [newestId, setNewestId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [initial, setInitial] = useState(true);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const cursorRef = useRef<number | null>(null);
  const doneRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const qs = cursorRef.current ? `?before=${cursorRef.current}&limit=24` : '?limit=24';
      const r = await fetch(`/api/broadcast-feed${qs}`);
      const d = await r.json();
      const batch: Post[] = d.posts || [];
      setPosts(prev => {
        const seen = new Set(prev.map(x => x.id));
        return [...prev, ...batch.filter(b => !seen.has(b.id))];
      });
      setNewestId(prev => (prev == null && d.newestId ? d.newestId : prev));
      cursorRef.current = d.nextCursor;
      setCursor(d.nextCursor);
      if (!d.nextCursor || batch.length === 0) { doneRef.current = true; setDone(true); }
    } catch { /* leave the sentinel armed; a later scroll retries */ }
    finally { loadingRef.current = false; setLoading(false); setInitial(false); }
  }, []);

  // first page
  useEffect(() => { loadMore(); }, [loadMore]);

  // infinite scroll
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) loadMore();
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // live poll — prepend posts published since we loaded
  useEffect(() => {
    if (newestId == null) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/broadcast-feed?after=${newestId}&limit=24`);
        const d = await r.json();
        const fresh: Post[] = d.posts || [];
        if (fresh.length > 0) {
          setPosts(prev => {
            const seen = new Set(prev.map(x => x.id));
            return [...fresh.filter(f => !seen.has(f.id)), ...prev];
          });
          setNewestId(d.newestId);
        }
      } catch { /* transient — next tick retries */ }
    }, 45_000);
    return () => clearInterval(t);
  }, [newestId]);

  return (
    <div className="min-h-screen bg-[#0e1621]">
      <style>{`
        /* Telegram payloads separate lines with \n, which HTML collapses — without
           this the whole post renders as one run-on blob instead of the
           line-per-stat layout it has in Telegram. */
        .tg-body { white-space: pre-wrap; word-break: break-word; }
        .tg-body b, .tg-body strong { color: #fff; font-weight: 600; }
        .tg-body a { color: #6ab3f3; text-decoration: none; }
        .tg-body a:hover { text-decoration: underline; }
        .tg-body code { background: #0f1620; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
      `}</style>

      <header className="sticky top-0 z-10 backdrop-blur bg-[#0e1621]/85 border-b border-[#1b2735]">
        <div className="max-w-[1600px] mx-auto px-5 py-3.5 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center text-white font-bold text-sm">R</div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-white leading-tight">rofe.ai</div>
            <div className="text-[11px] text-[#7d8e9e] leading-tight">YouTube channels caught early — live feed</div>
          </div>
          <span className="ml-2 hidden sm:flex items-center gap-1.5 text-[11px] text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> live
          </span>
          <div className="ml-auto flex items-center gap-4">
            <a href="/api/auth/signin" className="text-[13px] text-[#9fb2c4] hover:text-white transition">Sign in</a>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-4 py-6">
        {initial && posts.length === 0 ? (
          <div className="text-center text-[#6d7f8f] py-24 text-sm">Loading feed…</div>
        ) : posts.length === 0 ? (
          <div className="text-center text-[#6d7f8f] py-24 text-sm">No posts yet.</div>
        ) : (
          <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4">
            {posts.map(p => <PostCard key={p.id} p={p} />)}
          </div>
        )}
        <div ref={sentinel} className="h-10" />
        {loading && !initial && <div className="text-center text-[#6d7f8f] py-4 text-sm">Loading more…</div>}
        {done && posts.length > 0 && <div className="text-center text-[#4d5d6b] py-6 text-xs">— end of feed —</div>}
      </main>
    </div>
  );
}

export default LandingPage;
