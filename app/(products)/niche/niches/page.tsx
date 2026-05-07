'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useNiche } from '@/components/NicheProvider';
import { fmtYT } from '@/lib/format';

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

export default function NichesGrid() {
  const router = useRouter();
  const { setSelectedKeyword } = useNiche();

  const [keywordCards, setKeywordCards] = useState<Array<{
    keyword: string; videoCount: number; channelCount: number; avgScore: number;
    totalViews: number; avgViews: number; highScoreCount: number;
    newChannelCount: number; newestVideo: string | null;
    saturation: { globalSaturation: number; runSaturation: number } | null;
    opportunity: {
      sample: number; nos: number; nosDisplay: number;
      topLeftPct: number; newcomerRate: number; lowSubCeiling: number;
    } | null;
  }>>([]);
  // searchInput = live input value; semanticQuery = committed query
  // (the value that was actually sent to the API). Splitting them lets
  // the user type freely without firing a search per keystroke.
  const [searchInput, setSearchInput] = useState('');
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticResults, setSemanticResults] = useState<SemanticHit[] | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [hitFromCache, setHitFromCache] = useState(false);
  // Min-match % filter — same pattern as the Similar page header.
  // Wide-fetch from the API (limit 500, no server threshold) and let the
  // user dial in how strict the match needs to be without re-querying.
  // Default 0 so users see the full result set first, then filter up.
  const [minSimilarity, setMinSimilarity] = useState(0);

  const [sort, setSort] = useState('videos');
  const [kwLoading, setKwLoading] = useState(true);

  // Niche cards still load (used when no search query is active).
  const fetchKeywords = useCallback(async () => {
    setKwLoading(true);
    try {
      const params = new URLSearchParams({ sort, limit: '200' });
      const res = await fetch(`/api/niche-spy/keywords?${params}`);
      const data = await res.json();
      setKeywordCards(data.keywords);
    } catch (err) { console.error('Keyword fetch error:', err); }
    setKwLoading(false);
  }, [sort]);

  useEffect(() => { fetchKeywords(); }, [fetchKeywords]);

  const selectKeyword = (kw: string) => {
    setSelectedKeyword(kw);
    router.push(`/niche/niches/${encodeURIComponent(kw)}/videos`);
  };

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

  // Same client-side filter pattern as the Similar page: API returns the
  // wide set, the input only changes how much is shown.
  const filteredResults = useMemo(
    () => (semanticResults || []).filter(v => v.similarity >= minSimilarity),
    [semanticResults, minSimilarity],
  );

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Niches</h1>
        <p className="text-sm text-[#888]">Select a niche to explore videos, channels, and insights</p>
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

      {/* Semantic search results — replaces the niche cards while a
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

            {/* Min-match % — same control as the Similar page header.
                Pure client-side filter over the already-fetched 500. */}
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

      {/* Niche cards mode — only shown when no semantic search is active */}
      {!semanticQuery && (
      <>
      {/* Sort pills + Sync */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-2 flex-wrap">
          {[
            { value: 'videos', label: 'Most Videos' },
            { value: 'views', label: 'Most Views' },
            { value: 'score', label: 'Highest Score' },
            { value: 'channels', label: 'Most Channels' },
            { value: 'newest', label: 'Most Recent' },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setSort(opt.value)}
              className={`px-4 py-1.5 rounded-full text-sm transition ${
                sort === opt.value
                  ? 'bg-white text-black font-medium'
                  : 'text-[#888] border border-[#333] hover:border-[#555]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results count */}
      {keywordCards.length > 0 && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm font-medium text-white">{keywordCards.length} niches</span>
        </div>
      )}

      {/* Keyword cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {kwLoading && keywordCards.length === 0 && Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 animate-pulse">
            <div className="flex items-start justify-between mb-3">
              <div className="h-5 w-32 bg-[#1f1f1f] rounded" />
              <div className="h-6 w-12 bg-[#1f1f1f] rounded-lg" />
            </div>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {[1,2,3].map(j => <div key={j}><div className="h-5 w-10 bg-[#1f1f1f] rounded mb-1" /><div className="h-2.5 w-12 bg-[#1a1a1a] rounded" /></div>)}
            </div>
            <div className="flex gap-2">
              <div className="h-2.5 w-14 bg-[#1f1f1f] rounded" />
              <div className="h-2.5 w-16 bg-[#1f1f1f] rounded" />
            </div>
          </div>
        ))}
        {keywordCards.map(kw => (
          <button
            key={kw.keyword}
            onClick={() => selectKeyword(kw.keyword)}
            className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 text-left hover:border-amber-500/60 transition group"
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white group-hover:text-amber-400 transition leading-tight">{kw.keyword}</h3>
                <span className="text-[9px] bg-blue-500/20 text-blue-300 border border-blue-500/30 px-1.5 py-0.5 rounded-full">manual</span>
              </div>
              <span className={`text-xs px-2 py-1 rounded-lg font-bold ${
                kw.avgScore >= 80 ? 'bg-green-500/20 text-green-400' :
                kw.avgScore >= 50 ? 'bg-yellow-500/20 text-yellow-400' :
                'bg-red-500/20 text-red-400'
              }`}>⚡ {kw.avgScore}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div>
                <div className="text-lg font-bold text-white">{kw.videoCount}</div>
                <div className="text-xs text-[#666]">videos</div>
              </div>
              <div>
                <div className="text-lg font-bold text-blue-400">{kw.channelCount}</div>
                <div className="text-xs text-[#666]">channels</div>
              </div>
              <div>
                <div className="text-lg font-bold text-green-400">{fmtYT(kw.totalViews)}</div>
                <div className="text-xs text-[#666]">views</div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-[#666]">
              {kw.newChannelCount > 0 && <span className="text-orange-400">{kw.newChannelCount} new ch</span>}
              <span>{kw.highScoreCount} high score</span>
              {kw.saturation && (
                <span className={kw.saturation.globalSaturation >= 90 ? 'text-red-400' : kw.saturation.globalSaturation >= 70 ? 'text-yellow-400' : 'text-green-400'}>
                  {kw.saturation.globalSaturation}% sat
                </span>
              )}
            </div>

            {/* Opportunity indicators — 4 compact pills with hover tooltips.
                When not enough data (<10 high-score videos), render dimmed placeholder
                pills so every card has the same height and the missing data is legible. */}
            {kw.opportunity ? (
              <div className="grid grid-cols-4 gap-1.5 mt-3 pt-3 border-t border-[#1f1f1f]">
                <IndicatorPill
                  label="OPP"
                  value={`${kw.opportunity.nosDisplay}`}
                  band={kw.opportunity.nos >= 1.3 ? 'green' : kw.opportunity.nos >= 1.0 ? 'yellow' : 'red'}
                  tooltip={
                    <>
                      <div className="font-semibold text-white mb-1">Opportunity Score</div>
                      <div>Median of <code className="text-amber-400">log(views)/log(subs)</code> across high-score videos. Higher = small creators get pushed.</div>
                      <div className="mt-1.5 text-[#888]">Raw NOS: {kw.opportunity.nos.toFixed(2)} · {kw.opportunity.sample} videos</div>
                      <div className="mt-2 space-y-0.5">
                        <div><span className="text-green-400">≥ 70</span> Low barrier, high reward</div>
                        <div><span className="text-yellow-400">40–70</span> Normal — views scale with subs</div>
                        <div><span className="text-red-400">&lt; 40</span> Saturated — big channels win</div>
                      </div>
                    </>
                  }
                />
                <IndicatorPill
                  label="TOP"
                  value={`${kw.opportunity.topLeftPct}%`}
                  band={kw.opportunity.topLeftPct >= 30 ? 'green' : kw.opportunity.topLeftPct >= 10 ? 'yellow' : 'red'}
                  tooltip={
                    <>
                      <div className="font-semibold text-white mb-1">Top-Left Density</div>
                      <div>% of videos with above-median views AND below-median subs — the goldmine quadrant of the scatter.</div>
                      <div className="mt-2 space-y-0.5">
                        <div><span className="text-green-400">≥ 30%</span> Lots of underdog wins</div>
                        <div><span className="text-yellow-400">10–30%</span> Healthy mix</div>
                        <div><span className="text-red-400">&lt; 10%</span> Views tightly coupled to subs</div>
                      </div>
                    </>
                  }
                />
                <IndicatorPill
                  label="NEW"
                  value={`${kw.opportunity.newcomerRate}%`}
                  band={kw.opportunity.newcomerRate >= 80 ? 'green' : kw.opportunity.newcomerRate >= 50 ? 'yellow' : 'red'}
                  tooltip={
                    <>
                      <div className="font-semibold text-white mb-1">Newcomer Success</div>
                      <div>Median views of channels &lt;6 months old, divided by the niche&apos;s overall median. 100% = newcomers land in the same ballpark as veterans.</div>
                      <div className="mt-2 space-y-0.5">
                        <div><span className="text-green-400">≥ 80%</span> Age doesn&apos;t matter</div>
                        <div><span className="text-yellow-400">50–80%</span> Small established-channel bonus</div>
                        <div><span className="text-red-400">&lt; 50%</span> Tough for new entrants</div>
                      </div>
                    </>
                  }
                />
                <IndicatorPill
                  label="CEIL"
                  value={fmtYT(kw.opportunity.lowSubCeiling)}
                  band={kw.opportunity.lowSubCeiling >= 500000 ? 'green' : kw.opportunity.lowSubCeiling >= 100000 ? 'yellow' : 'red'}
                  tooltip={
                    <>
                      <div className="font-semibold text-white mb-1">Low-Sub Ceiling</div>
                      <div>p90 of views among videos from channels with &lt;10K subs. Shows what a single video can realistically achieve before you have an audience.</div>
                      <div className="mt-2 space-y-0.5">
                        <div><span className="text-green-400">≥ 500K</span> Videos can explode with a tiny channel</div>
                        <div><span className="text-yellow-400">100K–500K</span> Solid upside per video</div>
                        <div><span className="text-red-400">&lt; 100K</span> Slow, linear growth</div>
                      </div>
                    </>
                  }
                />
              </div>
            ) : (
              // Not enough data yet — render dimmed placeholder pills to keep
              // card height consistent across the grid.
              <div className="grid grid-cols-4 gap-1.5 mt-3 pt-3 border-t border-[#1f1f1f]">
                {(['OPP', 'TOP', 'NEW', 'CEIL'] as const).map(label => (
                  <IndicatorPill
                    key={label}
                    label={label}
                    value="—"
                    band="empty"
                    tooltip={
                      <>
                        <div className="font-semibold text-white mb-1">Not enough data yet</div>
                        <div>Opportunity indicators need at least 10 high-score videos (score ≥ 80) in the niche to produce a reliable signal. Keep collecting and they&apos;ll populate automatically.</div>
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
      </>
      )}
    </div>
  );
}

/** Small indicator pill with hover tooltip. Stops bubble so hovering doesn't trigger card click visuals. */
function IndicatorPill({
  label, value, band, tooltip,
}: {
  label: string;
  value: string;
  band: 'green' | 'yellow' | 'red' | 'empty';
  tooltip: React.ReactNode;
}) {
  const colors = {
    green: 'text-green-400 bg-green-500/10 border-green-500/20',
    yellow: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    red: 'text-red-400 bg-red-500/10 border-red-500/20',
    empty: 'text-[#555] bg-[#1a1a1a]/40 border-[#1f1f1f] border-dashed',
  };
  return (
    <div
      className="relative group/pill"
      onClick={(e) => { e.stopPropagation(); }}
    >
      <div className={`flex flex-col items-center justify-center rounded-md border px-1.5 py-1 cursor-help ${colors[band]}`}>
        <div className="text-[8px] uppercase tracking-wider opacity-70">{label}</div>
        <div className="text-xs font-bold leading-tight">{value}</div>
      </div>
      {/* Tooltip — uses NAMED group so only this specific pill's hover triggers it,
          not the outer card button (which also has `group` for title color). */}
      <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 p-3 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-[11px] text-[#ccc] leading-relaxed shadow-xl opacity-0 group-hover/pill:opacity-100 transition-opacity z-50 text-left">
        {tooltip}
      </div>
    </div>
  );
}
