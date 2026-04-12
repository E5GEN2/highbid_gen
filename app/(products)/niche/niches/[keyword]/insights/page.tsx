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

  // Channel scatter data (subs vs views)
  const [scatterChannels, setScatterChannels] = useState<Array<{
    name: string; subs: number; views: number; videos: number; avgScore: number; ageDays: number | null; channelId: string | null;
  }>>([]);

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
    // Fetch channels for scatter plot (subs vs views)
    fetch(`/api/niche-spy/channels?keyword=${encodeURIComponent(keyword)}&limit=2000&sort=views&minScore=${filter.minScore}`)
      .then(r => r.json()).then(d => {
        if (!d.channels) return;
        setScatterChannels(d.channels.filter((c: { subscribers: number; totalViews: number }) => c.subscribers > 0 || c.totalViews > 0).map((c: { channelName: string; subscribers: number; totalViews: number; videoCount: number; avgScore: number; channelAgeDays: number | null; channelId: string | null }) => ({
          name: c.channelName,
          subs: c.subscribers || 0,
          views: c.totalViews || 0,
          videos: c.videoCount || 0,
          avgScore: c.avgScore || 0,
          ageDays: c.channelAgeDays,
          channelId: c.channelId || null,
        })));
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

      {/* Distribution Charts — side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {subsDist.length > 0 && subsDist.some(b => b.count > 0) && (
          <DistChart title="Subscriber Distribution" unit="channels" buckets={subsDist} />
        )}
        {viewsDist.length > 0 && viewsDist.some(b => b.count > 0) && (
          <DistChart title="Views Distribution" unit="videos" buckets={viewsDist} />
        )}
      </div>

      {/* Channel Landscape: Subs vs Views scatter */}
      {scatterChannels.length > 0 && <ChannelScatter channels={scatterChannels} />}

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

      {/* Vertical bars — tight, pixel-based heights */}
      {(() => {
        const barMaxH = 80; // max bar height in px
        return (
          <div className="flex items-end gap-1">
            {buckets.map((b, i) => {
              const barH = maxCount > 0 ? Math.max((b.count / maxCount) * barMaxH, b.count > 0 ? 4 : 0) : 0;
              const sharePct = total > 0 ? Math.round((b.count / total) * 100) : 0;
              return (
                <div key={i} className="flex-1 flex flex-col items-center min-w-0">
                  {/* Count */}
                  <div className="text-[10px] font-bold text-white mb-0.5">
                    {b.count > 0 ? b.count.toLocaleString() : ''}
                  </div>
                  {/* Percentage */}
                  <div className="text-[9px] text-[#666] mb-1">
                    {b.count > 0 ? `${sharePct}%` : ''}
                  </div>
                  {/* Bar — fixed pixel height */}
                  <div className="w-full px-0.5" style={{ height: barMaxH }}>
                    <div className="w-full h-full flex items-end">
                      <div
                        className="w-full rounded-t-sm"
                        style={{ height: barH, backgroundColor: b.color, opacity: 0.85 }}
                      />
                    </div>
                  </div>
                  {/* Label */}
                  <div className="text-[9px] text-[#666] text-center mt-1 truncate w-full">{b.label}</div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

/** Channel Landscape scatter plot — Subs (X) vs Views (Y), log scale */
function ChannelScatter({ channels }: {
  channels: Array<{ name: string; subs: number; views: number; videos: number; avgScore: number; ageDays: number | null; channelId: string | null }>;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [colorBy, setColorBy] = useState<'age' | 'score'>('score');

  const logSafe = (n: number) => Math.log10(Math.max(n, 1));

  const subsVals = channels.filter(c => c.subs > 0).map(c => logSafe(c.subs));
  const viewsVals = channels.filter(c => c.views > 0).map(c => logSafe(c.views));
  const minLogSubs = subsVals.length > 0 ? Math.min(...subsVals) : 0;
  const maxLogSubs = subsVals.length > 0 ? Math.max(...subsVals) : 6;
  const minLogViews = viewsVals.length > 0 ? Math.min(...viewsVals) : 0;
  const maxLogViews = viewsVals.length > 0 ? Math.max(...viewsVals) : 7;
  const rangeX = maxLogSubs - minLogSubs || 1;
  const rangeY = maxLogViews - minLogViews || 1;

  const getColor = (c: typeof channels[0]) => {
    if (colorBy === 'age') {
      if (c.ageDays === null) return '#555';
      if (c.ageDays < 30) return '#f97316';
      if (c.ageDays < 180) return '#22c55e';
      return '#6b7280';
    }
    if (c.avgScore >= 80) return '#22c55e';
    if (c.avgScore >= 50) return '#eab308';
    return '#ef4444';
  };

  const xTicks = [1, 100, 1000, 10000, 100000, 1000000].filter(v => logSafe(v) >= minLogSubs - 0.3 && logSafe(v) <= maxLogSubs + 0.3);
  const yTicks = [100, 1000, 10000, 100000, 1000000, 10000000].filter(v => logSafe(v) >= minLogViews - 0.3 && logSafe(v) <= maxLogViews + 0.3);
  const fmtTick = (n: number) => n >= 1000000 ? `${n / 1000000}M` : n >= 1000 ? `${n / 1000}K` : String(n);

  const chartW = 100;
  const chartH = 100;

  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-white">Channel Landscape</h3>
          <p className="text-[10px] text-[#666]">{channels.length} channels — subscribers vs total views (log scale)</p>
        </div>
        <div className="flex gap-1">
          <button onClick={() => setColorBy('age')}
            className={`px-2.5 py-1 rounded-md text-[10px] transition ${colorBy === 'age' ? 'bg-white/15 text-white' : 'text-[#666] hover:text-[#888]'}`}>
            Color: Age
          </button>
          <button onClick={() => setColorBy('score')}
            className={`px-2.5 py-1 rounded-md text-[10px] transition ${colorBy === 'score' ? 'bg-white/15 text-white' : 'text-[#666] hover:text-[#888]'}`}>
            Color: Score
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 mb-3 text-[10px] text-[#888]">
        {colorBy === 'age' ? (
          <>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500" /> &lt;30 days</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" /> &lt;6 months</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-500" /> Established</span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" /> Score 80+</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500" /> Score 50-79</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> Score &lt;50</span>
          </>
        )}
      </div>

      {/* Chart */}
      <div className="relative" style={{ paddingLeft: 40, paddingBottom: 28 }}>
        {/* Y-axis labels */}
        <div className="absolute left-0 top-0 bottom-[28px] flex flex-col justify-between text-[10px] text-[#888] font-mono w-[36px] text-right pr-1 py-1">
          {[...yTicks].reverse().map(t => <span key={t}>{fmtTick(t)}</span>)}
        </div>
        {/* Y-axis title */}
        <div className="absolute left-[-2px] top-1/2 -translate-y-1/2 -rotate-90 text-[10px] text-[#666] font-medium whitespace-nowrap">Views</div>

        <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full bg-[#0a0a0a] rounded-lg" style={{ aspectRatio: '16 / 9' }}
          onMouseLeave={() => setHovered(null)}>
          {/* Grid */}
          {yTicks.map(t => {
            const y = chartH - ((logSafe(t) - minLogViews) / rangeY) * chartH;
            return <line key={`y${t}`} x1="0" y1={y} x2={chartW} y2={y} stroke="#1a1a1a" strokeWidth="0.15" />;
          })}
          {xTicks.map(t => {
            const x = ((logSafe(t) - minLogSubs) / rangeX) * chartW;
            return <line key={`x${t}`} x1={x} y1="0" x2={x} y2={chartH} stroke="#1a1a1a" strokeWidth="0.15" />;
          })}

          {/* Quadrant hint */}
          <text x="3" y="6" fill="#444" fontSize="3" fontWeight="600">High views, few subs</text>
          <text x={chartW - 3} y="6" fill="#444" fontSize="3" fontWeight="600" textAnchor="end">Big players</text>
          <text x="3" y={chartH - 2} fill="#333" fontSize="2.5">Newcomers</text>
          <text x={chartW - 3} y={chartH - 2} fill="#333" fontSize="2.5" textAnchor="end">High subs, low views</text>

          {/* Dots */}
          {channels.map((c, i) => {
            if (c.subs <= 0 && c.views <= 0) return null;
            const x = ((logSafe(c.subs) - minLogSubs) / rangeX) * chartW;
            const y = chartH - ((logSafe(c.views) - minLogViews) / rangeY) * chartH;
            const isH = hovered === i;
            return (
              <circle key={i} cx={x} cy={y} r={isH ? 2.5 : 1.3}
                fill={getColor(c)} opacity={isH ? 1 : 0.7}
                stroke={isH ? '#fff' : 'none'} strokeWidth={isH ? 0.3 : 0}
                className="cursor-pointer"
                onMouseEnter={() => setHovered(i)}
                onClick={() => {
                  if (c.channelId) window.open(`https://www.youtube.com/channel/${c.channelId}`, '_blank');
                  else window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(c.name)}`, '_blank');
                }} />
            );
          })}
        </svg>

        {/* X-axis labels */}
        <div className="flex justify-between mt-1.5 text-[10px] text-[#888] font-mono">
          {xTicks.map(t => <span key={t}>{fmtTick(t)}</span>)}
        </div>
        <div className="text-center text-[10px] text-[#666] font-medium mt-0.5">Subscribers →</div>
      </div>

      {/* Hover tooltip */}
      {hovered !== null && channels[hovered] && (() => {
        const ch = channels[hovered];
        const ytUrl = ch.channelId
          ? `https://www.youtube.com/channel/${ch.channelId}`
          : `https://www.youtube.com/results?search_query=${encodeURIComponent(ch.name)}`;
        return (
          <div className="mt-2 bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-3 py-2 flex items-center justify-between">
            <div>
              <span className="text-xs text-white font-medium">{ch.name}</span>
              <div className="flex gap-4 mt-1 text-[10px] text-[#888]">
                <span>{fmtYT(ch.subs)} subs</span>
                <span>{fmtYT(ch.views)} views</span>
                <span>{ch.videos} videos</span>
                <span>Score: {ch.avgScore}</span>
                {ch.ageDays !== null && <span>{ch.ageDays! < 365 ? `${ch.ageDays}d old` : `${(ch.ageDays! / 365).toFixed(1)}yr old`}</span>}
              </div>
            </div>
            <a href={ytUrl} target="_blank" rel="noopener noreferrer"
              className="text-[10px] bg-red-600/20 text-red-400 border border-red-600/30 px-2.5 py-1 rounded-lg hover:bg-red-600/30 transition flex-shrink-0 ml-3">
              Open Channel
            </a>
          </div>
        );
      })()}
    </div>
  );
}
