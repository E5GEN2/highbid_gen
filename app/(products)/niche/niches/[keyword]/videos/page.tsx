'use client';

import React, { useState, useCallback, useEffect, useMemo, Suspense } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useNiche } from '@/components/NicheProvider';
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
  const { setSelectedKeyword, filter, setFilter } = useNiche();

  const [videos, setVideos] = useState<NicheVideo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [stats, setStats] = useState<{ total_videos: string; total_keywords: string; total_channels: string; avg_score: string } | null>(null);
  const [keywords, setKeywords] = useState<Array<{ keyword: string; cnt: string }>>([]);


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

  const [similarSource, setSimilarSource] = useState<{ id: number; title: string } | null>(null);
  const [similarVideos, setSimilarVideos] = useState<NicheVideo[]>([]);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarMinScore, setSimilarMinScore] = useState(0.7);
  const [similarSort, setSimilarSort] = useState<'similarity' | 'views' | 'score' | 'newest' | 'likes'>('similarity');

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
        url = `/api/niche-spy?${params}`;
      }
      const res = await fetch(url);
      const data = await res.json();
      if (off === 0) setVideos(data.videos);
      else setVideos(prev => [...prev, ...data.videos]);
      setTotal(data.total);
      if (data.keywords) setKeywords(data.keywords);
      if (data.stats) setStats(data.stats);
      setOffset(off + data.videos.length);
    } catch (err) { console.error('Video fetch error:', err); }
    setLoading(false);
  }, [keyword, filter, clusterParam]);

  useEffect(() => { fetchVideos(0); }, [fetchVideos]);

  // Store ALL similar results, client-side filter by minScore dropdown
  const [allSimilarVideos, setAllSimilarVideos] = useState<NicheVideo[]>([]);

  const fetchSimilar = async (videoId: number, title: string) => {
    setSimilarSource({ id: videoId, title });
    setSimilarLoading(true);
    try {
      // Fetch all results with 0 threshold — filter client-side via dropdown
      const res = await fetch(`/api/niche-spy/similar?videoId=${videoId}&limit=500&minSimilarity=0`);
      const data = await res.json();
      const mapped = (data.similar || []).map((v: Record<string, unknown>) => ({
        id: v.id as number, keyword: v.keyword as string, url: v.url as string, title: v.title as string,
        view_count: v.viewCount as number, channel_name: v.channelName as string,
        posted_date: v.postedDate as string, posted_at: v.postedAt as string,
        score: v.score as number, subscriber_count: v.subscriberCount as number,
        like_count: v.likeCount as number, comment_count: v.commentCount as number,
        top_comment: v.topComment as string, thumbnail: v.thumbnail as string,
        fetched_at: '', channel_created_at: '', embedded_at: null,
        _similarity: v.similarity as number,
      }));
      setAllSimilarVideos(mapped);
      setSimilarVideos(mapped.filter((v: NicheVideo) => (v._similarity || 0) >= similarMinScore));
    } catch (err) { console.error('Similar fetch error:', err); }
    setSimilarLoading(false);
  };

  // Re-filter when minScore changes (instant, no API call)
  useEffect(() => {
    if (allSimilarVideos.length > 0) {
      setSimilarVideos(allSimilarVideos.filter(v => (v._similarity || 0) >= similarMinScore));
    }
  }, [similarMinScore, allSimilarVideos]);

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
      {/* Stats header */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-6 py-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <span className="text-2xl font-bold text-white">{stats ? parseInt(stats.total_videos).toLocaleString() : '...'}</span>
            <span className="text-[#888] ml-2">stored videos</span>
          </div>
        </div>

        {/* Keyword filter dropdown */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#666] uppercase tracking-wider">Keyword</span>
            <select
              value={keyword}
              onChange={e => {
                const newKw = e.target.value;
                if (newKw === 'all') {
                  router.push('/niche/niches');
                } else {
                  router.push(`/niche/niches/${encodeURIComponent(newKw)}/videos`);
                }
              }}
              className="bg-[#0a0a0a] border border-[#1f1f1f] text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none"
            >
              <option value="all">All keywords</option>
              {keywords.map(k => (
                <option key={k.keyword} value={k.keyword}>{k.keyword} ({k.cnt})</option>
              ))}
            </select>
          </div>
        </div>
      </div>

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

              {/* Sub-niche cards grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {clusterRun.clusters.map(c => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setViewMode('videos');
                      router.push(`/niche/niches/${encodeURIComponent(keyword)}/videos?cluster=${c.id}`);
                    }}
                    className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 text-left hover:border-amber-500/60 transition group"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="text-sm font-bold text-white group-hover:text-amber-400 transition leading-tight line-clamp-2">
                        {c.label || c.autoLabel || `Cluster ${c.clusterIndex}`}
                      </h3>
                      <span className="text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded-full flex-shrink-0 ml-2">
                        ai-clustered
                      </span>
                    </div>
                    {c.avgScore !== null && (
                      <span className={`inline-block text-xs px-2 py-0.5 rounded-lg font-bold mb-2 ${
                        c.avgScore >= 80 ? 'bg-green-500/20 text-green-400' :
                        c.avgScore >= 50 ? 'bg-yellow-500/20 text-yellow-400' :
                        'bg-red-500/20 text-red-400'
                      }`}>⚡ {Math.round(c.avgScore)}</span>
                    )}
                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <div>
                        <div className="text-lg font-bold text-white">{c.videoCount}</div>
                        <div className="text-[10px] text-[#666]">videos</div>
                      </div>
                      <div>
                        <div className="text-lg font-bold text-green-400">{c.avgViews ? fmtYT(c.avgViews) : '—'}</div>
                        <div className="text-[10px] text-[#666]">avg views</div>
                      </div>
                    </div>
                    {c.topChannels.length > 0 && (
                      <div className="text-[10px] text-[#666] line-clamp-1">
                        {c.topChannels.slice(0, 3).join(' · ')}
                      </div>
                    )}
                  </button>
                ))}
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
                        onClick={() => fetchSimilar(v.id, v.title)}
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

      {/* Similar Videos Modal */}
      {similarSource && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] flex items-start justify-center pt-10 px-4 overflow-y-auto" onClick={() => { setSimilarSource(null); setSimilarVideos([]); setAllSimilarVideos([]); }}>
          <div className="bg-[#111] border border-[#1f1f1f] rounded-2xl w-full max-w-6xl mb-10" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-[#1f1f1f] flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-white">Similar to: <span className="text-purple-400">{similarSource.title}</span></h3>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-xs text-[#888]">{similarVideos.length} results</span>
                  <label className="text-xs text-[#888]">Min match:</label>
                  <select value={similarMinScore}
                    onChange={e => setSimilarMinScore(parseFloat(e.target.value))}
                    className="bg-[#141414] border border-[#1f1f1f] text-white text-xs rounded px-2 py-0.5">
                    <option value={0}>All</option>
                    <option value={0.5}>50%+</option>
                    <option value={0.6}>60%+</option>
                    <option value={0.7}>70%+</option>
                    <option value={0.8}>80%+</option>
                    <option value={0.9}>90%+</option>
                    <option value={0.95}>95%+</option>
                  </select>
                </div>
              </div>
              <button onClick={() => { setSimilarSource(null); setSimilarVideos([]); setAllSimilarVideos([]); }} className="text-[#888] hover:text-white">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            {/* Sort pills */}
            <div className="px-6 pt-3 pb-0 flex gap-2 flex-wrap">
              {([
                { value: 'similarity', label: 'Best Match' },
                { value: 'views', label: 'Most Views' },
                { value: 'score', label: 'Highest Score' },
                { value: 'newest', label: 'Newest' },
                { value: 'likes', label: 'Most Likes' },
              ] as const).map(opt => (
                <button key={opt.value} onClick={() => setSimilarSort(opt.value)}
                  className={`px-3 py-1 rounded-full text-xs transition ${
                    similarSort === opt.value ? 'bg-white text-black font-medium' : 'text-[#888] border border-[#333] hover:border-[#555]'
                  }`}>
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="p-6">
              {similarLoading ? (
                <div className="text-center py-12 text-[#888]">Finding similar videos...</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {[...similarVideos].sort((a, b) => {
                    switch (similarSort) {
                      case 'views': return (b.view_count || 0) - (a.view_count || 0);
                      case 'score': return (b.score || 0) - (a.score || 0);
                      case 'newest': return new Date(b.posted_at || 0).getTime() - new Date(a.posted_at || 0).getTime();
                      case 'likes': return (b.like_count || 0) - (a.like_count || 0);
                      default: return (b._similarity || 0) - (a._similarity || 0);
                    }
                  }).map(v => (
                    <div key={v.id} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden">
                      <div className="relative aspect-video bg-[#0a0a0a]">
                        {(() => {
                          const thumbUrl = getThumb(v.url, v.thumbnail);
                          return thumbUrl ? <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" /> : null;
                        })()}
                        <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'}`}>
                          ⚡ {v.score}
                        </div>
                        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs font-bold bg-purple-600 text-white">
                          {Math.round((v._similarity || 0) * 100)}% match
                        </div>
                      </div>
                      <div className="p-3">
                        <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
                        <div className="flex items-center gap-2 text-xs text-[#888] mb-1">
                          <span className="text-green-400">{fmtYT(v.view_count)} views</span>
                          {v.channel_name && <span>· {v.channel_name}</span>}
                          {(v.posted_at || v.posted_date) && <span>· {v.posted_at ? timeAgo(v.posted_at) : v.posted_date}</span>}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-[#666]">
                          {v.like_count > 0 && <span>👍 {fmtYT(v.like_count)}</span>}
                          {v.subscriber_count > 0 && <span>👥 {fmtYT(v.subscriber_count)}</span>}
                        </div>
                        {v.url && <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-400 mt-1 block truncate">{v.url}</a>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
