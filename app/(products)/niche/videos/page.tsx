'use client';

/**
 * /niche/videos
 *
 * All-DB videos view (no niche scope). Two query modes share the
 * same grid:
 *   - Default: filter by sort + minScore via /api/niche-spy with
 *     keyword=all (no semantic embedding involved).
 *   - Semantic: hit Enter / Search → /api/niche-spy/search-semantic
 *     embeds the query and ranks the whole corpus by combined_v2
 *     cosine similarity. Adds a "% match" pill to each card and a
 *     Min match % filter so the user can dial in the threshold.
 *
 * Sort pills + Min score still apply to the default mode. They're
 * hidden when a semantic query is active because semantic results
 * are inherently ranked by similarity.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { NicheVideoCard, type NicheVideoCardData } from '@/components/NicheVideoCard';

interface VideoRow {
  id: number;
  keyword: string | null;
  url: string;
  title: string;
  view_count: number;
  channel_name: string | null;
  posted_at: string | null;
  posted_date: string | null;
  score: number;
  subscriber_count: number;
  like_count: number;
  comment_count: number;
  thumbnail: string | null;
  channel_created_at: string | null;
  first_upload_at: string | null;
  dormancy_days: number | null;
}

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

function rowToCardData(v: VideoRow): NicheVideoCardData {
  return {
    id: v.id,
    url: v.url,
    title: v.title,
    thumbnail: v.thumbnail,
    channelName: v.channel_name,
    viewCount: v.view_count,
    likeCount: v.like_count,
    subscriberCount: v.subscriber_count,
    channelCreatedAt: v.channel_created_at,
    firstUploadAt: v.first_upload_at,
    dormancyDays: v.dormancy_days,
    postedAt: v.posted_at,
    postedDate: v.posted_date,
    score: v.score,
  };
}

function hitToCardData(v: SemanticHit): NicheVideoCardData {
  return {
    id: v.id,
    url: v.url,
    title: v.title,
    thumbnail: v.thumbnail,
    channelName: v.channelName,
    viewCount: v.viewCount,
    likeCount: v.likeCount,
    subscriberCount: v.subscriberCount,
    channelCreatedAt: v.channelCreatedAt,
    firstUploadAt: v.firstUploadAt,
    dormancyDays: v.dormancyDays,
    postedAt: v.postedAt,
    postedDate: v.postedDate,
    score: v.score,
    similarity: v.similarity,
  };
}

export default function AllVideos() {
  // Default-mode (sort + filter) state
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<'score' | 'views' | 'date' | 'oldest' | 'likes'>('views');
  const [minScore, setMinScore] = useState(0);

  // Search box — input is the live text, semanticQuery is the
  // committed query that's been sent to the embed-and-search endpoint.
  // Splitting them lets the user type freely without firing a search
  // per keystroke.
  const [searchInput, setSearchInput] = useState('');
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticResults, setSemanticResults] = useState<SemanticHit[] | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [hitFromCache, setHitFromCache] = useState(false);
  // Wide-fetch from the API (limit 500) and let the user dial in the
  // strictness via Min match % without re-querying. Default 0 so users
  // see the full result set first, then filter up.
  const [minSimilarity, setMinSimilarity] = useState(0);

  const fetchVideos = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        keyword: 'all', sort, limit: '60', offset: String(offset),
        minScore: String(minScore),
      });
      const res = await fetch(`/api/niche-spy?${params}`);
      const data = await res.json();
      if (offset === 0) setVideos(data.videos || []);
      else setVideos(prev => [...prev, ...(data.videos || [])]);
      setTotal(data.total || 0);
    } catch (err) { console.error('All-videos fetch error:', err); }
    setLoading(false);
  }, [sort, minScore]);

  useEffect(() => {
    // Skip the default fetch while a semantic query is active — the
    // semantic results take over the grid and we don't want to waste
    // a round trip backing them with substring data.
    if (!semanticQuery) fetchVideos(0);
  }, [fetchVideos, semanticQuery]);

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

  const filteredHits = useMemo(
    () => (semanticResults || []).filter(v => v.similarity >= minSimilarity),
    [semanticResults, minSimilarity],
  );

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Search + sort bar */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[220px] max-w-xl">
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSemanticSearch(searchInput); }}
              placeholder="Search videos by meaning — e.g. tired guy at desk, AI YouTube automation…"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-xl px-3 py-2 pr-20 text-sm text-white placeholder-[#555] focus:outline-none focus:border-amber-500"
              disabled={semanticLoading}
            />
            {(semanticQuery || searchInput) && (
              <button onClick={clearSearch}
                className="absolute right-12 top-1/2 -translate-y-1/2 text-[#666] hover:text-white text-sm" title="Clear">
                ×
              </button>
            )}
            <button
              type="button"
              onClick={() => runSemanticSearch(searchInput)}
              disabled={semanticLoading || !searchInput.trim()}
              className="absolute right-1 top-1/2 -translate-y-1/2 px-2.5 py-1 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold rounded-md text-xs"
            >
              {semanticLoading ? '…' : 'Search'}
            </button>
          </div>

          {/* Sort + min-score only apply to default-mode (no semantic
              query). Semantic results are inherently ranked by
              similarity so showing the sort pills there would be
              misleading. */}
          {!semanticQuery && (
            <>
              <div className="flex gap-2 flex-wrap">
                {[
                  { value: 'views', label: 'Top Views' },
                  { value: 'score', label: 'Score' },
                  { value: 'date', label: 'Newest' },
                  { value: 'likes', label: 'Most Liked' },
                  { value: 'oldest', label: 'Oldest' },
                ].map(opt => (
                  <button key={opt.value} onClick={() => setSort(opt.value as typeof sort)}
                    className={`px-4 py-1.5 rounded-full text-sm transition ${
                      sort === opt.value ? 'bg-white text-black font-medium' : 'text-[#888] border border-[#333] hover:border-[#555]'
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-[#888]">Min score</label>
                <select value={minScore} onChange={e => setMinScore(parseInt(e.target.value))}
                  className="bg-[#0a0a0a] border border-[#2a2a2a] text-white text-xs rounded-md px-2 py-1">
                  <option value={0}>Any</option>
                  <option value={50}>50+</option>
                  <option value={70}>70+</option>
                  <option value={80}>80+</option>
                  <option value={90}>90+</option>
                </select>
              </div>
              <span className="text-sm font-medium text-white">{total.toLocaleString()} videos</span>
            </>
          )}

          {/* Min match % — only shown while a semantic query is active.
              Pure client-side filter over the already-fetched 500. */}
          {semanticQuery && semanticResults && semanticResults.length > 0 && (
            <>
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
              <span className="text-sm font-medium text-white">
                {filteredHits.length} of {semanticResults.length} videos
              </span>
              {hitFromCache && (
                <span className="text-[10px] uppercase tracking-wider bg-[#1a1a1a] border border-[#333] text-[#888] px-1.5 py-0.5 rounded-full" title="Vector reused from a previous query — no Gemini call">
                  cache hit
                </span>
              )}
            </>
          )}
        </div>
        {!semanticQuery && (
          <p className="text-[11px] text-[#555] mt-2">
            Press Enter or hit Search for semantic matching across the whole library — combined v2 multimodal embeddings rank by query meaning, not just keyword.
          </p>
        )}
      </div>

      {/* Grid */}
      {semanticQuery ? (
        // Semantic-search mode
        semanticLoading && !semanticResults ? (
          <div className="text-center text-sm text-[#666] py-12">Searching…</div>
        ) : semanticError ? (
          <div className="bg-[#141414] border border-red-500/30 rounded-xl p-6 text-sm text-red-400">
            Search failed: {semanticError}
          </div>
        ) : (semanticResults && semanticResults.length === 0) ? (
          <div className="text-center text-sm text-[#666] py-12">
            No videos match &ldquo;{semanticQuery}&rdquo;. Try a different phrasing.
          </div>
        ) : filteredHits.length === 0 ? (
          <div className="text-center text-sm text-[#666] py-12">
            No videos at or above {Math.round(minSimilarity * 100)}% match. Lower the min match to see more.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredHits.map(v => (
              <NicheVideoCard key={v.id} video={hitToCardData(v)} />
            ))}
          </div>
        )
      ) : (
        // Default mode (sort + filter)
        loading && videos.length === 0 ? (
          <div className="text-center text-sm text-[#666] py-12">Loading…</div>
        ) : videos.length === 0 ? (
          <div className="text-center text-sm text-[#666] py-12">No matching videos.</div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {videos.map(v => (
                <NicheVideoCard key={v.id} video={rowToCardData(v)} />
              ))}
            </div>
            {videos.length < total && (
              <div className="text-center mt-6">
                <button onClick={() => fetchVideos(videos.length)} disabled={loading}
                  className="px-6 py-2 bg-white/10 hover:bg-white/15 text-white rounded-xl text-sm transition">
                  {loading ? 'Loading...' : `Load More (${videos.length.toLocaleString()}/${total.toLocaleString()})`}
                </button>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
