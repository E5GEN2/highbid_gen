'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { fmtYT } from '@/lib/format';
import { NicheClusterCard } from '@/components/NicheClusterCard';

// Shape returned by /api/niche-spy/search-semantic — matches the
// similar-page video tile so the same render block works.
interface SemanticHit {
  id: number; title: string; url: string; keyword: string;
  viewCount: number; channelName: string;
  postedAt: string | null; postedDate: string | null;
  score: number; subscriberCount: number; likeCount: number;
  commentCount: number; topComment: string | null;
  thumbnail: string | null; channelCreatedAt: string | null;
  firstUploadAt: string | null; dormancyDays: number | null;
  similarity: number;
}

// Shape returned by /api/niche-spy/tree-clusters — auto-discovered
// L1 niche clusters from the latest HDBSCAN run (combined_v2 space).
interface PopularVideo {
  videoId: number;
  title: string | null;
  thumbnail: string | null;
  url: string | null;
  viewCount: number | null;
  channelName: string | null;
  postedAt: string | null;
  postedDate: string | null;
  score: number | null;
}
interface TreeClusterCard {
  id: number;
  level: number;
  parentClusterId: number | null;
  autoLabel: string | null;
  label: string | null;
  videoCount: number;
  avgScore: number | null;
  avgViews: number | null;
  totalViews: number | null;
  topChannels: string[];
  representativeVideoId: number | null;
  repTitle: string | null;
  repThumbnail: string | null;
  repUrl: string | null;
  repViewCount: number | null;
  repChannelName: string | null;
  popularVideos: PopularVideo[];
  childrenCount: number;
}

type ClusterSort = 'videos' | 'views' | 'score';

export default function NichesGrid() {
  const [clusters, setClusters] = useState<TreeClusterCard[]>([]);
  const [clustersLoading, setClustersLoading] = useState(true);
  const [clustersError, setClustersError] = useState<string | null>(null);
  const [clusterSort, setClusterSort] = useState<ClusterSort>('videos');
  // searchInput = live input value; semanticQuery = committed query
  // (the value that was actually sent to the API). Splitting them lets
  // the user type freely without firing a search per keystroke.
  const [searchInput, setSearchInput] = useState('');
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticResults, setSemanticResults] = useState<SemanticHit[] | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [hitFromCache, setHitFromCache] = useState(false);
  // Min-match % filter — wide-fetch from the API (limit 500, no server
  // threshold) and let the user dial in how strict the match needs to
  // be without re-querying. Default 0 so users see the full result set
  // first, then filter up.
  const [minSimilarity, setMinSimilarity] = useState(0);

  // Load clusters from the latest HDBSCAN run (L1 only — drill into L2
  // happens on the cluster detail page).
  const fetchClusters = useCallback(async () => {
    setClustersLoading(true);
    setClustersError(null);
    try {
      const res = await fetch('/api/niche-spy/tree-clusters');
      const data = await res.json();
      if (!res.ok) {
        setClustersError(data.error || `HTTP ${res.status}`);
        setClusters([]);
      } else {
        setClusters(data.clusters || []);
      }
    } catch (err) {
      setClustersError((err as Error).message);
      setClusters([]);
    } finally {
      setClustersLoading(false);
    }
  }, []);

  useEffect(() => { fetchClusters(); }, [fetchClusters]);

  // Sorted view — clusters API returns video-count-desc by default; we
  // re-sort client-side when the user picks a different sort.
  const sortedClusters = useMemo(() => {
    const arr = clusters.slice();
    if (clusterSort === 'views')  arr.sort((a, b) => (b.totalViews ?? 0) - (a.totalViews ?? 0));
    if (clusterSort === 'score')  arr.sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));
    if (clusterSort === 'videos') arr.sort((a, b) => b.videoCount - a.videoCount);
    return arr;
  }, [clusters, clusterSort]);

  // Fire semantic search — embeds the query through Gemini and looks
  // up nearest videos in the combined_v2 multimodal space. ~1-2s on
  // cache miss, near-instant on cache hit.
  const runSemanticSearch = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setSemanticQuery(''); setSemanticResults(null); setSemanticError(null);
      return;
    }
    setSemanticLoading(true);
    setSemanticError(null);
    setSemanticQuery(trimmed);
    try {
      const res = await fetch('/api/niche-spy/search-semantic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed, limit: 500, minSimilarity: 0 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSemanticError(data.error || `HTTP ${res.status}`);
        setSemanticResults([]);
      } else {
        setSemanticResults(data.results || []);
        setHitFromCache(!!data.hitFromCache);
      }
    } catch (err) {
      setSemanticError((err as Error).message);
      setSemanticResults([]);
    } finally {
      setSemanticLoading(false);
    }
  };

  const clearSearch = () => {
    setSearchInput('');
    setSemanticQuery('');
    setSemanticResults(null);
    setSemanticError(null);
  };

  const filteredResults = useMemo(
    () => (semanticResults || []).filter(v => v.similarity >= minSimilarity),
    [semanticResults, minSimilarity],
  );

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Niches</h1>
        <p className="text-sm text-[#888]">Auto-discovered niche clusters from {clusters.length || '—'} groups</p>
      </div>

      {/* Search bar — semantic. Press Enter to fire. The query gets
          embedded via Gemini and matched against video thumbnails+titles
          in the joint multimodal space; results replace the niche cards
          below until you clear the search. */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3 flex items-center gap-3 mb-2">
        <svg className="w-5 h-5 text-[#666] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') runSemanticSearch(searchInput); }}
          placeholder="Search videos by meaning — e.g. tired guy at desk, AI YouTube automation, dramatic scary stories…"
          className="flex-1 bg-transparent text-white text-sm placeholder-[#555] focus:outline-none"
          disabled={semanticLoading}
        />
        {(semanticQuery || searchInput) && (
          <button
            type="button"
            onClick={clearSearch}
            className="text-[#666] hover:text-white text-xs flex-shrink-0"
            title="Clear search"
          >
            ✕
          </button>
        )}
        <button
          type="button"
          onClick={() => runSemanticSearch(searchInput)}
          disabled={semanticLoading || !searchInput.trim()}
          className="px-3 py-1 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold rounded-md text-xs flex-shrink-0"
        >
          {semanticLoading ? 'Searching…' : 'Search'}
        </button>
      </div>
      <p className="text-xs text-[#666] mb-6">
        Press Enter or hit Search. Powered by combined v2 (joint title+thumbnail) multimodal embeddings — text queries match against both verbal and visual signal.
      </p>

      {/* Semantic search results — replaces the cluster cards while a
          query is active. Results carry a per-card "match %" badge
          identical to the Similar page so the grid feels familiar. */}
      {semanticQuery && (
        <div className="mb-6">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-white">
                {semanticLoading
                  ? 'Searching…'
                  : `${filteredResults.length} of ${semanticResults?.length ?? 0} videos for "${semanticQuery}"`}
              </span>
              {hitFromCache && !semanticLoading && (
                <span className="text-[10px] uppercase tracking-wider bg-[#1a1a1a] border border-[#333] text-[#888] px-1.5 py-0.5 rounded-full" title="Vector reused from a previous query — no Gemini call">
                  cache hit
                </span>
              )}
              {semanticError && (
                <span className="text-xs text-red-400">Error: {semanticError}</span>
              )}
            </div>

            {/* Min-match % — pure client-side filter over the already-fetched 500. */}
            {(semanticResults && semanticResults.length > 0) && (
              <div className="flex items-center gap-2">
                <label className="text-xs text-[#888]">Min match:</label>
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
                    className="w-14 bg-transparent text-white text-xs px-2 py-1 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <span className="text-xs text-[#666] pr-2">%</span>
                </div>
              </div>
            )}
          </div>

          {semanticLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden animate-pulse">
                  <div className="aspect-video bg-[#1a1a1a]" />
                  <div className="p-3 space-y-2"><div className="h-4 w-3/4 bg-[#1f1f1f] rounded" /><div className="h-3 w-1/2 bg-[#1f1f1f] rounded" /></div>
                </div>
              ))}
            </div>
          ) : (semanticResults && semanticResults.length === 0) ? (
            <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#888]">
              No videos match &ldquo;{semanticQuery}&rdquo;. Try a different phrasing or fewer specifics.
            </div>
          ) : filteredResults.length === 0 ? (
            <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#888]">
              No videos at or above {Math.round(minSimilarity * 100)}% match. Lower the min match to see more.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredResults.map(v => {
                const vidMatch = (v.url || '').match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
                const thumb = v.thumbnail || (vidMatch ? `https://img.youtube.com/vi/${vidMatch[1]}/hqdefault.jpg` : '');
                return (
                  <div key={v.id} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden hover:border-[#333] transition">
                    <div className="relative aspect-video bg-[#0a0a0a]">
                      {thumb && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />
                      )}
                      <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${
                        v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'
                      }`}>⚡ {v.score}</div>
                      <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs font-bold bg-purple-600 text-white">
                        {Math.round(v.similarity * 100)}% match
                      </div>
                    </div>
                    <div className="p-3">
                      <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
                      <div className="flex items-center gap-2 text-xs text-[#888] mb-1.5">
                        <span className="text-green-400">{fmtYT(v.viewCount)} views</span>
                        {v.channelName && <span>· {v.channelName}</span>}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[#666] mb-2">
                        {v.likeCount > 0    && <span>👍 {fmtYT(v.likeCount)}</span>}
                        {v.commentCount > 0 && <span>💬 {fmtYT(v.commentCount)}</span>}
                        {v.subscriberCount > 0 && <span>👥 {fmtYT(v.subscriberCount)}</span>}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        {v.url && (
                          <a href={v.url} target="_blank" rel="noopener noreferrer"
                             className="text-[10px] text-blue-400 truncate min-w-0 flex-1">{v.url}</a>
                        )}
                        <Link href={`/niche/similar/${v.id}`}
                              className="flex-shrink-0 text-[10px] bg-green-600/20 text-green-400 border border-green-600/40 px-2 py-0.5 rounded-full hover:bg-green-600/30 transition font-medium">
                          Similar
                        </Link>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Cluster cards — only rendered when no semantic search is active */}
      {!semanticQuery && (
      <>
      {/* Sort pills */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-2 flex-wrap">
          {([
            { value: 'videos', label: 'Most Videos' },
            { value: 'views',  label: 'Most Views' },
            { value: 'score',  label: 'Highest Score' },
          ] as const).map(opt => (
            <button
              key={opt.value}
              onClick={() => setClusterSort(opt.value)}
              className={`px-4 py-1.5 rounded-full text-sm transition ${
                clusterSort === opt.value
                  ? 'bg-white text-black font-medium'
                  : 'text-[#888] border border-[#333] hover:border-[#555]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {clusters.length > 0 && (
          <span className="text-sm text-[#888]">{clusters.length} niches</span>
        )}
      </div>

      {clustersError && (
        <div className="bg-[#141414] border border-red-500/30 rounded-xl p-4 mb-4 text-sm text-red-400">
          Failed to load clusters: {clustersError}
        </div>
      )}

      {/* Cluster cards — wide rows so titles + thumbs stay legible */}
      <div className="space-y-3">
        {clustersLoading && clusters.length === 0 && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 animate-pulse">
            <div className="h-4 w-1/3 bg-[#1f1f1f] rounded mb-3" />
            <div className="grid grid-cols-4 gap-3">
              {[0,1,2,3].map(j => (
                <div key={j}>
                  <div className="aspect-video bg-[#1a1a1a] rounded-md" />
                  <div className="h-3 w-3/4 bg-[#1f1f1f] rounded mt-2" />
                </div>
              ))}
            </div>
          </div>
        ))}
        {sortedClusters.map(c => (
          <NicheClusterCard key={c.id} cluster={c} />
        ))}
      </div>
      </>
      )}
    </div>
  );
}

