'use client';

/**
 * /niche/channels
 *
 * All-DB channels view. Aggregates across every keyword in niche_spy_videos
 * (including videos with no keyword assignment) so a single channel that
 * appears in multiple niches is collapsed to one card. Primary use case is
 * finding outliers no niche-scoped page would surface — e.g. a brand-new
 * channel with 1 video at 10× its own average.
 *
 * Same UI + filter shape as the per-keyword Channels page, but:
 *   - No keyword scope (API called with keyword=all)
 *   - New "Outlier" sort option (MAX(views) / AVG(views) per channel)
 *   - Outlier multiplier badge on each card, color-coded
 */

import React, { useState, useCallback, useEffect } from 'react';
import { fmtYT } from '@/lib/format';
import { NicheChannelCard, type ChannelCardData } from '@/components/NicheChannelCard';

type DbChannel = ChannelCardData;

export default function AllChannels() {
  const [channels, setChannels] = useState<DbChannel[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<{
    totalChannels: number; newChannels: number; veryNewChannels: number; establishedChannels: number;
    newAvgSubs: number; estAvgSubs: number;
  } | null>(null);
  const [sort, setSort] = useState<'views' | 'videos' | 'subs' | 'newest' | 'score'>('views');
  const [maxAge, setMaxAge] = useState('');
  const [loading, setLoading] = useState(false);

  // Custom filter ranges (same as niche-scoped channels page).
  const [minAgeDays, setMinAgeDays] = useState('');
  const [maxAgeDaysCustom, setMaxAgeDaysCustom] = useState('');
  const [minSubs, setMinSubs] = useState('');
  const [maxSubs, setMaxSubs] = useState('');
  const [minViews, setMinViews] = useState('');
  const [maxViews, setMaxViews] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const customFiltersActive = [minAgeDays, maxAgeDaysCustom, minSubs, maxSubs, minViews, maxViews]
    .filter(v => v.trim() !== '').length;

  const fetchChannels = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        keyword: 'all', sort, limit: '60', offset: String(offset),
      });
      if (maxAge) params.set('maxAge', maxAge);
      if (minAgeDays.trim())      params.set('minAge', minAgeDays.trim());
      if (maxAgeDaysCustom.trim()) params.set('maxAgeCustom', maxAgeDaysCustom.trim());
      if (minSubs.trim())         params.set('minSubs', minSubs.trim());
      if (maxSubs.trim())         params.set('maxSubs', maxSubs.trim());
      if (minViews.trim())        params.set('minViews', minViews.trim());
      if (maxViews.trim())        params.set('maxViews', maxViews.trim());
      const res = await fetch(`/api/niche-spy/channels?${params}`);
      const data = await res.json();
      if (offset === 0) setChannels(data.channels);
      else setChannels(prev => [...prev, ...data.channels]);
      setTotal(data.total);
      setStats(data.stats);
    } catch (err) { console.error('Channel fetch error:', err); }
    setLoading(false);
  }, [sort, maxAge, minAgeDays, maxAgeDaysCustom, minSubs, maxSubs, minViews, maxViews]);

  useEffect(() => { fetchChannels(0); }, [fetchChannels]);

  useEffect(() => {
    if (!filtersOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFiltersOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [filtersOpen]);

  const resetCustomFilters = () => {
    setMinAgeDays(''); setMaxAgeDaysCustom('');
    setMinSubs(''); setMaxSubs('');
    setMinViews(''); setMaxViews('');
  };

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Filters */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-2 flex-wrap flex-1">
            {[
              { value: 'views', label: 'Total Views' },
              { value: 'videos', label: 'Video Count' },
              { value: 'subs', label: 'Subscribers' },
              { value: 'newest', label: 'Newest' },
              { value: 'score', label: 'Avg Score' },
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
            {[
              { value: '', label: 'All' },
              { value: '30', label: '30d' },
              { value: '90', label: '3mo' },
              { value: '180', label: '6mo' },
              { value: '365', label: '1yr' },
            ].map(opt => (
              <button key={opt.value} onClick={() => setMaxAge(opt.value)}
                className={`px-3 py-1 rounded-full text-xs transition ${
                  maxAge === opt.value ? 'bg-amber-500 text-black font-medium' : 'text-[#888] border border-[#333] hover:border-[#555]'
                }`}>
                {opt.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <button
              onClick={() => setFiltersOpen(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs transition ${
                customFiltersActive > 0 || filtersOpen
                  ? 'bg-amber-500 text-black font-medium'
                  : 'text-[#888] border border-[#333] hover:border-[#555]'
              }`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              Filters
              {customFiltersActive > 0 && (
                <span className="ml-0.5 bg-black/30 text-[10px] px-1.5 py-0 rounded-full min-w-[16px] text-center">
                  {customFiltersActive}
                </span>
              )}
            </button>
            {filtersOpen && (
              <div className="absolute right-0 top-full mt-2 w-[320px] bg-[#141414] border border-[#2a2a2a] rounded-xl shadow-xl z-40 p-4">
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-[#888]">Channel age (days)</label>
                    <div className="flex gap-2 mt-1">
                      <input type="number" min={0} inputMode="numeric" value={minAgeDays}
                        onChange={e => setMinAgeDays(e.target.value)} placeholder="Min"
                        className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded-md px-2.5 py-1.5 text-xs text-white placeholder-[#555] focus:outline-none focus:border-amber-500" />
                      <input type="number" min={0} inputMode="numeric" value={maxAgeDaysCustom}
                        onChange={e => setMaxAgeDaysCustom(e.target.value)} placeholder="Max"
                        className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded-md px-2.5 py-1.5 text-xs text-white placeholder-[#555] focus:outline-none focus:border-amber-500" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-[#888]">Subscribers</label>
                    <div className="flex gap-2 mt-1">
                      <input type="number" min={0} inputMode="numeric" value={minSubs}
                        onChange={e => setMinSubs(e.target.value)} placeholder="Min"
                        className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded-md px-2.5 py-1.5 text-xs text-white placeholder-[#555] focus:outline-none focus:border-amber-500" />
                      <input type="number" min={0} inputMode="numeric" value={maxSubs}
                        onChange={e => setMaxSubs(e.target.value)} placeholder="Max"
                        className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded-md px-2.5 py-1.5 text-xs text-white placeholder-[#555] focus:outline-none focus:border-amber-500" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-[#888]">Total views (DB-wide)</label>
                    <div className="flex gap-2 mt-1">
                      <input type="number" min={0} inputMode="numeric" value={minViews}
                        onChange={e => setMinViews(e.target.value)} placeholder="Min"
                        className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded-md px-2.5 py-1.5 text-xs text-white placeholder-[#555] focus:outline-none focus:border-amber-500" />
                      <input type="number" min={0} inputMode="numeric" value={maxViews}
                        onChange={e => setMaxViews(e.target.value)} placeholder="Max"
                        className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded-md px-2.5 py-1.5 text-xs text-white placeholder-[#555] focus:outline-none focus:border-amber-500" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-[#2a2a2a]">
                    <button onClick={resetCustomFilters} disabled={customFiltersActive === 0}
                      className="text-[11px] text-[#888] hover:text-white disabled:text-[#444] disabled:hover:text-[#444] transition">
                      Reset
                    </button>
                    <button onClick={() => setFiltersOpen(false)}
                      className="text-[11px] bg-amber-500 text-black hover:bg-amber-400 font-medium px-3 py-1 rounded-full transition">
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <span className="text-sm font-medium text-white">{total.toLocaleString()} channels</span>
        </div>
      </div>

      {/* Stats summary */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
          {[
            { label: 'Total', value: stats.totalChannels, color: 'text-white' },
            { label: '<30 days', value: stats.veryNewChannels, color: 'text-orange-400' },
            { label: '<6 months', value: stats.newChannels, color: 'text-green-400' },
            { label: 'Established', value: stats.establishedChannels, color: 'text-[#888]' },
            { label: 'New Avg Subs', value: fmtYT(stats.newAvgSubs), color: 'text-green-400' },
            { label: 'Est Avg Subs', value: fmtYT(stats.estAvgSubs), color: 'text-[#888]' },
          ].map((s, i) => (
            <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-3 text-center">
              <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-[#666]">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Wide-row channel cards — same shape as the niche cluster cards
          (avatar+meta header, 4-tile stat row, 4-thumb popular-videos
          strip with titles) so the user gets a glimpse of what each
          channel actually makes instead of just numbers. */}
      {loading && channels.length === 0 ? (
        <div className="text-center text-sm text-[#666] py-12">Loading…</div>
      ) : (
        <>
          <div className="space-y-3">
            {channels.map(ch => (
              <NicheChannelCard key={`${ch.channelId || ch.channelName}`} channel={ch} />
            ))}
          </div>

          {channels.length < total && (
            <div className="text-center mt-6">
              <button onClick={() => fetchChannels(channels.length)} disabled={loading}
                className="px-6 py-2 bg-white/10 hover:bg-white/15 text-white rounded-xl text-sm transition">
                {loading ? 'Loading...' : `Load More (${channels.length}/${total})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
