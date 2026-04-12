'use client';

import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useNiche } from '@/components/NicheProvider';
import NicheTimeline from '@/components/NicheTimeline';
import { fmtYT } from '@/lib/format';

export default function NicheInsights() {
  const { keyword: rawKeyword } = useParams<{ keyword: string }>();
  const keyword = decodeURIComponent(rawKeyword);
  const { setSelectedKeyword, filter, setFilter } = useNiche();

  const [saturation, setSaturation] = useState<{
    latest?: { runSaturation: number; globalSaturation: number; universeSize: number; knownBefore: number; lastNew: number; lastOverlap: number } | null;
  } | null>(null);

  const [channelStats, setChannelStats] = useState<{
    totalChannels: number; newChannels: number; veryNewChannels: number; establishedChannels: number;
    newAvgSubs: number; estAvgSubs: number;
  } | null>(null);

  // Distribution data (from fast SQL-bucketed API)
  const [subsDist, setSubsDist] = useState<Array<{ label: string; count: number; color: string }>>([]);
  const [viewsDist, setViewsDist] = useState<Array<{ label: string; count: number; color: string }>>([]);

  useEffect(() => { setSelectedKeyword(keyword); }, [keyword, setSelectedKeyword]);

  useEffect(() => {
    fetch(`/api/niche-spy/saturation?keyword=${encodeURIComponent(keyword)}`)
      .then(r => r.json()).then(d => setSaturation(d)).catch(() => {});
    fetch(`/api/niche-spy/channels?keyword=${encodeURIComponent(keyword)}&limit=0&sort=views&minScore=${filter.minScore}`)
      .then(r => r.json()).then(d => { if (d.stats) setChannelStats(d.stats); }).catch(() => {});
    // Single fast API call for both distributions (SQL-bucketed, no large data transfer)
    fetch(`/api/niche-spy/distribution?keyword=${encodeURIComponent(keyword)}&minScore=${filter.minScore}`)
      .then(r => r.json()).then(d => {
        if (d.subsDist) setSubsDist(d.subsDist);
        if (d.viewsDist) setViewsDist(d.viewsDist);
      }).catch(() => {});
  }, [keyword, filter.minScore]);

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto space-y-6">
      {/* Timeline */}
      <NicheTimeline
        keyword={keyword}
        minScore={filter.minScore}
        maxScore={filter.maxScore}
        onRangeChange={(from: string | null, to: string | null) => setFilter(prev => ({ ...prev, from, to }))}
      />

      {/* Saturation */}
      {saturation?.latest && (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-5 py-4">
          <h3 className="text-sm font-medium text-white mb-3">Saturation</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-[#888]">Run Saturation</span>
                <span className={`text-sm font-bold ${saturation.latest.runSaturation >= 90 ? 'text-red-400' : saturation.latest.runSaturation >= 60 ? 'text-yellow-400' : 'text-green-400'}`}>
                  {saturation.latest.runSaturation}%
                </span>
              </div>
              <div className="h-2.5 bg-[#1f1f1f] rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${saturation.latest.runSaturation >= 90 ? 'bg-red-500' : saturation.latest.runSaturation >= 60 ? 'bg-yellow-500' : 'bg-green-500'}`} style={{ width: `${saturation.latest.runSaturation}%` }} />
              </div>
              <p className="text-[10px] text-[#666] mt-1">How redundant was the last scrape</p>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-[#888]">Global Coverage</span>
                <span className={`text-sm font-bold ${saturation.latest.globalSaturation >= 95 ? 'text-red-400' : saturation.latest.globalSaturation >= 80 ? 'text-yellow-400' : 'text-green-400'}`}>
                  {saturation.latest.globalSaturation}%
                </span>
              </div>
              <div className="h-2.5 bg-[#1f1f1f] rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${saturation.latest.globalSaturation >= 95 ? 'bg-red-500' : saturation.latest.globalSaturation >= 80 ? 'bg-yellow-500' : 'bg-green-500'}`} style={{ width: `${saturation.latest.globalSaturation}%` }} />
              </div>
              <p className="text-[10px] text-[#666] mt-1">How much of this niche is mapped</p>
            </div>
          </div>
          <div className="flex items-center gap-4 mt-3 text-xs text-[#666]">
            <span>Est. universe: {saturation.latest.universeSize}</span>
            <span>Known: {saturation.latest.knownBefore}</span>
            <span>Last new: +{saturation.latest.lastNew}</span>
            <span>Last overlap: {saturation.latest.lastOverlap}</span>
          </div>
        </div>
      )}

      {/* Subscriber Distribution */}
      {subsDist.length > 0 && subsDist.some(b => b.count > 0) && (
        <DistChart title="Subscriber Distribution" unit="channels" buckets={subsDist} />
      )}

      {/* Views Distribution */}
      {viewsDist.length > 0 && viewsDist.some(b => b.count > 0) && (
        <DistChart title="Views Distribution" unit="videos" buckets={viewsDist} />
      )}

      {/* New vs Established Channels */}
      {channelStats && (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-5 py-4">
          <h3 className="text-sm font-medium text-white mb-3">New vs Established Channels</h3>
          <div className="grid grid-cols-4 gap-3 mb-4">
            <div className="bg-[#0a0a0a] rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-white">{channelStats.totalChannels}</div>
              <div className="text-xs text-[#666]">Total</div>
            </div>
            <div className="bg-orange-900/20 border border-orange-800/30 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-orange-400">{channelStats.veryNewChannels}</div>
              <div className="text-xs text-[#666]">&lt;30 days</div>
            </div>
            <div className="bg-green-900/20 border border-green-800/30 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-green-400">{channelStats.newChannels}</div>
              <div className="text-xs text-[#666]">&lt;6 months</div>
            </div>
            <div className="bg-[#0a0a0a] rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-[#888]">{channelStats.establishedChannels}</div>
              <div className="text-xs text-[#666]">Established</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[#0a0a0a] rounded-lg p-3">
              <div className="text-xs text-[#666] mb-1">New Channel Avg Subs</div>
              <div className="text-lg font-bold text-green-400">{fmtYT(channelStats.newAvgSubs)}</div>
            </div>
            <div className="bg-[#0a0a0a] rounded-lg p-3">
              <div className="text-xs text-[#666] mb-1">Established Avg Subs</div>
              <div className="text-lg font-bold text-[#888]">{fmtYT(channelStats.estAvgSubs)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Clean bar chart with readable numbers */
function DistChart({ title, unit, buckets }: {
  title: string;
  unit: string;
  buckets: Array<{ label: string; count: number; color: string }>;
}) {
  const maxCount = Math.max(...buckets.map(b => b.count));
  const total = buckets.reduce((s, b) => s + b.count, 0);

  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-5 py-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-white">{title}</h3>
          <p className="text-[10px] text-[#666]">{total.toLocaleString()} {unit}</p>
        </div>
      </div>

      {/* Vertical bars */}
      <div className="flex items-end gap-2" style={{ height: 140 }}>
        {buckets.map((b, i) => {
          const pct = maxCount > 0 ? (b.count / maxCount) * 100 : 0;
          const sharePct = total > 0 ? Math.round((b.count / total) * 100) : 0;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
              {/* Count above bar */}
              <div className="text-xs font-bold text-white opacity-0 group-hover:opacity-100 transition">
                {b.count > 0 ? b.count.toLocaleString() : ''}
              </div>
              {/* Percentage always visible */}
              <div className="text-[10px] text-[#888] font-medium">
                {b.count > 0 ? `${sharePct}%` : ''}
              </div>
              {/* Bar */}
              <div className="w-full flex justify-center" style={{ height: 90 }}>
                <div className="relative w-full max-w-[48px] flex items-end h-full">
                  <div
                    className="w-full rounded-t-md transition-all duration-300 hover:opacity-100 opacity-85"
                    style={{
                      height: `${Math.max(pct, b.count > 0 ? 3 : 0)}%`,
                      backgroundColor: b.color,
                    }}
                  />
                </div>
              </div>
              {/* Label below */}
              <div className="text-[10px] text-[#888] text-center whitespace-nowrap mt-1">{b.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
