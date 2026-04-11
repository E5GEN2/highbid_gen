'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useNiche } from '@/components/NicheProvider';
import { fmtYT } from '@/lib/format';

export default function NichesGrid() {
  const router = useRouter();
  const { setSelectedKeyword } = useNiche();

  const [keywordCards, setKeywordCards] = useState<Array<{
    keyword: string; videoCount: number; channelCount: number; avgScore: number;
    totalViews: number; avgViews: number; highScoreCount: number;
    newChannelCount: number; newestVideo: string | null;
    saturation: { globalSaturation: number; runSaturation: number } | null;
  }>>([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('videos');
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ message: string; done?: boolean } | null>(null);

  const fetchKeywords = useCallback(async () => {
    try {
      const params = new URLSearchParams({ sort, limit: '200' });
      if (search) params.set('search', search);
      const res = await fetch(`/api/niche-spy/keywords?${params}`);
      const data = await res.json();
      setKeywordCards(data.keywords);
    } catch (err) { console.error('Keyword fetch error:', err); }
  }, [search, sort]);

  useEffect(() => { fetchKeywords(); }, [fetchKeywords]);

  const syncNicheData = async () => {
    setSyncing(true);
    setSyncProgress({ message: 'Fetching tasks from xgodo...' });
    let totalInserted = 0, totalUpdated = 0, batches = 0;
    try {
      while (true) {
        const res = await fetch('/api/niche-spy/sync', { method: 'POST' });
        const data = await res.json();
        if (data.error) { setSyncProgress({ message: `Error: ${data.error}` }); break; }
        batches++;
        totalInserted += data.videosInserted || 0;
        totalUpdated += data.videosUpdated || 0;
        if (data.status === 'idle' || data.tasksProcessed === 0) {
          setSyncProgress({
            message: totalInserted > 0 ? `Done! ${totalInserted} new, ${totalUpdated} updated across ${batches} batches.` : 'All caught up — no new tasks.',
            done: true,
          });
          break;
        }
        setSyncProgress({ message: `Batch ${batches}: ${data.tasksProcessed} tasks → ${data.videosInserted} new, ${data.videosUpdated} updated` });
        if (data.tasksProcessed < 100) break;
        await new Promise(r => setTimeout(r, 500));
      }
      fetchKeywords();
    } catch (err) {
      console.error('Niche sync error:', err);
      setSyncProgress({ message: `Error: ${err instanceof Error ? err.message : 'Sync failed'}` });
    }
    setTimeout(() => { setSyncing(false); setSyncProgress(null); }, 5000);
  };

  const selectKeyword = (kw: string) => {
    setSelectedKeyword(kw);
    router.push(`/niche/niches/${encodeURIComponent(kw)}/videos`);
  };

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Niches</h1>
        <p className="text-sm text-[#888]">Select a niche to explore videos, channels, and insights</p>
      </div>

      {/* Search bar — Nexlev style */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3 flex items-center gap-3 mb-6">
        <svg className="w-5 h-5 text-[#666] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search niches..."
          className="flex-1 bg-transparent text-white text-sm placeholder-[#555] focus:outline-none"
        />
      </div>

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
        <button onClick={syncNicheData} disabled={syncing}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-[#333] text-white rounded-xl text-sm font-medium transition">
          {syncing ? 'Syncing...' : 'Sync'}
        </button>
      </div>

      {/* Sync progress */}
      {syncProgress && (
        <div className={`border rounded-xl px-4 py-3 mb-6 ${syncProgress.done ? 'bg-green-900/20 border-green-600/40' : 'bg-blue-900/20 border-blue-600/40'}`}>
          <p className="text-sm text-blue-200">{syncProgress.message}</p>
        </div>
      )}

      {/* Results count */}
      {keywordCards.length > 0 && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm font-medium text-white">{keywordCards.length} niches</span>
        </div>
      )}

      {/* Keyword cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
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
          </button>
        ))}
      </div>
    </div>
  );
}
