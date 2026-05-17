'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { NicheClusterCard } from '@/components/NicheClusterCard';
import { SimilarNichesModal } from '@/components/SimilarNichesModal';

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
  channelCount?: number;
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
  uploadHistogram?: number[];
  opportunity?: {
    sample: number;
    nos: number;
    nosDisplay: number;
    topLeftPct: number;
    newcomerRate: number;
    lowSubCeiling: number;
  } | null;
  childrenCount: number;
}

// Shape returned by /api/niche-spy/search-niches — same as cluster
// card plus a `similarity` cosine score against the query.
interface NicheSearchHit extends TreeClusterCard {
  similarity: number;
}

type ClusterSort = 'videos' | 'views' | 'score';

// Initial + per-scroll page size. 50 fits within ~1s of server time
// on the heavy aggregation queries and keeps the DOM small so first
// paint is snappy. Subsequent scroll-triggered pages append.
const PAGE_SIZE = 50;

/**
 * IntersectionObserver-driven sentinel — when the empty div scrolls
 * into view (or within `rootMargin` of it) it fires `onVisible`,
 * which the parent uses to fetch the next page. rootMargin of
 * `400px` starts loading just before the user reaches the bottom so
 * the next batch is usually already rendered by the time they scroll
 * there. `enabled=false` disconnects the observer so an exhausted
 * list doesn't keep observing.
 */
function ScrollSentinel({
  onVisible, enabled,
}: { onVisible: () => void; enabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (!node) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) onVisible();
    }, { rootMargin: '400px' });
    obs.observe(node);
    return () => obs.disconnect();
  }, [onVisible, enabled]);
  return <div ref={ref} className="h-1" />;
}

export default function NichesGrid() {
  const [clusters, setClusters] = useState<TreeClusterCard[]>([]);
  const [clustersLoading, setClustersLoading] = useState(true);
  const [clustersError, setClustersError] = useState<string | null>(null);
  const [clusterSort, setClusterSort] = useState<ClusterSort>('videos');
  // How many L1 / L2 clusters we've already loaded. Used as the
  // offset for the next page request and compared to totalL1/totalL2
  // to know when to stop firing IntersectionObserver loads.
  const [l1Loaded, setL1Loaded] = useState(0);
  const [l2Loaded, setL2Loaded] = useState(0);
  const [totalL1, setTotalL1] = useState(0);
  const [totalL2, setTotalL2] = useState(0);
  const [loadingMoreL1, setLoadingMoreL1] = useState(false);
  const [loadingMoreL2, setLoadingMoreL2] = useState(false);
  // Similar-niches popup state — null = closed, set to the full
  // source cluster when the user clicks "Similar" on any card. We
  // store the entire cluster (not just the id) so the modal can
  // render the source card at the top without an extra fetch.
  const [similarSource, setSimilarSource] = useState<TreeClusterCard | null>(null);
  const openSimilar = useCallback((cluster: TreeClusterCard) => {
    setSimilarSource(cluster);
  }, []);
  // searchInput = live input value; semanticQuery = committed query
  // (the value that was actually sent to the API). Splitting them lets
  // the user type freely without firing a search per keystroke.
  const [searchInput, setSearchInput] = useState('');
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticResults, setSemanticResults] = useState<NicheSearchHit[] | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [hitFromCache, setHitFromCache] = useState(false);
  // Min-match % filter — wide-fetch from the API (limit 200, no server
  // threshold) and let the user dial in how strict the match needs to
  // be without re-querying. Default 0 so users see the full result set
  // first, then filter up.
  const [minSimilarity, setMinSimilarity] = useState(0);

  // Paginated fetch — pulls one page of L1 + L2 from the latest
  // HDBSCAN run. Backend sorts by clusterSort and returns the next
  // slice based on l1Offset / l2Offset. Payload truncation has bit
  // us during Railway redeploys before, so retry a couple of times
  // on parse failure before surfacing the error.
  const fetchPage = useCallback(async (params: {
    l1Offset: number; l1Limit: number;
    l2Offset: number; l2Limit: number;
    sort: ClusterSort;
    /** When true, replace the current cluster list (initial load /
     *  sort change). Otherwise append to it (scroll-triggered). */
    reset: boolean;
  }) => {
    const qs = new URLSearchParams({
      l1Offset: String(params.l1Offset),
      l1Limit:  String(params.l1Limit),
      l2Offset: String(params.l2Offset),
      l2Limit:  String(params.l2Limit),
      sort:     params.sort,
    });
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`/api/niche-spy/tree-clusters?${qs.toString()}`);
        const text = await res.text();
        if (!text) throw new Error('empty response');
        const data = JSON.parse(text);
        if (!res.ok) {
          if (params.reset) setClusters([]);
          setClustersError(data.error || `HTTP ${res.status}`);
          return;
        }
        const newClusters: TreeClusterCard[] = data.clusters || [];
        const newL1 = newClusters.filter((c: TreeClusterCard) => c.parentClusterId == null).length;
        const newL2 = newClusters.length - newL1;
        if (params.reset) {
          setClusters(newClusters);
          setL1Loaded(newL1);
          setL2Loaded(newL2);
        } else {
          setClusters(prev => [...prev, ...newClusters]);
          setL1Loaded(prev => prev + newL1);
          setL2Loaded(prev => prev + newL2);
        }
        setTotalL1(data.totalL1 ?? 0);
        setTotalL2(data.totalL2 ?? 0);
        setClustersError(null);
        return;
      } catch (err) {
        lastErr = err as Error;
        if (attempt < 2) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    setClustersError(`Failed to load clusters: ${lastErr?.message || 'unknown'} (after 3 attempts — try again in a few seconds)`);
  }, []);

  // Initial load + reload on sort change. Replacing the cluster list
  // is the right move on sort change because backend sort might
  // surface different L1/L2 at the top page than the previous sort.
  useEffect(() => {
    setClustersLoading(true);
    fetchPage({
      l1Offset: 0, l1Limit: PAGE_SIZE,
      l2Offset: 0, l2Limit: PAGE_SIZE,
      sort: clusterSort,
      reset: true,
    }).finally(() => setClustersLoading(false));
  }, [clusterSort, fetchPage]);

  // Scroll-triggered next-page loaders. Guard with the in-flight
  // flag so a fast scroll doesn't fire the same offset twice. Guard
  // with `loaded < total` so we stop firing when the section is
  // exhausted — IntersectionObserver still triggers when the
  // sentinel is in view but the handler becomes a noop.
  const loadMoreL1 = useCallback(() => {
    if (loadingMoreL1 || l1Loaded >= totalL1) return;
    setLoadingMoreL1(true);
    fetchPage({
      l1Offset: l1Loaded, l1Limit: PAGE_SIZE,
      l2Offset: 0,        l2Limit: 0,         // don't refetch L2
      sort: clusterSort,
      reset: false,
    }).finally(() => setLoadingMoreL1(false));
  }, [loadingMoreL1, l1Loaded, totalL1, clusterSort, fetchPage]);

  const loadMoreL2 = useCallback(() => {
    if (loadingMoreL2 || l2Loaded >= totalL2) return;
    setLoadingMoreL2(true);
    fetchPage({
      l1Offset: 0,        l1Limit: 0,         // don't refetch L1
      l2Offset: l2Loaded, l2Limit: PAGE_SIZE,
      sort: clusterSort,
      reset: false,
    }).finally(() => setLoadingMoreL2(false));
  }, [loadingMoreL2, l2Loaded, totalL2, clusterSort, fetchPage]);

  // Backend sorts the pages — client side just splits into the two
  // sections preserving insertion order. (Naming kept as *Sorted
  // for diff minimalism; rows are already ordered by the server.)
  const { l1Sorted, l2Sorted } = useMemo(() => {
    const l1 = clusters.filter(c => c.parentClusterId == null);
    const l2 = clusters.filter(c => c.parentClusterId != null);
    return { l1Sorted: l1, l2Sorted: l2 };
  }, [clusters]);

  // Fire semantic NICHE search — embeds the query and finds the
  // closest niche clusters across both L1 and L2. ~1-2s on cache miss,
  // near-instant on cache hit (search_queries cache shared with the
  // older video search).
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
      const res = await fetch('/api/niche-spy/search-niches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed, limit: 200, minSimilarity: 0 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSemanticError(data.error || `HTTP ${res.status}`);
        setSemanticResults([]);
      } else {
        setSemanticResults(data.niches || []);
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
          placeholder="Search niches by meaning — e.g. tired guy at desk, AI YouTube automation, dramatic scary stories…"
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
        Press Enter or hit Search. Returns niches whose representative video sits closest to your query in the joint title+thumbnail multimodal space.
      </p>

      {/* Semantic search results — niche cards (L1 + L2 mixed) ranked
          by cosine similarity. Each card carries a "% match" pill via
          NicheClusterCard's optional similarity field. */}
      {semanticQuery && (
        <div className="mb-6">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-white">
                {semanticLoading
                  ? 'Searching…'
                  : `${filteredResults.length} of ${semanticResults?.length ?? 0} niches for "${semanticQuery}"`}
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

            {/* Min-match % — pure client-side filter over the already-fetched results. */}
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
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
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
            </div>
          ) : (semanticResults && semanticResults.length === 0) ? (
            <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#888]">
              No niches match &ldquo;{semanticQuery}&rdquo;. Try a different phrasing or fewer specifics.
            </div>
          ) : filteredResults.length === 0 ? (
            <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#888]">
              No niches at or above {Math.round(minSimilarity * 100)}% match. Lower the min match to see more.
            </div>
          ) : (
            <div className="space-y-3">
              {filteredResults.map(c => (
                <NicheClusterCard key={c.id} cluster={c} onFindSimilar={() => openSimilar(c)} />
              ))}
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
          <span className="text-sm text-[#888]">
            <span className="text-white font-medium">{totalL1.toLocaleString()}</span> niches
            <span className="mx-1">:</span>
            <span className="text-white font-medium">{totalL2.toLocaleString()}</span> sub-niches
          </span>
        )}
      </div>

      {clustersError && (
        <div className="bg-[#141414] border border-red-500/30 rounded-xl p-4 mb-4 text-sm text-red-400">
          Failed to load clusters: {clustersError}
        </div>
      )}

      {/* Skeleton placeholders during initial load */}
      {clustersLoading && clusters.length === 0 && (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
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
        </div>
      )}

      {/* L1 niches — wide rows so titles + thumbs stay legible.
          ScrollSentinel sits at the bottom of the list and pulls
          the next L1 page in when it enters the viewport. */}
      {l1Sorted.length > 0 && (
        <div className="space-y-3">
          {l1Sorted.map(c => (
            <NicheClusterCard key={c.id} cluster={c} onFindSimilar={() => openSimilar(c)} />
          ))}
          {loadingMoreL1 && (
            <div className="text-center py-4 text-xs text-[#666]">
              Loading more niches…
            </div>
          )}
          <ScrollSentinel onVisible={loadMoreL1} enabled={l1Loaded < totalL1 && !loadingMoreL1} />
        </div>
      )}

      {/* L2 sub-niches — same wide-row card stacked below the L1
          section so an operator can scan the whole tree without
          having to drill into each L1 cluster. Same lazy-load
          pattern via its own ScrollSentinel. */}
      {l2Sorted.length > 0 && (
        <div className="mt-10">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-lg font-bold text-white">Sub-niches</h2>
            <span className="text-xs text-[#666]">
              {l2Sorted.length} of {totalL2.toLocaleString()} L2 clusters across all parents
            </span>
          </div>
          <div className="space-y-3">
            {l2Sorted.map(c => (
              <NicheClusterCard key={c.id} cluster={c} onFindSimilar={() => openSimilar(c)} />
            ))}
            {loadingMoreL2 && (
              <div className="text-center py-4 text-xs text-[#666]">
                Loading more sub-niches…
              </div>
            )}
            <ScrollSentinel onVisible={loadMoreL2} enabled={l2Loaded < totalL2 && !loadingMoreL2} />
          </div>
        </div>
      )}
      </>
      )}

      {/* Mounted at root so it covers the whole page regardless of
          which section spawned it (semantic results, L1 list, L2 list). */}
      <SimilarNichesModal
        sourceCluster={similarSource}
        onClose={() => setSimilarSource(null)}
      />
    </div>
  );
}

