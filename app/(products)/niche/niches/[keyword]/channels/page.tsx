'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useNiche } from '@/components/NicheProvider';
import { ChannelAgeChip } from '@/components/ChannelAgeChip';
import { fmtYT } from '@/lib/format';

interface NicheChannel {
  channelName: string; videoCount: number; totalViews: number; avgViews: number; maxViews: number;
  avgScore: number; maxScore: number; subscribers: number; totalLikes: number; totalComments: number;
  channelCreatedAt: string | null; channelAgeDays: number | null;
  latestVideoAt: string | null; earliestVideoAt: string | null;
  channelAvatar: string | null; channelId: string | null; channelHandle: string | null;
  firstUploadAt: string | null; dormancyDays: number | null;
  keywords: string[];
}

/** Build a YouTube channel URL: prefer @handle, fall back to /channel/{id}. */
function youtubeChannelUrl(ch: { channelHandle: string | null; channelId: string | null }): string | null {
  if (ch.channelHandle) {
    const h = ch.channelHandle.startsWith('@') ? ch.channelHandle : `@${ch.channelHandle}`;
    return `https://www.youtube.com/${h}`;
  }
  if (ch.channelId) return `https://www.youtube.com/channel/${ch.channelId}`;
  return null;
}

export default function NicheChannels() {
  const { keyword: rawKeyword } = useParams<{ keyword: string }>();
  const keyword = decodeURIComponent(rawKeyword);
  const { setSelectedKeyword, filter } = useNiche();

  const [channels, setChannels] = useState<NicheChannel[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<{
    totalChannels: number; newChannels: number; veryNewChannels: number; establishedChannels: number;
    newAvgSubs: number; estAvgSubs: number;
  } | null>(null);
  const [sort, setSort] = useState('views');
  const [maxAge, setMaxAge] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { setSelectedKeyword(keyword); }, [keyword, setSelectedKeyword]);

  const fetchChannels = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        keyword, sort, limit: '60', offset: String(offset),
        minScore: String(filter.minScore),
      });
      if (maxAge) params.set('maxAge', maxAge);
      const res = await fetch(`/api/niche-spy/channels?${params}`);
      const data = await res.json();
      if (offset === 0) setChannels(data.channels);
      else setChannels(prev => [...prev, ...data.channels]);
      setTotal(data.total);
      setStats(data.stats);
    } catch (err) { console.error('Channel fetch error:', err); }
    setLoading(false);
  }, [keyword, sort, maxAge, filter.minScore]);

  useEffect(() => { fetchChannels(0); }, [fetchChannels]);

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Filters */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Sort pills */}
          <div className="flex gap-2 flex-wrap flex-1">
            {[
              { value: 'views', label: 'Total Views' },
              { value: 'videos', label: 'Video Count' },
              { value: 'subs', label: 'Subscribers' },
              { value: 'newest', label: 'Newest' },
              { value: 'score', label: 'Avg Score' },
            ].map(opt => (
              <button key={opt.value} onClick={() => setSort(opt.value)}
                className={`px-4 py-1.5 rounded-full text-sm transition ${
                  sort === opt.value ? 'bg-white text-black font-medium' : 'text-[#888] border border-[#333] hover:border-[#555]'
                }`}>
                {opt.label}
              </button>
            ))}
          </div>
          {/* Age filter */}
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
          <span className="text-sm font-medium text-white">{total} channels</span>
        </div>
      </div>

      {/* Channel stats summary */}
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

      {/* Channel grid */}
      {loading && channels.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 animate-pulse">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-[#1f1f1f]" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-32 bg-[#1f1f1f] rounded" />
                  <div className="h-3 w-20 bg-[#1f1f1f] rounded" />
                </div>
                <div className="h-5 w-10 bg-[#1f1f1f] rounded-full" />
              </div>
              <div className="grid grid-cols-3 gap-0 bg-[#0a0a0a] rounded-lg overflow-hidden mb-3">
                {[1,2,3].map(j => <div key={j} className="p-2.5 text-center border-r border-[#1f1f1f] last:border-0"><div className="h-4 w-12 bg-[#1f1f1f] rounded mx-auto mb-1" /><div className="h-2.5 w-16 bg-[#1a1a1a] rounded mx-auto" /></div>)}
              </div>
              <div className="flex gap-3">
                <div className="h-3 w-20 bg-[#1f1f1f] rounded" />
                <div className="h-3 w-16 bg-[#1f1f1f] rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {channels.map(ch => {
              const ytUrl = youtubeChannelUrl(ch);
              return (
              <div key={ch.channelName} className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 hover:border-[#333] transition">
                {/* Header — avatar + name are a link to the channel on YouTube.
                    Uses @handle when we have it, otherwise falls back to /channel/{id}. */}
                <div className="flex items-start gap-3 mb-3">
                  <a
                    href={ytUrl || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`w-10 h-10 rounded-full bg-[#1f1f1f] flex-shrink-0 overflow-hidden ${ytUrl ? 'hover:ring-2 hover:ring-red-500/50 transition' : 'pointer-events-none'}`}
                    aria-label={ytUrl ? `Open ${ch.channelName} on YouTube` : undefined}
                  >
                    {ch.channelAvatar ? (
                      <img src={ch.channelAvatar} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#666] text-sm font-bold">
                        {ch.channelName.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </a>
                  <div className="min-w-0 flex-1">
                    {ytUrl ? (
                      <a
                        href={ytUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group inline-flex items-center gap-1 text-sm font-semibold text-white hover:text-red-400 transition truncate max-w-full"
                      >
                        <span className="truncate">{ch.channelName}</span>
                        <svg className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    ) : (
                      <h3 className="text-sm font-semibold text-white truncate">{ch.channelName}</h3>
                    )}
                    {ch.subscribers > 0 && <span className="text-xs text-[#888] block">{fmtYT(ch.subscribers)} subscribers</span>}
                    {ch.channelHandle && <span className="text-[10px] text-[#555] block">{ch.channelHandle.startsWith('@') ? ch.channelHandle : `@${ch.channelHandle}`}</span>}
                  </div>
                  <span className="flex-shrink-0 text-xs">
                    <ChannelAgeChip
                      createdAt={ch.channelCreatedAt}
                      firstUploadAt={ch.firstUploadAt}
                      earliestVideoAt={ch.earliestVideoAt}
                      dormancyDays={ch.dormancyDays}
                    />
                  </span>
                </div>

                {/* Stats grid — Nexlev style with dividers */}
                <div className="grid grid-cols-3 gap-0 mb-3 bg-[#0a0a0a] rounded-lg overflow-hidden">
                  <div className="p-2.5 text-center border-r border-[#1f1f1f]">
                    <div className="text-sm font-bold text-green-400">{fmtYT(ch.totalViews)}</div>
                    <div className="text-[10px] text-[#666]">Total Views</div>
                  </div>
                  <div className="p-2.5 text-center border-r border-[#1f1f1f]">
                    <div className="text-sm font-bold text-blue-400">{ch.videoCount}</div>
                    <div className="text-[10px] text-[#666]">Videos</div>
                  </div>
                  <div className="p-2.5 text-center">
                    <div className="text-sm font-bold text-purple-400">{fmtYT(ch.avgViews)}</div>
                    <div className="text-[10px] text-[#666]">Avg Views</div>
                  </div>
                </div>

                {/* Score + engagement */}
                <div className="flex items-center gap-3 text-xs text-[#666] mb-2">
                  <span className={`font-medium ${ch.avgScore >= 80 ? 'text-green-400' : ch.avgScore >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                    ⚡ {ch.avgScore} avg score
                  </span>
                  {ch.totalLikes > 0 && <span>👍 {fmtYT(ch.totalLikes)}</span>}
                  {ch.totalComments > 0 && <span>💬 {fmtYT(ch.totalComments)}</span>}
                </div>

                <div className="text-[10px] text-[#666]">Best: {fmtYT(ch.maxViews)} views · Max score: {ch.maxScore}</div>

                {ch.keywords.length > 1 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {ch.keywords.slice(0, 3).map(kw => (
                      <span key={kw} className="text-[9px] bg-purple-600/20 text-purple-300 px-1.5 py-0.5 rounded-full">{kw}</span>
                    ))}
                    {ch.keywords.length > 3 && <span className="text-[9px] text-[#444]">+{ch.keywords.length - 3}</span>}
                  </div>
                )}
              </div>
              );
            })}
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
