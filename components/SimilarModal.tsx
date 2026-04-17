'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { fmtYT } from '@/lib/format';
import { OpportunityIndicators } from './OpportunityIndicators';
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

  // Reset fetch on videoId change (supports switching to a nested video from the grid)
  useEffect(() => {
    setLoading(true);
    setError(null);
    setSource(null);
    setAll([]);
    fetch(`/api/niche-spy/similar?videoId=${videoId}&limit=500&minSimilarity=0`)
      .then(r => r.json())
      .then((d: { source?: SimilarSource; similar?: SimilarVideo[]; error?: string }) => {
        if (d.error) throw new Error(d.error);
        setSource(d.source || null);
        setAll(d.similar || []);
      })
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [videoId]);

  const filtered = useMemo(() => all.filter(v => v.similarity >= minSimilarity), [all, minSimilarity]);
  // Insights are score-filtered so numbers are comparable with the keyword Insights page
  const scored = useMemo(() => filtered.filter(v => (v.score || 0) >= 80), [filtered]);

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
            <label className="text-xs text-[#888]">Min match:</label>
            <select
              value={minSimilarity}
              onChange={e => setMinSimilarity(parseFloat(e.target.value))}
              disabled={loading}
              className="bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded px-2 py-1 focus:outline-none focus:border-amber-500 disabled:opacity-50"
            >
              <option value={0}>All</option>
              <option value={0.5}>50%+</option>
              <option value={0.6}>60%+</option>
              <option value={0.7}>70%+</option>
              <option value={0.8}>80%+</option>
              <option value={0.9}>90%+</option>
              <option value={0.95}>95%+</option>
            </select>
            <button onClick={onClose} className="text-[#888] hover:text-white ml-1">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tab selector */}
        <div className="px-6 pt-3 border-b border-[#1f1f1f] flex gap-0">
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

        {/* Body */}
        <div className="p-6">
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
                <div className="flex items-center gap-3 text-xs text-[#666]">
                  {v.likeCount > 0 && <span>👍 {fmtYT(v.likeCount)}</span>}
                  {v.subscriberCount > 0 && <span>👥 {fmtYT(v.subscriberCount)}</span>}
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
