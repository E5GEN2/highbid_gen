'use client';

import React, { useState, useCallback, useEffect, useMemo, Suspense } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useNiche } from '@/components/NicheProvider';
import { useSimilarModal } from '@/components/SimilarModal';
import { IndicatorPillsRow, IndicatorPillsEmpty } from '@/components/IndicatorPill';
import { fmtYT } from '@/lib/format';

interface NicheVideo {
  id: number; keyword: string; url: string; title: string; view_count: number;
  channel_name: string; posted_date: string; posted_at: string; score: number;
  channel_created_at: string; embedded_at: string | null;
  subscriber_count: number; like_count: number; comment_count: number;
  top_comment: string; thumbnail: string; fetched_at: string;
  _similarity?: number;
}

export default function NicheVideos() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[50vh]"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-amber-500" /></div>}>
      <NicheVideosInner />
    </Suspense>
  );
}

function NicheVideosInner() {
  const { keyword: rawKeyword } = useParams<{ keyword: string }>();
  const keyword = decodeURIComponent(rawKeyword);
  const router = useRouter();
  const { openSimilar } = useSimilarModal();
  const { setSelectedKeyword, filter, setFilter } = useNiche();

  const [videos, setVideos] = useState<NicheVideo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  // stats + keywords state removed along with the redundant top plaque —
  // breadcrumbs + sidebar already show the active keyword.


  // Similar modal state
  // Per-video refresh state — set of video IDs currently being refreshed
  const [refreshingIds, setRefreshingIds] = useState<Set<number>>(new Set());

  const refreshVideo = useCallback(async (id: number) => {
    setRefreshingIds(prev => new Set(prev).add(id));
    try {
      const res = await fetch('/api/niche-spy/enrich-one', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: id }),
      });
      const data = await res.json();
      if (data.ok && data.video) {
        // Replace the video in the list with the updated data
        setVideos(prev => prev.map(v => v.id === id ? { ...v, ...data.video } : v));
      } else {
        console.error('Refresh failed:', data.error);
      }
    } catch (err) {
      console.error('Refresh error:', err);
    } finally {
      setRefreshingIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, []);

  // Similar videos now live on their own page at /niche/similar/[videoId]

  // Sub-niche sort — defaults to videoCount desc, user can pick any indicator
  const [subnicheSort, setSubnicheSort] = useState<'videos' | 'views' | 'score' | 'opp' | 'top' | 'new' | 'ceil'>('videos');

  // Local text input for the grid search bar — debounced 300ms into filter.search
  // so we don't refire the fetch on every keystroke.
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const h = setTimeout(() => {
      setFilter(prev => prev.search === searchInput ? prev : { ...prev, search: searchInput });
    }, 300);
    return () => clearTimeout(h);
  }, [searchInput, setFilter]);

  // View mode: all videos vs sub-niches
  const searchParams = useSearchParams();
  const clusterParam = searchParams.get('cluster');
  const [viewMode, setViewMode] = useState<'videos' | 'subniches'>(clusterParam ? 'videos' : 'videos');
  const [clusterRun, setClusterRun] = useState<{
    run: { id: number; status: string; numClusters: number; numNoise: number; totalVideos: number; completedAt: string | null; errorMessage?: string | null } | null;
    clusters: Array<{
      id: number; clusterIndex: number; label: string | null; autoLabel: string | null; aiLabel: string | null;
      videoCount: number; avgScore: number | null; avgViews: number | null; totalViews: number | null;
      topChannels: string[]; representativeVideoId: number | null;
      // Enriched by GET /api/niche-spy/clusters — identical shape to niche cards
      channelCount?: number;
      highScoreCount?: number;
      newChannelCount?: number;
      opportunity?: {
        sample: number; nos: number; nosDisplay: number;
        topLeftPct: number; newcomerRate: number; lowSubCeiling: number;
      } | null;
    }>;
  }>({ run: null, clusters: [] });
  const [clusterName, setClusterName] = useState<string | null>(null);

  // Set keyword in context on mount
  useEffect(() => { setSelectedKeyword(keyword); }, [keyword, setSelectedKeyword]);

  // Fetch cluster data + poll while running/labeling
  const fetchClusters = useCallback(() => {
    fetch(`/api/niche-spy/clusters?keyword=${encodeURIComponent(keyword)}`)
      .then(r => r.json())
      .then(d => setClusterRun(d))
      .catch(() => {});
  }, [keyword]);

  useEffect(() => { fetchClusters(); }, [fetchClusters]);

  useEffect(() => {
    if (clusterRun.run?.status === 'running' || clusterRun.run?.status === 'labeling') {
      const interval = setInterval(fetchClusters, 3000);
      return () => clearInterval(interval);
    }
  }, [clusterRun.run?.status, fetchClusters]);

  // If ?cluster=ID, find the cluster name
  useEffect(() => {
    if (clusterParam && clusterRun.clusters.length > 0) {
      const c = clusterRun.clusters.find(c => String(c.id) === clusterParam);
      setClusterName(c?.label || c?.autoLabel || `Cluster ${c?.clusterIndex}`);
    } else {
      setClusterName(null);
    }
  }, [clusterParam, clusterRun]);

  const fetchVideos = useCallback(async (off = 0) => {
    setLoading(true);
    try {
      let url: string;
      if (clusterParam) {
        // Fetch videos for a specific cluster
        const params = new URLSearchParams({ sort: filter.sort, limit: '60', offset: String(off) });
        url = `/api/niche-spy/clusters/${clusterParam}/videos?${params}`;
      } else {
        const params = new URLSearchParams({
          keyword,
          minScore: String(filter.minScore),
          maxScore: String(filter.maxScore),
          sort: filter.sort,
          limit: '60',
          offset: String(off),
        });
        if (filter.from) params.set('from', filter.from);
        if (filter.to) params.set('to', filter.to);
        if (filter.search) params.set('q', filter.search);
        url = `/api/niche-spy?${params}`;
      }
      const res = await fetch(url);
      const data = await res.json();
      if (off === 0) setVideos(data.videos);
      else setVideos(prev => [...prev, ...data.videos]);
      setTotal(data.total);
      setOffset(off + data.videos.length);
    } catch (err) { console.error('Video fetch error:', err); }
    setLoading(false);
  }, [keyword, filter, clusterParam]);

  useEffect(() => { fetchVideos(0); }, [fetchVideos]);

  const timeAgo = (dateStr: string) => {
    const d = new Date(dateStr);
    const diffMs = Date.now() - d.getTime();
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);
    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours} hours ago`;
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getThumb = (url: string, thumb: string) => {
    const m = url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : thumb;
  };

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* View toggle: All Videos | Sub-niches */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => { setViewMode('videos'); if (clusterParam) router.push(`/niche/niches/${encodeURIComponent(keyword)}/videos`); }}
          className={`px-4 py-2 rounded-full text-sm font-medium transition ${
            viewMode === 'videos' && !clusterParam ? 'bg-white text-black' : 'text-[#888] border border-[#333] hover:border-[#555]'
          }`}
        >
          All Videos
        </button>
        <button
          onClick={() => setViewMode('subniches')}
          className={`px-4 py-2 rounded-full text-sm font-medium transition ${
            viewMode === 'subniches' ? 'bg-white text-black' : 'text-[#888] border border-[#333] hover:border-[#555]'
          }`}
        >
          Sub-niches
          {clusterRun.run?.numClusters ? (
            <span className="ml-1.5 text-xs opacity-70">({clusterRun.run.numClusters})</span>
          ) : null}
        </button>
        {clusterParam && clusterName && (
          <div className="flex items-center gap-2 ml-2">
            <span className="text-[#444]">/</span>
            <span className="text-amber-400 text-sm font-medium">{clusterName}</span>
            <span className="text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded-full">ai-clustered</span>
            <button
              onClick={() => { setViewMode('subniches'); router.push(`/niche/niches/${encodeURIComponent(keyword)}/videos`); }}
              className="text-xs text-[#888] hover:text-white ml-1"
            >
              Back to Sub-niches
            </button>
          </div>
        )}
      </div>

      {/* Sub-niches view */}
      {viewMode === 'subniches' && !clusterParam && (
        <div>
          {!clusterRun.run || clusterRun.run.status === 'error' ? (
            <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center">
              <div className="text-4xl mb-3">🔬</div>
              <h3 className="text-lg font-semibold text-white mb-2">No sub-niches discovered yet</h3>
              <p className="text-sm text-[#888]">Run clustering from the admin panel to discover sub-niches automatically.</p>
              {clusterRun.run?.errorMessage && (
                <p className="text-xs text-red-400 mt-2">Last error: {clusterRun.run.errorMessage}</p>
              )}
            </div>
          ) : clusterRun.run.status === 'running' && clusterRun.clusters.length === 0 ? (
            <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-6">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-amber-200">Clustering in progress...</span>
              </div>
            </div>
          ) : (
            <>
              {/* Status bar */}
              <div className="flex items-center gap-3 mb-4 text-sm text-[#888]">
                <span className="font-medium text-white">{clusterRun.run.numClusters} sub-niches</span>
                <span>·</span>
                <span>{clusterRun.run.numNoise} unclustered</span>
                {clusterRun.run.completedAt && (
                  <>
                    <span>·</span>
                    <span>Last run: {new Date(clusterRun.run.completedAt).toLocaleDateString()}</span>
                  </>
                )}
                {clusterRun.run.status === 'labeling' && (
                  <span className="flex items-center gap-1.5 text-amber-300">
                    <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                    AI labeling...
                  </span>
                )}
                <button
                  onClick={async () => {
                    const res = await fetch('/api/niche-spy/clusters', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ keyword }),
                    });
                    const data = await res.json();
                    if (data.ok) fetchClusters();
                    else alert(data.error || 'Failed');
                  }}
                  className="ml-auto px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-medium transition"
                >
                  Re-run
                </button>
              </div>

              {/* Sort pills — same pattern as Videos grid */}
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                {([
                  { value: 'videos', label: 'Most Videos' },
                  { value: 'views', label: 'Most Views' },
                  { value: 'score', label: 'Highest Score' },
                  { value: 'opp', label: 'Opportunity ↑' },
                  { value: 'top', label: 'Top-Left ↑' },
                  { value: 'new', label: 'Newcomer ↑' },
                  { value: 'ceil', label: 'Ceiling ↑' },
                ] as const).map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setSubnicheSort(opt.value)}
                    className={`px-3 py-1 rounded-full text-xs transition ${
                      subnicheSort === opt.value
                        ? 'bg-white text-black font-medium'
                        : 'text-[#888] border border-[#333] hover:border-[#555]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Sub-niche cards grid — mirrors the Niches grid card layout */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {[...clusterRun.clusters].sort((a, b) => {
                  // Clusters missing `opportunity` always go last in opportunity-based sorts.
                  const oa = a.opportunity, ob = b.opportunity;
                  const missingA = (k: 'opp' | 'top' | 'new' | 'ceil') => !oa;
                  const missingB = (k: 'opp' | 'top' | 'new' | 'ceil') => !ob;
                  switch (subnicheSort) {
                    case 'videos': return b.videoCount - a.videoCount;
                    case 'views':  return (b.totalViews ?? b.avgViews ?? 0) - (a.totalViews ?? a.avgViews ?? 0);
                    case 'score':  return (b.avgScore ?? 0) - (a.avgScore ?? 0);
                    case 'opp':
                      if (missingA('opp') && missingB('opp')) return 0;
                      if (missingA('opp')) return 1;
                      if (missingB('opp')) return -1;
                      return (ob!.nosDisplay) - (oa!.nosDisplay);
                    case 'top':
                      if (missingA('top') && missingB('top')) return 0;
                      if (missingA('top')) return 1;
                      if (missingB('top')) return -1;
                      return (ob!.topLeftPct) - (oa!.topLeftPct);
                    case 'new':
                      if (missingA('new') && missingB('new')) return 0;
                      if (missingA('new')) return 1;
                      if (missingB('new')) return -1;
                      return (ob!.newcomerRate) - (oa!.newcomerRate);
                    case 'ceil':
                      if (missingA('ceil') && missingB('ceil')) return 0;
                      if (missingA('ceil')) return 1;
                      if (missingB('ceil')) return -1;
                      return (ob!.lowSubCeiling) - (oa!.lowSubCeiling);
                    default: return 0;
                  }
                }).map(c => {
                  const label = c.label || c.autoLabel || `Cluster ${c.clusterIndex}`;
                  const avgScoreRounded = c.avgScore !== null ? Math.round(c.avgScore) : 0;
                  return (
                    <button
                      key={c.id}
                      onClick={() => {
                        setViewMode('videos');
                        router.push(`/niche/niches/${encodeURIComponent(keyword)}/videos?cluster=${c.id}`);
                      }}
                      className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 text-left hover:border-amber-500/60 transition group"
                    >
                      {/* Title row + ai-clustered badge + score badge */}
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <h3 className="text-base font-bold text-white group-hover:text-amber-400 transition leading-tight line-clamp-2">{label}</h3>
                          <span className="text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded-full flex-shrink-0">ai-clustered</span>
                        </div>
                        {c.avgScore !== null && (
                          <span className={`text-xs px-2 py-1 rounded-lg font-bold ${
                            avgScoreRounded >= 80 ? 'bg-green-500/20 text-green-400' :
                            avgScoreRounded >= 50 ? 'bg-yellow-500/20 text-yellow-400' :
                            'bg-red-500/20 text-red-400'
                          }`}>⚡ {avgScoreRounded}</span>
                        )}
                      </div>

                      {/* 3-column stats — videos / channels / total views */}
                      <div className="grid grid-cols-3 gap-2 mb-3">
                        <div>
                          <div className="text-lg font-bold text-white">{c.videoCount}</div>
                          <div className="text-xs text-[#666]">videos</div>
                        </div>
                        <div>
                          <div className="text-lg font-bold text-blue-400">{c.channelCount ?? '—'}</div>
                          <div className="text-xs text-[#666]">channels</div>
                        </div>
                        <div>
                          <div className="text-lg font-bold text-green-400">{c.totalViews ? fmtYT(c.totalViews) : (c.avgViews ? fmtYT(c.avgViews) : '—')}</div>
                          <div className="text-xs text-[#666]">{c.totalViews ? 'views' : 'avg views'}</div>
                        </div>
                      </div>

                      {/* Meta line — new ch / high score (no saturation for clusters;
                          top channels intentionally omitted, cards were too crowded) */}
                      <div className="flex items-center gap-2 text-xs text-[#666]">
                        {(c.newChannelCount ?? 0) > 0 && <span className="text-orange-400">{c.newChannelCount} new ch</span>}
                        {(c.highScoreCount ?? 0) > 0 && <span>{c.highScoreCount} high score</span>}
                      </div>

                      {/* Opportunity pills — identical to the niches grid */}
                      {c.opportunity ? <IndicatorPillsRow opportunity={c.opportunity} /> : <IndicatorPillsEmpty />}
                    </button>
                  );
                })}
              </div>

              {/* Noise count */}
              {clusterRun.run.numNoise > 0 && (
                <div className="mt-4 text-xs text-[#666]">
                  {clusterRun.run.numNoise} videos did not fit into any sub-niche cluster
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Video list (shown when viewMode === 'videos' or when cluster is selected) */}
      {(viewMode === 'videos' || clusterParam) && (<>
      {/* Filters */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 mb-6">
        {/* Search bar — matches against title + channel name */}
        <div className="flex items-center gap-2 bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl px-3 py-2 mb-3 focus-within:border-amber-500">
          <svg className="w-4 h-4 text-[#555] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search videos by title or channel…"
            className="flex-1 bg-transparent text-white text-sm placeholder-[#555] focus:outline-none"
          />
          {searchInput && (
            <button onClick={() => setSearchInput('')} className="text-[#666] hover:text-white" title="Clear">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Sort pills */}
        <div className="flex gap-2 flex-wrap mb-3">
          {[
            { value: 'score', label: 'Score' },
            { value: 'views', label: 'Views' },
            { value: 'date', label: 'Newest' },
            { value: 'oldest', label: 'Oldest' },
            { value: 'likes', label: 'Likes' },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setFilter(prev => ({ ...prev, sort: opt.value }))}
              className={`px-4 py-1.5 rounded-full text-sm transition ${
                filter.sort === opt.value
                  ? 'bg-white text-black font-medium'
                  : 'text-[#888] border border-[#333] hover:border-[#555]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {/* Score range */}
        <div className="flex gap-4 items-center text-sm text-[#888]">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-[#666]">Min Score:</span>
            <input type="number" min={0} max={100} value={filter.minScore}
              onChange={e => setFilter(prev => ({ ...prev, minScore: parseInt(e.target.value) || 0 }))}
              className="w-16 bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-2 py-1 text-white text-xs"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-[#666]">Max Score:</span>
            <input type="number" min={0} max={100} value={filter.maxScore}
              onChange={e => setFilter(prev => ({ ...prev, maxScore: parseInt(e.target.value) || 100 }))}
              className="w-16 bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-2 py-1 text-white text-xs"
            />
          </div>
          <span className="text-sm font-medium text-white ml-auto">{total} videos</span>
        </div>
      </div>

      {/* Video grid */}
      {loading && videos.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden animate-pulse">
              <div className="aspect-video bg-[#1a1a1a]" />
              <div className="p-3 space-y-2.5">
                <div className="flex items-center gap-2">
                  <div className="h-4 w-24 bg-[#1f1f1f] rounded-full" />
                  <div className="h-4 w-14 bg-[#1f1f1f] rounded-full ml-auto" />
                </div>
                <div className="h-4 w-full bg-[#1f1f1f] rounded" />
                <div className="h-4 w-3/4 bg-[#1f1f1f] rounded" />
                <div className="flex gap-3">
                  <div className="h-3 w-16 bg-[#1f1f1f] rounded" />
                  <div className="h-3 w-20 bg-[#1f1f1f] rounded" />
                  <div className="h-3 w-12 bg-[#1f1f1f] rounded" />
                </div>
                <div className="h-3 w-48 bg-[#1f1f1f] rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {videos.map(v => (
              <div key={v.id} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden hover:border-[#333] transition">
                {/* Thumbnail */}
                <div className="relative aspect-video bg-[#0a0a0a]">
                  {(() => {
                    const thumbUrl = getThumb(v.url, v.thumbnail);
                    return thumbUrl ? (
                      <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#333]">
                        <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </div>
                    );
                  })()}
                  <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${
                    v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'
                  }`}>
                    ⚡ {v.score}
                  </div>
                </div>

                <div className="p-3">
                  <div className="flex items-center justify-between mb-2">
                    {v.keyword && (
                      <span className="text-xs bg-purple-600/30 text-purple-300 border border-purple-600/50 rounded-full px-2 py-0.5">
                        {v.keyword}
                      </span>
                    )}
                    {v.embedded_at && (
                      <button
                        onClick={() => openSimilar(v.id)}
                        className="flex items-center gap-1 text-xs bg-green-600/20 text-green-400 border border-green-600/40 px-2.5 py-1 rounded-full hover:bg-green-600/30 transition flex-shrink-0 font-medium"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        Similar
                      </button>
                    )}
                  </div>
                  <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
                  <div className="flex items-center gap-2 text-xs text-[#888] mb-1.5">
                    <span className="text-green-400 font-medium">{v.view_count ? fmtYT(v.view_count) + ' views' : ''}</span>
                    {v.channel_name && <span>· {v.channel_name}</span>}
                    {(v.posted_at || v.posted_date) && <span>· {v.posted_at ? timeAgo(v.posted_at) : v.posted_date}</span>}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[#666] mb-2">
                    {v.like_count > 0 && <span>👍 {fmtYT(v.like_count)}</span>}
                    {v.comment_count > 0 && <span>💬 {fmtYT(v.comment_count)}</span>}
                    {v.subscriber_count > 0 && <span>👥 {fmtYT(v.subscriber_count)} subscribers</span>}
                    {v.channel_created_at && (() => {
                      const days = Math.floor((Date.now() - new Date(v.channel_created_at).getTime()) / 86400000);
                      if (days < 30) return <span className="text-orange-400">📅 {days}d old</span>;
                      if (days < 365) return <span>📅 {Math.floor(days / 30)}mo old</span>;
                      return <span>📅 {(days / 365).toFixed(1)}yr old</span>;
                    })()}
                  </div>
                  {v.top_comment && (
                    <p className="text-xs text-[#666] italic line-clamp-2 border-l-2 border-[#333] pl-2 mb-2">
                      &ldquo;{v.top_comment}&rdquo;
                    </p>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    {v.url ? (
                      <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300 truncate flex-1 min-w-0">
                        {v.url}
                      </a>
                    ) : <span className="flex-1" />}
                    {/* Refresh button — refetches data from YouTube API via proxy */}
                    <button
                      onClick={(e) => { e.stopPropagation(); refreshVideo(v.id); }}
                      disabled={refreshingIds.has(v.id)}
                      title="Refresh data from YouTube"
                      className="w-7 h-7 rounded-full bg-black/60 hover:bg-black/80 disabled:bg-black/40 flex items-center justify-center text-white/80 hover:text-white transition group flex-shrink-0"
                    >
                      <svg className={`w-3.5 h-3.5 ${refreshingIds.has(v.id) ? 'animate-spin' : 'group-hover:rotate-90 transition-transform'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Load more */}
          {videos.length < total && (
            <div className="text-center mt-6">
              <button onClick={() => fetchVideos(offset)} disabled={loading}
                className="px-6 py-2 bg-white/10 hover:bg-white/15 text-white rounded-xl text-sm transition">
                {loading ? 'Loading...' : `Load More (${videos.length}/${total})`}
              </button>
            </div>
          )}
        </>
      )}
      </>)}

    </div>
  );
}
