'use client';

import React, { useState, useEffect, useCallback } from 'react';
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

  // Distribution buckets
  const [subsDist, setSubsDist] = useState<Array<{ label: string; count: number; color: string }>>([]);
  const [viewsDist, setViewsDist] = useState<Array<{ label: string; count: number; color: string }>>([]);

  useEffect(() => { setSelectedKeyword(keyword); }, [keyword, setSelectedKeyword]);

  // Fetch saturation + channel stats + subscriber distribution
  useEffect(() => {
    fetch(`/api/niche-spy/saturation?keyword=${encodeURIComponent(keyword)}`)
      .then(r => r.json()).then(d => setSaturation(d)).catch(() => {});
    fetch(`/api/niche-spy/channels?keyword=${encodeURIComponent(keyword)}&limit=0&sort=views&minScore=${filter.minScore}`)
      .then(r => r.json()).then(d => { if (d.stats) setChannelStats(d.stats); }).catch(() => {});
    // Fetch all channels to build subscriber distribution
    fetch(`/api/niche-spy/channels?keyword=${encodeURIComponent(keyword)}&limit=5000&sort=subs&minScore=${filter.minScore}`)
      .then(r => r.json()).then(d => {
        if (!d.channels) return;
        const buckets = [
          { label: '0', min: 0, max: 1, count: 0, color: '#444' },
          { label: '1-1K', min: 1, max: 1000, count: 0, color: '#666' },
          { label: '1K-10K', min: 1000, max: 10000, count: 0, color: '#3b82f6' },
          { label: '10K-100K', min: 10000, max: 100000, count: 0, color: '#8b5cf6' },
          { label: '100K-1M', min: 100000, max: 1000000, count: 0, color: '#f59e0b' },
          { label: '1M+', min: 1000000, max: Infinity, count: 0, color: '#ef4444' },
        ];
        for (const ch of d.channels) {
          const subs = ch.subscribers || 0;
          for (const b of buckets) {
            if (subs >= b.min && subs < b.max) { b.count++; break; }
          }
        }
        setSubsDist(buckets.map(b => ({ label: b.label, count: b.count, color: b.color })));
      }).catch(() => {});
    // Fetch videos for views distribution
    fetch(`/api/niche-spy?keyword=${encodeURIComponent(keyword)}&minScore=${filter.minScore}&maxScore=${filter.maxScore}&sort=views&limit=10000&offset=0`)
      .then(r => r.json()).then(d => {
        if (!d.videos) return;
        const buckets = [
          { label: '0-100', min: 0, max: 100, count: 0, color: '#444' },
          { label: '100-1K', min: 100, max: 1000, count: 0, color: '#666' },
          { label: '1K-10K', min: 1000, max: 10000, count: 0, color: '#3b82f6' },
          { label: '10K-100K', min: 10000, max: 100000, count: 0, color: '#8b5cf6' },
          { label: '100K-1M', min: 100000, max: 1000000, count: 0, color: '#f59e0b' },
          { label: '1M-10M', min: 1000000, max: 10000000, count: 0, color: '#ef4444' },
          { label: '10M+', min: 10000000, max: Infinity, count: 0, color: '#ec4899' },
        ];
        for (const v of d.videos) {
          const views = v.view_count || 0;
          for (const b of buckets) {
            if (views >= b.min && views < b.max) { b.count++; break; }
          }
        }
        setViewsDist(buckets.map(b => ({ label: b.label, count: b.count, color: b.color })));
      }).catch(() => {});
  }, [keyword, filter.minScore, filter.maxScore]);

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

      {/* Subscriber Distribution Chart */}
      {subsDist.length > 0 && subsDist.some(b => b.count > 0) && (
        <DistChart title="Subscriber Distribution" subtitle="channels" buckets={subsDist} accentColor="#8b5cf6" />
      )}

      {/* Views Distribution Chart */}
      {viewsDist.length > 0 && viewsDist.some(b => b.count > 0) && (
        <DistChart title="Views Distribution" subtitle="videos" buckets={viewsDist} accentColor="#3b82f6" />
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

/** Reusable distribution chart with 3 view modes */
function DistChart({ title, subtitle, buckets, accentColor }: {
  title: string;
  subtitle: string;
  buckets: Array<{ label: string; count: number; color: string }>;
  accentColor: string;
}) {
  const [mode, setMode] = useState<'area' | 'line' | 'bars'>('area');
  const maxCount = Math.max(...buckets.map(b => b.count));
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const chartH = 160;
  const chartW = 100; // percentage-based

  // SVG points for curve modes
  const points = buckets.map((b, i) => {
    const x = (i / (buckets.length - 1)) * 100;
    const y = maxCount > 0 ? (1 - b.count / maxCount) * chartH : chartH;
    return { x, y, bucket: b };
  });

  // Smooth curve path using catmull-rom approximation
  const curvePath = (() => {
    if (points.length < 2) return '';
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  })();

  const areaPath = curvePath + ` L ${points[points.length - 1].x} ${chartH} L ${points[0].x} ${chartH} Z`;

  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-white">{title}</h3>
          <p className="text-[10px] text-[#666]">{total} {subtitle}</p>
        </div>
        <div className="flex gap-1">
          {([
            { v: 'area' as const, icon: '◣' },
            { v: 'line' as const, icon: '⌇' },
            { v: 'bars' as const, icon: '▥' },
          ]).map(m => (
            <button key={m.v} onClick={() => setMode(m.v)}
              className={`w-7 h-7 rounded-md text-xs flex items-center justify-center transition ${
                mode === m.v ? 'bg-white/15 text-white' : 'text-[#666] hover:text-[#888]'
              }`}
              title={m.v}
            >{m.icon}</button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="relative" style={{ height: chartH + 30 }}>
        <svg viewBox={`0 0 100 ${chartH}`} preserveAspectRatio="none" className="w-full" style={{ height: chartH }}>
          {/* Grid lines */}
          {[0.25, 0.5, 0.75].map(p => (
            <line key={p} x1="0" y1={chartH * p} x2="100" y2={chartH * p} stroke="#1f1f1f" strokeWidth="0.3" />
          ))}

          {mode === 'area' && (
            <>
              <defs>
                <linearGradient id={`grad-${title.replace(/\s/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={accentColor} stopOpacity="0.4" />
                  <stop offset="100%" stopColor={accentColor} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path d={areaPath} fill={`url(#grad-${title.replace(/\s/g, '')})`} />
              <path d={curvePath} fill="none" stroke={accentColor} strokeWidth="0.8" />
            </>
          )}

          {mode === 'line' && (
            <>
              <path d={curvePath} fill="none" stroke={accentColor} strokeWidth="0.8" />
              {points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r="1.5" fill={accentColor} />
              ))}
            </>
          )}

          {mode === 'bars' && (
            <>
              {points.map((p, i) => {
                const barW = 100 / buckets.length * 0.7;
                const barX = (i / buckets.length) * 100 + (100 / buckets.length * 0.15);
                const barH = maxCount > 0 ? (p.bucket.count / maxCount) * chartH : 0;
                return (
                  <rect key={i} x={barX} y={chartH - barH} width={barW} height={barH}
                    fill={p.bucket.color} rx="1" opacity="0.85" />
                );
              })}
            </>
          )}

          {/* Dots with count labels for area/line */}
          {(mode === 'area' || mode === 'line') && points.map((p, i) => (
            p.bucket.count > 0 && (
              <text key={`t${i}`} x={p.x} y={Math.max(p.y - 4, 10)} textAnchor="middle"
                fill="white" fontSize="4" fontWeight="bold">{p.bucket.count}</text>
            )
          ))}
        </svg>

        {/* X-axis labels */}
        <div className="flex justify-between mt-1 px-0">
          {buckets.map((b, i) => (
            <div key={i} className="text-[9px] text-[#666] text-center" style={{ width: `${100 / buckets.length}%` }}>
              {b.label}
            </div>
          ))}
        </div>
      </div>

      {/* Count badges below for bars mode */}
      {mode === 'bars' && (
        <div className="flex justify-between mt-1">
          {buckets.map((b, i) => (
            <div key={i} className="text-[9px] text-[#888] text-center font-mono" style={{ width: `${100 / buckets.length}%` }}>
              {b.count > 0 ? b.count : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
