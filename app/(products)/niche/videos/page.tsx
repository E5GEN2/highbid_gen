'use client';

/**
 * /niche/videos
 *
 * All-DB videos view (no niche scope). Powered by /api/niche-spy with
 * keyword=all, so it surfaces every row in niche_spy_videos — including
 * "orphan" rows whose keyword was never assigned to a niche.
 *
 * Pitched as a cross-DB outlier / exploration surface: search by title or
 * channel, sort by score / views / date, filter by score and date range.
 */

import React, { useState, useEffect, useCallback } from 'react';
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

function toCardData(v: VideoRow): NicheVideoCardData {
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

export default function AllVideos() {
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<'score' | 'views' | 'date' | 'oldest' | 'likes'>('views');
  const [minScore, setMinScore] = useState(0);
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');

  // Debounce the text input so every keystroke doesn't hit the API.
  useEffect(() => {
    const h = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(h);
  }, [searchInput]);

  const fetchVideos = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        keyword: 'all', sort, limit: '60', offset: String(offset),
        minScore: String(minScore),
      });
      if (q) params.set('q', q);
      const res = await fetch(`/api/niche-spy?${params}`);
      const data = await res.json();
      if (offset === 0) setVideos(data.videos || []);
      else setVideos(prev => [...prev, ...(data.videos || [])]);
      setTotal(data.total || 0);
    } catch (err) { console.error('All-videos fetch error:', err); }
    setLoading(false);
  }, [sort, minScore, q]);

  useEffect(() => { fetchVideos(0); }, [fetchVideos]);

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
              placeholder="Search titles or channels…"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-xl px-3 py-2 text-sm text-white placeholder-[#555] focus:outline-none focus:border-amber-500"
            />
            {searchInput && (
              <button onClick={() => { setSearchInput(''); setQ(''); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[#666] hover:text-white text-sm">
                ×
              </button>
            )}
          </div>
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
        </div>
      </div>

      {/* Grid — 3-col so each card has room for the title, channel,
          stats and bottom action row. Same shape as the similar-page
          video grid for visual consistency across the product. */}
      {loading && videos.length === 0 ? (
        <div className="text-center text-sm text-[#666] py-12">Loading…</div>
      ) : videos.length === 0 ? (
        <div className="text-center text-sm text-[#666] py-12">No matching videos.</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {videos.map(v => (
              <NicheVideoCard key={v.id} video={toCardData(v)} />
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
      )}
    </div>
  );
}
