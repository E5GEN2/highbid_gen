'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { fmtYT } from '@/lib/format';
import { OpportunityIndicators, computeIndicators } from './OpportunityIndicators';
import { ChannelScatter, type ScatterDot, type ScatterVideo } from './ChannelScatter';
import { DistBars, makeSubsBuckets, makeViewsBuckets } from './DistBars';

/**
 * SimilarModal — summonable pop-up with Videos + Insights tabs.
 *
 * The "Similar" button anywhere on the site calls openSimilar(videoId), which
 * opens this modal without navigating. Dismissing (Esc, X, or backdrop click)
 * returns the user to exactly the scroll/scatter position they were in.
 * Clicking "Similar" on a nested video swaps the modal's videoId so the stack
 * never grows deeper than one.
 *
 * A permanent URL view still exists at /niche/similar/[videoId] for permalinks.
 */

interface SimilarVideo {
  id: number;
  title: string;
  url: string;
  viewCount: number;
  channelName: string;
  postedAt: string | null;
  postedDate: string | null;
  score: number;
  subscriberCount: number;
  likeCount: number;
  commentCount: number;
  topComment: string | null;
  thumbnail: string | null;
  keyword: string | null;
  channelCreatedAt: string | null;
  similarity: number;
}

interface SimilarSource { id: number; title: string; keyword: string; }

/* ── Provider + hook ─────────────────────────────────────────── */

interface ModalCtx {
  openSimilar: (videoId: number) => void;
  close: () => void;
  activeId: number | null;
}
const Ctx = createContext<ModalCtx | null>(null);
export function useSimilarModal() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSimilarModal must be used within SimilarModalProvider');
  return ctx;
}

export function SimilarModalProvider({ children }: { children: React.ReactNode }) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const openSimilar = useCallback((id: number) => setActiveId(id), []);
  const close = useCallback(() => setActiveId(null), []);

  // Close on Escape
  useEffect(() => {
    if (activeId === null) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [activeId, close]);

  // Prevent body scroll while open
  useEffect(() => {
    if (activeId === null) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [activeId]);

  return (
    <Ctx.Provider value={{ openSimilar, close, activeId }}>
      {children}
      {activeId !== null && <SimilarModalBody videoId={activeId} onClose={close} onSwitchVideo={openSimilar} />}
    </Ctx.Provider>
  );
}

/* ── Modal body ──────────────────────────────────────────────── */

type Tab = 'videos' | 'insights';

function SimilarModalBody({
  videoId, onClose, onSwitchVideo,
}: {
  videoId: number;
  onClose: () => void;
  onSwitchVideo: (id: number) => void;
}) {
  const [source, setSource] = useState<SimilarSource | null>(null);
  const [all, setAll] = useState<SimilarVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minSimilarity, setMinSimilarity] = useState(0.7);
  const [tab, setTab] = useState<Tab>('videos');
  const [sort, setSort] = useState<'similarity' | 'views' | 'score' | 'newest' | 'likes'>('similarity');

  // Which embedding space the similarity runs against. Empty = user hasn't
  // picked yet → we show the basis picker instead of fetching.
  type Basis = '' | 'title_v2' | 'thumbnail_v2' | 'combined';
  const [basis, setBasis] = useState<Basis>('');

  // Reset state on videoId change so the picker shows for the new video
  useEffect(() => {
    setBasis('');
    setAll([]);
    setSource(null);
    setError(null);
    setLoading(false);
  }, [videoId]);

  // Fetch only once a basis is chosen
  useEffect(() => {
    if (!basis) return;
    setLoading(true);
    setError(null);
    setSource(null);
    setAll([]);
    const qs = new URLSearchParams({ videoId: String(videoId), limit: '500', minSimilarity: '0', source: basis });
    fetch(`/api/niche-spy/similar?${qs}`)
      .then(r => r.json())
      .then((d: { source?: SimilarSource; similar?: SimilarVideo[]; error?: string; message?: string }) => {
        if (d.error) throw new Error(d.error);
        setSource(d.source || null);
        setAll(d.similar || []);
        if ((d.similar || []).length === 0 && d.message) setError(d.message);
      })
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [videoId, basis]);

  const filtered = useMemo(() => all.filter(v => v.similarity >= minSimilarity), [all, minSimilarity]);
  // Insights are score-filtered so numbers are comparable with the keyword Insights page
  const scored = useMemo(() => filtered.filter(v => (v.score || 0) >= 80), [filtered]);

  // Live opportunity indicators — recompute on every minSimilarity change
  const indicators = useMemo(() => {
    const dots = scored.map(v => ({
      s: v.subscriberCount || 0,
      v: v.viewCount || 0,
      a: v.channelCreatedAt
        ? Math.floor((Date.now() - new Date(v.channelCreatedAt).getTime()) / 86400000)
        : null,
    }));
    return computeIndicators(dots);
  }, [scored]);

  const sortedGrid = useMemo(() => {
    const arr = [...filtered];
    switch (sort) {
      case 'views':  return arr.sort((a, b) => b.viewCount - a.viewCount);
      case 'score':  return arr.sort((a, b) => b.score - a.score);
      case 'newest': return arr.sort((a, b) => new Date(b.postedAt || 0).getTime() - new Date(a.postedAt || 0).getTime());
      case 'likes':  return arr.sort((a, b) => b.likeCount - a.likeCount);
      default:       return arr.sort((a, b) => b.similarity - a.similarity);
    }
  }, [filtered, sort]);

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] flex items-start justify-center pt-10 px-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-[#111] border border-[#1f1f1f] rounded-2xl w-full max-w-6xl mb-10"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#1f1f1f] flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Semantic cluster</div>
            <h3 className="text-lg font-bold text-white">
              {loading
                ? <span className="inline-block h-5 w-80 bg-[#1f1f1f] rounded animate-pulse" />
                : source
                  ? <>Similar to: <span className="text-purple-400">{source.title}</span></>
                  : <span className="text-[#888]">Video not found</span>}
            </h3>
            {!loading && (
              <div className="flex items-center gap-3 mt-1 text-xs text-[#888]">
                <span>{filtered.length} of {all.length} match · {scored.length} at score ≥ 80</span>
                {source?.keyword && (
                  <Link
                    href={`/niche/niches/${encodeURIComponent(source.keyword)}/videos`}
                    className="text-purple-400 hover:text-purple-300"
                    onClick={onClose}
                  >
                    from &quot;{source.keyword}&quot;
                  </Link>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-[#888]">Based on:</label>
            <select
              value={basis}
              onChange={e => setBasis(e.target.value as Basis)}
              disabled={loading || !basis}
              className="bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded px-2 py-1 focus:outline-none focus:border-amber-500 disabled:opacity-50"
              title="Which embedding space to compute similarity against"
            >
              {!basis && <option value="">— pick below —</option>}
              <option value="title_v2">Title</option>
              <option value="thumbnail_v2">Thumbnail</option>
              <option value="combined">Both (avg)</option>
            </select>
            <label className="text-xs text-[#888] ml-2">Min match:</label>
            <div className="flex items-center bg-[#0a0a0a] border border-[#1f1f1f] rounded focus-within:border-amber-500">
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={Math.round(minSimilarity * 100)}
                onChange={e => {
                  const raw = parseFloat(e.target.value);
                  const pct = isNaN(raw) ? 0 : Math.max(0, Math.min(100, raw));
                  setMinSimilarity(pct / 100);
                }}
                disabled={loading}
                className="w-14 bg-transparent text-white text-xs px-2 py-1 focus:outline-none disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <span className="text-xs text-[#666] pr-2">%</span>
            </div>
            <button onClick={onClose} className="text-[#888] hover:text-white ml-1">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tab selector + live opportunity pills */}
        <div className="px-6 pt-3 border-b border-[#1f1f1f] flex items-center justify-between gap-4 flex-wrap">
          <div className="flex gap-0">
            {([
              { value: 'videos', label: `Videos (${filtered.length})` },
              { value: 'insights', label: 'Insights' },
            ] as const).map(t => (
              <button
                key={t.value}
                onClick={() => setTab(t.value)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
                  tab === t.value
                    ? 'text-white border-amber-500'
                    : 'text-[#888] border-transparent hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {!loading && (
            <div className="pb-2">
              <ModalIndicatorPills
                disabled={scored.length < 10}
                nos={indicators.nos}
                nosDisplay={indicators.nosDisplay}
                topLeftPct={indicators.topLeftPct}
                newcomerRate={indicators.newcomerRate}
                lowSubCeiling={indicators.lowSubCeiling}
                sampleSize={scored.length}
              />
            </div>
          )}
        </div>

        {/* Body */}
        <div className="p-6">
          {!basis ? (
            <BasisPicker onPick={setBasis} />
          ) : (
            <>
              {error && (
                <div className="bg-red-900/20 border border-red-800/40 rounded-xl px-5 py-4 text-red-400">
                  Couldn&apos;t load: {error}
                </div>
              )}

              {loading && !error && (
                <div className="text-center py-12 text-[#888]">Finding similar videos...</div>
              )}

              {!loading && !error && tab === 'videos' && (
                <VideosTab
                  sortedGrid={sortedGrid}
                  sort={sort}
                  setSort={setSort}
                  onOpenSimilar={onSwitchVideo}
                />
              )}

              {!loading && !error && tab === 'insights' && (
                <InsightsTab scored={scored} filteredCount={filtered.length} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Tabs ────────────────────────────────────────────────────── */

function VideosTab({
  sortedGrid, sort, setSort, onOpenSimilar,
}: {
  sortedGrid: SimilarVideo[];
  sort: 'similarity' | 'views' | 'score' | 'newest' | 'likes';
  setSort: (v: 'similarity' | 'views' | 'score' | 'newest' | 'likes') => void;
  onOpenSimilar: (id: number) => void;
}) {
  if (sortedGrid.length === 0) {
    return <div className="text-center py-12 text-[#666]">No matches at this threshold. Lower the min match above.</div>;
  }
  return (
    <>
      <div className="flex gap-2 flex-wrap mb-4">
        {([
          { value: 'similarity', label: 'Best Match' },
          { value: 'views', label: 'Most Views' },
          { value: 'score', label: 'Highest Score' },
          { value: 'newest', label: 'Newest' },
          { value: 'likes', label: 'Most Likes' },
        ] as const).map(opt => (
          <button
            key={opt.value}
            onClick={() => setSort(opt.value)}
            className={`px-3 py-1 rounded-full text-xs transition ${
              sort === opt.value ? 'bg-white text-black font-medium' : 'text-[#888] border border-[#333] hover:border-[#555]'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sortedGrid.map(v => {
          const vidMatch = (v.url || '').match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
          const thumb = v.thumbnail || (vidMatch ? `https://img.youtube.com/vi/${vidMatch[1]}/hqdefault.jpg` : '');
          return (
            <div key={v.id} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden">
              <div className="relative aspect-video bg-[#0a0a0a]">
                {thumb && <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />}
                <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'}`}>
                  ⚡ {v.score}
                </div>
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs font-bold bg-purple-600 text-white">
                  {Math.round(v.similarity * 100)}% match
                </div>
              </div>
              <div className="p-3">
                <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
                <div className="flex items-center gap-2 text-xs text-[#888] mb-1">
                  <span className="text-green-400">{fmtYT(v.viewCount)} views</span>
                  {v.channelName && <span>· {v.channelName}</span>}
                  {v.postedAt && <span>· {formatTimeAgo(v.postedAt)}</span>}
                </div>
                <div className="flex items-center gap-3 text-xs text-[#666] flex-wrap">
                  {v.likeCount > 0 && <span>👍 {fmtYT(v.likeCount)}</span>}
                  {v.subscriberCount > 0 && <span>👥 {fmtYT(v.subscriberCount)}</span>}
                  {v.channelCreatedAt && (() => {
                    const days = Math.floor((Date.now() - new Date(v.channelCreatedAt).getTime()) / 86400000);
                    if (days < 30) return <span className="text-orange-400">📅 {days}d old</span>;
                    if (days < 365) return <span>📅 {Math.floor(days / 30)}mo old</span>;
                    return <span>📅 {(days / 365).toFixed(1)}yr old</span>;
                  })()}
                </div>
                <div className="flex items-center justify-between mt-2 gap-2">
                  {v.url && <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-400 truncate min-w-0 flex-1">{v.url}</a>}
                  <button
                    onClick={() => onOpenSimilar(v.id)}
                    className="flex items-center gap-1 text-xs bg-green-600/20 text-green-400 border border-green-600/40 px-2 py-0.5 rounded-full hover:bg-green-600/30 transition flex-shrink-0 font-medium"
                  >
                    Similar
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function InsightsTab({ scored, filteredCount }: { scored: SimilarVideo[]; filteredCount: number }) {
  const scatterDots: ScatterDot[] = useMemo(() => scored.map(v => {
    const chAge = v.channelCreatedAt ? Math.floor((Date.now() - new Date(v.channelCreatedAt).getTime()) / 86400000) : null;
    const vidAge = v.postedAt ? Math.floor((Date.now() - new Date(v.postedAt).getTime()) / 86400000) : null;
    return {
      id: v.id,
      ch: v.channelName || '',
      s: v.subscriberCount || 0,
      v: v.viewCount || 0,
      sc: v.score || 0,
      a: chAge,
      va: vidAge,
      e: true,
    };
  }), [scored]);

  const indicatorDots = useMemo(() => scatterDots.map(d => ({ s: d.s, v: d.v, a: d.a })), [scatterDots]);

  const videoLookup = useCallback((id: number): ScatterVideo | null => {
    const v = scored.find(x => x.id === id);
    if (!v) return null;
    const chAge = v.channelCreatedAt ? Math.floor((Date.now() - new Date(v.channelCreatedAt).getTime()) / 86400000) : null;
    const thumbFallback = (v.url || '').match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    return {
      id: v.id, name: v.channelName || '', subs: v.subscriberCount || 0, views: v.viewCount || 0,
      avgScore: v.score || 0, ageDays: chAge, channelId: null,
      videoUrl: v.url || null, videoTitle: v.title || null,
      thumbnail: v.thumbnail || (thumbFallback ? `https://img.youtube.com/vi/${thumbFallback[1]}/hqdefault.jpg` : null),
      likeCount: v.likeCount || 0, commentCount: v.commentCount || 0,
      postedAt: v.postedAt, postedDate: v.postedDate, keyword: v.keyword,
      embeddedAt: 'yes', topComment: v.topComment,
    };
  }, [scored]);

  const subsBuckets = useMemo(() => {
    const byChannel = new Map<string, number>();
    for (const v of scored) {
      if (!v.channelName) continue;
      const prev = byChannel.get(v.channelName);
      byChannel.set(v.channelName, Math.max(prev || 0, v.subscriberCount || 0));
    }
    return makeSubsBuckets([...byChannel.values()]);
  }, [scored]);

  const viewsBuckets = useMemo(
    () => makeViewsBuckets(scored.map(v => v.viewCount || 0)),
    [scored]
  );

  if (scored.length === 0) {
    return (
      <div className="bg-[#141414] border border-dashed border-[#1f1f1f] rounded-xl px-5 py-8 text-center text-[#666]">
        {filteredCount === 0
          ? 'No matches at the current threshold. Lower the min match above.'
          : `No videos in this cluster have score ≥ 80 yet. Total similar: ${filteredCount}.`}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-[10px] text-[#666] uppercase tracking-wider">
        Insights computed over {scored.length} of {filteredCount} videos (score ≥ 80)
      </div>
      {scored.length >= 10 ? (
        <OpportunityIndicators dots={indicatorDots} />
      ) : (
        <div className="bg-[#141414] border border-dashed border-[#1f1f1f] rounded-xl px-5 py-4 text-[#666] text-sm">
          Need at least 10 high-score videos to compute opportunity indicators — lower the min match or pick a video with more embedded neighbours.
        </div>
      )}
      <ChannelScatter dots={scatterDots} videoLookup={videoLookup} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {subsBuckets.some(b => b.count > 0) && <DistBars title="Subscriber Distribution" unit="channels" buckets={subsBuckets} />}
        {viewsBuckets.some(b => b.count > 0) && <DistBars title="Views Distribution" unit="videos" buckets={viewsBuckets} />}
      </div>
    </div>
  );
}

function formatTimeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return 'Just now';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ── Basis picker — shown when the modal first opens ───────────── */

function BasisPicker({ onPick }: { onPick: (b: 'title_v2' | 'thumbnail_v2' | 'combined') => void }) {
  const cards: Array<{ id: 'title_v2' | 'thumbnail_v2' | 'combined'; label: string; desc: string; icon: React.ReactNode }> = [
    {
      id: 'title_v2',
      label: 'Title',
      desc: 'Videos whose titles share the most meaning with this one.',
      icon: (
        <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h10" />
        </svg>
      ),
    },
    {
      id: 'thumbnail_v2',
      label: 'Thumbnail',
      desc: 'Videos whose thumbnails look visually similar — same style, colors, composition.',
      icon: (
        <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      id: 'combined',
      label: 'Both',
      desc: 'Averages title + thumbnail similarity. Best for finding the closest overall matches.',
      icon: (
        <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      ),
    },
  ];

  return (
    <div className="py-8 px-4">
      <div className="text-center mb-6">
        <h4 className="text-sm font-medium text-white mb-1">How should we find similar videos?</h4>
        <p className="text-xs text-[#666]">Different bases give very different results. Pick one to start — you can switch any time.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 max-w-3xl mx-auto">
        {cards.map(c => (
          <button
            key={c.id}
            onClick={() => onPick(c.id)}
            className="bg-[#141414] border border-[#1f1f1f] hover:border-amber-500/60 hover:bg-[#1a1a1a] rounded-xl p-5 text-left transition group"
          >
            <div className="text-amber-400 mb-3 group-hover:scale-110 transition-transform inline-block">{c.icon}</div>
            <div className="text-sm font-semibold text-white mb-1">{c.label}</div>
            <div className="text-[11px] text-[#888] leading-relaxed">{c.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Live indicator pills shown next to tab selector ───────────── */

function ModalIndicatorPills({
  disabled, nos, nosDisplay, topLeftPct, newcomerRate, lowSubCeiling, sampleSize,
}: {
  disabled: boolean;
  nos: number;
  nosDisplay: number;
  topLeftPct: number;
  newcomerRate: number;
  lowSubCeiling: number;
  sampleSize: number;
}) {
  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}K` : `${Math.round(n)}`;

  const emptyTooltip = (
    <>
      <div className="font-semibold text-white mb-1">Not enough data</div>
      <div>Need at least 10 high-score videos to compute. Current: {sampleSize}. Lower the min match above to widen the pool.</div>
    </>
  );

  const pills = [
    {
      label: 'OPP',
      value: disabled ? '—' : `${nosDisplay}`,
      band: disabled ? 'empty' : nos >= 1.3 ? 'green' : nos >= 1.0 ? 'yellow' : 'red',
      tooltip: disabled ? emptyTooltip : (
        <>
          <div className="font-semibold text-white mb-1">Opportunity Score</div>
          <div>Median <code className="text-amber-400">log(views)/log(subs)</code> across score ≥ 80 videos.</div>
          <div className="mt-1.5 text-[#888]">Raw NOS: {nos.toFixed(2)} · {sampleSize} videos</div>
        </>
      ),
    },
    {
      label: 'TOP',
      value: disabled ? '—' : `${topLeftPct}%`,
      band: disabled ? 'empty' : topLeftPct >= 30 ? 'green' : topLeftPct >= 10 ? 'yellow' : 'red',
      tooltip: disabled ? emptyTooltip : (
        <>
          <div className="font-semibold text-white mb-1">Top-Left Density</div>
          <div>% of videos with above-median views AND below-median subs.</div>
        </>
      ),
    },
    {
      label: 'NEW',
      value: disabled ? '—' : `${newcomerRate}%`,
      band: disabled ? 'empty' : newcomerRate >= 80 ? 'green' : newcomerRate >= 50 ? 'yellow' : 'red',
      tooltip: disabled ? emptyTooltip : (
        <>
          <div className="font-semibold text-white mb-1">Newcomer Success</div>
          <div>Median views of channels &lt;6mo old, as % of overall median.</div>
        </>
      ),
    },
    {
      label: 'CEIL',
      value: disabled ? '—' : fmt(lowSubCeiling),
      band: disabled ? 'empty' : lowSubCeiling >= 500000 ? 'green' : lowSubCeiling >= 100000 ? 'yellow' : 'red',
      tooltip: disabled ? emptyTooltip : (
        <>
          <div className="font-semibold text-white mb-1">Low-Sub Ceiling</div>
          <div>p90 views among channels with &lt;10K subs.</div>
        </>
      ),
    },
  ] as const;

  return (
    <div className="flex items-center gap-1.5">
      {pills.map(p => <ModalPill key={p.label} {...p} />)}
    </div>
  );
}

function ModalPill({
  label, value, band, tooltip,
}: {
  label: string;
  value: string;
  band: 'green' | 'yellow' | 'red' | 'empty';
  tooltip: React.ReactNode;
}) {
  const colors = {
    green:  'text-green-400 bg-green-500/10 border-green-500/20',
    yellow: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    red:    'text-red-400 bg-red-500/10 border-red-500/20',
    empty:  'text-[#555] bg-[#1a1a1a]/40 border-[#1f1f1f] border-dashed',
  };
  return (
    <div className="relative group/pill">
      <div className={`flex flex-col items-center justify-center rounded-md border px-2 py-1 min-w-[54px] cursor-help ${colors[band]}`}>
        <div className="text-[8px] uppercase tracking-wider opacity-70 leading-none">{label}</div>
        <div className="text-xs font-bold leading-tight mt-0.5">{value}</div>
      </div>
      {/* Anchor tooltip to the right so it never overflows past the modal edge */}
      <div className="pointer-events-none absolute right-0 top-full mt-2 w-64 p-3 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-[11px] text-[#ccc] leading-relaxed shadow-xl opacity-0 group-hover/pill:opacity-100 transition-opacity z-50 text-left">
        {tooltip}
      </div>
    </div>
  );
}
