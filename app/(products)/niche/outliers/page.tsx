'use client';

/**
 * /niche/outliers
 *
 * Dedicated outlier-discovery surface, modelled on Nexlev's Faceless
 * Outliers page. Shows a video grid where each video's channel has been
 * scored against its subscriber-tier peers (see
 * /api/admin/outliers/recompute for the algorithm).
 *
 * Features:
 *   - Search across title + channel
 *   - Preset quick-filters (viral-on-small, above-1M, high-outlier, etc.)
 *   - Long vs Short toggle
 *   - Random shuffle (re-fetches with a random offset)
 *   - Hide Seen Videos (client-side, localStorage)
 *   - Outlier multiplier badge on each card, color-coded by magnitude
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { fmtYT } from '@/lib/format';

type Preset = '' | 'viral_small' | 'viral_medium' | 'above_1m' | 'high_outlier' | 'high_views_few_vids';
type VideoType = '' | 'long' | 'short';

interface OutlierVideo {
  id: number;
  url: string;
  title: string;
  viewCount: number;
  channelName: string | null;
  channelId: string | null;
  channelHandle: string | null;
  channelAvatar: string | null;
  subscriberCount: number | null;
  postedAt: string | null;
  likeCount: number;
  commentCount: number;
  thumbnail: string | null;
  keyword: string | null;
  peerOutlierScore: number | null;
  peerOutlierBucket: string | null;
  channelCreatedAt: string | null;
  firstUploadAt: string | null;
  dormancyDays: number | null;
  channelVideoCount: number | null;
  isShort: boolean;
}

const SEEN_STORAGE_KEY = 'niche_outliers_seen';

/** Returns a color tier for the outlier multiplier badge — matches Nexlev's
 *  palette (green for modest, purple/pink for egregious). */
function outlierBadgeColor(score: number | null): { bg: string; text: string } {
  if (score == null) return { bg: 'bg-gray-700', text: 'text-gray-300' };
  if (score >= 20)   return { bg: 'bg-purple-600', text: 'text-white' };
  if (score >= 10)   return { bg: 'bg-pink-600',   text: 'text-white' };
  if (score >= 5)    return { bg: 'bg-green-600',  text: 'text-white' };
  if (score >= 2)    return { bg: 'bg-green-700',  text: 'text-green-100' };
  return { bg: 'bg-gray-700', text: 'text-gray-300' };
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1)  return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}yr ago`;
}

export default function OutliersPage() {
  const [videos, setVideos] = useState<OutlierVideo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [preset, setPreset] = useState<Preset>('');
  const [type, setType] = useState<VideoType>('long');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  // Recency window — '' = server default (~7mo), 'all' = no filter, else N days.
  // Matches Nexlev's behaviour of mostly surfacing videos from the last few
  // months; stale outliers aren't actionable for someone picking a niche today.
  const [recency, setRecency] = useState<'' | 'all' | '30' | '90' | '180' | '365'>('');
  const [hideSeen, setHideSeen] = useState(false);
  const [seenIds, setSeenIds] = useState<Set<number>>(new Set());
  // Bumping `shuffleSeed` triggers a refetch with a random offset, giving
  // the same effect as Nexlev's "Random" button.
  const [shuffleSeed, setShuffleSeed] = useState(0);


  // Load the set of seen video IDs from localStorage on mount. We persist
  // client-side only — no server-side "seen" state, keeps it simple.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SEEN_STORAGE_KEY);
      if (raw) setSeenIds(new Set(JSON.parse(raw) as number[]));
    } catch {
      /* ignore — corrupt localStorage just resets the seen set */
    }
  }, []);

  // Debounce search input so every keystroke doesn't refetch.
  useEffect(() => {
    const h = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(h);
  }, [searchInput]);

  const fetchVideos = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '60', offset: String(offset) });
      if (preset) params.set('preset', preset);
      if (type)   params.set('type', type);
      if (q)      params.set('q', q);
      // Recency: '' (default) omits the param so the server applies its
      // default 210-day window. 'all' sends an empty string which parses
      // to null server-side → no recency filter. Specific days pass through.
      if (recency === 'all') params.set('postedWithin', '');
      else if (recency !== '') params.set('postedWithin', recency);
      const res = await fetch(`/api/niche-spy/outliers?${params}`);
      const data = await res.json();
      const list: OutlierVideo[] = data.videos || [];
      if (offset === 0) setVideos(list);
      else setVideos(prev => [...prev, ...list]);
      setTotal(data.total || 0);
    } catch (err) { console.error('Outliers fetch error:', err); }
    setLoading(false);
  }, [preset, type, q, recency]);

  useEffect(() => { fetchVideos(0); }, [fetchVideos, shuffleSeed]);

  const markSeen = (id: number) => {
    setSeenIds(prev => {
      const next = new Set(prev); next.add(id);
      try { localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(Array.from(next))); } catch { /* quota */ }
      return next;
    });
  };
  const clearSeen = () => {
    setSeenIds(new Set());
    try { localStorage.removeItem(SEEN_STORAGE_KEY); } catch { /* ignore */ }
  };

  const visibleVideos = useMemo(
    () => hideSeen ? videos.filter(v => !seenIds.has(v.id)) : videos,
    [videos, hideSeen, seenIds],
  );

  const presetChips: Array<{ value: Preset; label: string }> = [
    { value: '',                    label: 'All Videos' },
    { value: 'viral_small',         label: 'Viral on small channels' },
    { value: 'viral_medium',        label: 'Viral on medium channels' },
    { value: 'above_1m',            label: 'Above 1M Video Views' },
    { value: 'high_outlier',        label: 'High outlier score' },
    { value: 'high_views_few_vids', label: 'High Views, Few Videos' },
  ];

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Top bar — search + type toggle + action buttons */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <div className="relative flex-1 min-w-[240px] max-w-xl">
          <input
            type="text"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search Outliers"
            className="w-full bg-[#141414] border border-[#2a2a2a] rounded-xl pl-10 pr-3 py-2.5 text-sm text-white placeholder-[#555] focus:outline-none focus:border-amber-500"
          />
          <svg className="w-4 h-4 text-[#555] absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        {/* Long / Short toggle — matches the red YT / pink Shorts pill on
            Nexlev's layout. */}
        <div className="flex gap-1.5">
          <button
            onClick={() => setType('long')}
            title="Long videos"
            className={`w-10 h-10 rounded-lg flex items-center justify-center transition ${
              type === 'long' ? 'bg-red-600 text-white' : 'bg-[#141414] text-[#888] border border-[#2a2a2a] hover:border-[#555]'
            }`}
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg>
          </button>
          <button
            onClick={() => setType('short')}
            title="Shorts"
            className={`w-10 h-10 rounded-lg flex items-center justify-center transition ${
              type === 'short' ? 'bg-pink-600 text-white' : 'bg-[#141414] text-[#888] border border-[#2a2a2a] hover:border-[#555]'
            }`}
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.77 10.32l-1.2-.5L18 9.06c1.84-1 2.53-3.37 1.54-5.22-.74-1.17-1.79-1.64-2.89-1.64-.61 0-1.24.17-1.83.48L6.14 7c-1.31.62-2.16 1.97-2.14 3.42.12 1.47.97 2.75 2.29 3.37l1.2.5L6 14.94c-1.84 1-2.53 3.37-1.54 5.22.66 1.24 1.95 1.97 3.3 1.97.58 0 1.16-.14 1.7-.43L17.86 17c1.31-.62 2.16-1.97 2.14-3.42-.12-1.47-.97-2.75-2.29-3.37l.06.11z"/></svg>
          </button>
        </div>

        <button
          onClick={() => { setShuffleSeed(s => s + 1); setPreset(''); setSearchInput(''); setQ(''); }}
          className="px-4 py-2 bg-[#141414] border border-[#2a2a2a] text-white text-sm rounded-xl hover:border-[#555] transition flex items-center gap-1.5"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Random
        </button>

        <button
          onClick={() => setHideSeen(v => !v)}
          className={`px-4 py-2 text-sm rounded-xl transition flex items-center gap-1.5 ${
            hideSeen ? 'bg-amber-500 text-black font-medium' : 'bg-[#141414] border border-[#2a2a2a] text-white hover:border-[#555]'
          }`}
          title={hideSeen ? 'Showing only unseen' : 'Hide videos you have already seen'}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
          </svg>
          Hide Seen Videos
          {seenIds.size > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${hideSeen ? 'bg-black/25' : 'bg-[#2a2a2a]'}`}>
              {seenIds.size}
            </span>
          )}
        </button>

        {seenIds.size > 0 && (
          <button onClick={clearSeen} className="text-xs text-[#666] hover:text-white transition ml-auto">
            Reset seen
          </button>
        )}
      </div>

      {/* Preset chip row — horizontally scrollable if narrow */}
      <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
        {presetChips.map(p => (
          <button
            key={p.value || 'all'}
            onClick={() => setPreset(p.value)}
            className={`flex-shrink-0 px-4 py-1.5 rounded-full text-xs whitespace-nowrap transition ${
              preset === p.value
                ? 'bg-white text-black font-medium'
                : 'bg-[#141414] border border-[#2a2a2a] text-[#ccc] hover:border-[#555]'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Recency chips — second row. Default '' sends no param → server
          applies its 8mo window. 'all' sends empty → server disables the
          filter. Everything else is a literal day count. */}
      <div className="flex items-center gap-2 mb-6 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-[#666] mr-1">Posted</span>
        {([
          { value: '30',  label: 'Last 30 days' },
          { value: '90',  label: 'Last 3mo' },
          { value: '180', label: 'Last 6mo' },
          { value: '',    label: 'Last 8mo (default)' },
          { value: '365', label: 'Last 1yr' },
          { value: 'all', label: 'All time' },
        ] as const).map(opt => (
          <button key={opt.value || 'default'}
            onClick={() => setRecency(opt.value as typeof recency)}
            className={`px-2.5 py-1 rounded-full text-[11px] transition ${
              recency === opt.value
                ? 'bg-amber-500 text-black font-medium'
                : 'text-[#888] border border-[#333] hover:border-[#555]'
            }`}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* Section title + count */}
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-semibold text-white flex items-center gap-2">
          <svg className="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 24 24"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg>
          {type === 'short' ? 'Shorts' : 'Long videos'}
        </h2>
        <span className="text-xs text-[#666]">{total.toLocaleString()} results</span>
      </div>

      {/* Grid */}
      {loading && videos.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden animate-pulse">
              <div className="aspect-video bg-[#1f1f1f]" />
              <div className="p-4 space-y-2">
                <div className="h-4 bg-[#1f1f1f] rounded w-3/4" />
                <div className="h-3 bg-[#1a1a1a] rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : visibleVideos.length === 0 ? (
        <div className="text-center text-sm text-[#666] py-16">
          No outliers match these filters. Try removing a preset or widening the search.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {visibleVideos.map(v => {
              const badge = outlierBadgeColor(v.peerOutlierScore);
              const seen = seenIds.has(v.id);
              return (
                <div
                  key={v.id}
                  className={`bg-[#141414] border rounded-xl overflow-hidden transition flex flex-col ${
                    seen ? 'border-[#1a1a1a] opacity-60' : 'border-[#1f1f1f] hover:border-[#333]'
                  }`}
                >
                  {/* Thumbnail — click opens the video, also marks as seen */}
                  <a
                    href={v.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => markSeen(v.id)}
                    className="relative block aspect-video bg-[#0a0a0a] group"
                  >
                    {v.thumbnail && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={v.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                    )}
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition" />
                  </a>
                  <div className="p-4 flex-1 flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-sm font-semibold text-white line-clamp-2 flex-1" title={v.title}>
                        {v.title}
                      </h3>
                      {/* Outlier multiplier badge — color coded */}
                      {v.peerOutlierScore != null && (
                        <span
                          className={`flex-shrink-0 text-[11px] font-bold px-2 py-0.5 rounded-full ${badge.bg} ${badge.text}`}
                          title={`Channel pulls ${v.peerOutlierScore.toFixed(1)}x the median avg-views of channels in the ${v.peerOutlierBucket} subscriber bucket`}
                        >
                          {v.peerOutlierScore.toFixed(v.peerOutlierScore >= 10 ? 0 : 2)}x
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-[#888] min-w-0">
                      {v.channelName && (
                        <span className="truncate">{v.channelName}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-[#888] mt-auto">
                      <span className="text-green-400 font-medium">{fmtYT(v.viewCount)} views</span>
                      <span>· {timeAgo(v.postedAt)}</span>
                      {v.subscriberCount != null && v.subscriberCount > 0 && (
                        <span className="text-[#666]">· {fmtYT(v.subscriberCount)} subs</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {visibleVideos.length < total && (
            <div className="text-center mt-6">
              <button onClick={() => fetchVideos(videos.length)} disabled={loading}
                className="px-6 py-2 bg-white/10 hover:bg-white/15 text-white rounded-xl text-sm transition">
                {loading ? 'Loading...' : `Load More (${visibleVideos.length}/${total.toLocaleString()})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
