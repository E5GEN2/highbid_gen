'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { fmtYT } from '@/lib/format';
import { useSimilarModal } from './SimilarModal';
import { ChannelAgeChip } from './ChannelAgeChip';

/**
 * Channel Landscape scatter plot — Subs (X) vs Views (Y), log scale.
 * Used by the keyword Insights page and the Similar-videos Insights page.
 *
 * Props:
 *   dots       — lightweight dots to plot
 *   videoLookup (optional) — synchronous map from dot id → full video detail,
 *                used when the caller already has the full data (similar page).
 *                When not provided, we fall back to fetching per-hover via
 *                /api/niche-spy/distribution/video (keyword insights page).
 */

export interface ScatterDot {
  id: number;
  ch: string;
  s: number;        // subscribers
  v: number;        // views
  sc: number;       // score
  a: number | null; // channel age (days)
  va: number | null;// video upload age (days)
  e: boolean;       // has embedding
}

export interface ScatterVideo {
  id: number;
  name: string;
  subs: number;
  views: number;
  avgScore: number;
  /** Active age (days since first_upload), fallback to creation age when not yet detected. */
  ageDays: number | null;
  /** Raw channel creation age (days) — passed through for the age-chip tooltip. */
  creationAgeDays?: number | null;
  firstUploadAt?: string | null;
  dormancyDays?: number | null;
  channelId: string | null;
  videoUrl: string | null;
  videoTitle: string | null;
  thumbnail: string | null;
  likeCount: number;
  commentCount: number;
  postedAt: string | null;
  postedDate: string | null;
  keyword: string | null;
  embeddedAt: string | null;
  topComment: string | null;
}

interface Props {
  dots: ScatterDot[];
  videoLookup?: (id: number) => ScatterVideo | null;
}

const logSafe = (n: number) => Math.log10(Math.max(n, 1));

export function ChannelScatter({ dots, videoLookup }: Props) {
  const { openSimilar } = useSimilarModal();
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [onePerChannel, setOnePerChannel] = useState(false);
  const [refreshingIds, setRefreshingIds] = useState<Set<number>>(new Set());

  const [minViews, setMinViews] = useState('');
  const [maxViews, setMaxViews] = useState('');
  const [minSubs, setMinSubs] = useState('');
  const [maxSubs, setMaxSubs] = useState('');
  const [minChAge, setMinChAge] = useState('');
  const [maxChAge, setMaxChAge] = useState('');
  const [minVidAge, setMinVidAge] = useState('');
  const [maxVidAge, setMaxVidAge] = useState('');

  const parseNum = (s: string): number | null => {
    if (!s) return null;
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  };

  // Video detail — either provided synchronously by caller, or fetched on demand.
  const [videoCache, setVideoCache] = useState<Record<number, ScatterVideo>>({});
  const [activeVideo, setActiveVideo] = useState<ScatterVideo | null>(null);
  const fetchingRef = useRef<Set<number>>(new Set());

  const fetchVideoDetail = useCallback((id: number) => {
    // Synchronous lookup path — used by the Similar page which already has all the data
    if (videoLookup) {
      const found = videoLookup(id);
      setActiveVideo(found);
      return;
    }
    // Async fetch path — used by keyword Insights
    if (videoCache[id]) { setActiveVideo(videoCache[id]); return; }
    if (fetchingRef.current.has(id)) return;
    fetchingRef.current.add(id);
    fetch(`/api/niche-spy/distribution/video?id=${id}`)
      .then(r => r.json())
      .then(d => {
        if (d.id) {
          setVideoCache(prev => ({ ...prev, [id]: d }));
          setActiveVideo(d);
        }
        fetchingRef.current.delete(id);
      })
      .catch(() => fetchingRef.current.delete(id));
  }, [videoCache, videoLookup]);

  // Re-fetch a video's YouTube data via our proxied enrichment pipeline, then
  // pull the matching detail shape and swap it into the scatter's card cache
  // so the card updates in place without reloading the whole scatter.
  const refreshVideo = useCallback(async (id: number) => {
    setRefreshingIds(prev => new Set(prev).add(id));
    try {
      const res = await fetch('/api/niche-spy/enrich-one', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: id }),
      });
      const data = await res.json();
      if (data.ok) {
        // Fetch the detail shape our card renders (same endpoint fetchVideoDetail uses)
        const detail = await fetch(`/api/niche-spy/distribution/video?id=${id}`).then(r => r.json()).catch(() => null);
        if (detail?.id) {
          setVideoCache(prev => ({ ...prev, [id]: detail }));
          setActiveVideo(detail);
        }
      }
    } catch (err) {
      console.error('Scatter refresh error:', err);
    } finally {
      setRefreshingIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, []);

  const filteredDots = useMemo(() => {
    const minV = parseNum(minViews), maxV = parseNum(maxViews);
    const minS = parseNum(minSubs), maxS = parseNum(maxSubs);
    const minA = parseNum(minChAge), maxA = parseNum(maxChAge);
    const minVA = parseNum(minVidAge), maxVA = parseNum(maxVidAge);

    const ranged = dots.filter(d => {
      if (minV !== null && d.v < minV) return false;
      if (maxV !== null && d.v > maxV) return false;
      if (minS !== null && d.s < minS) return false;
      if (maxS !== null && d.s > maxS) return false;
      if (minA !== null && (d.a === null || d.a < minA)) return false;
      if (maxA !== null && (d.a === null || d.a > maxA)) return false;
      if (minVA !== null && (d.va === null || d.va < minVA)) return false;
      if (maxVA !== null && (d.va === null || d.va > maxVA)) return false;
      return true;
    });

    if (!onePerChannel) return ranged;
    const best = new Map<string, number>();
    ranged.forEach((d, i) => {
      const prev = best.get(d.ch);
      if (prev === undefined || d.v > ranged[prev].v) best.set(d.ch, i);
    });
    return [...best.values()].sort((a, b) => a - b).map(i => ranged[i]);
  }, [dots, onePerChannel, minViews, maxViews, minSubs, maxSubs, minChAge, maxChAge, minVidAge, maxVidAge]);

  useEffect(() => {
    const idx = hovered ?? selected;
    if (idx !== null && filteredDots[idx]) {
      fetchVideoDetail(filteredDots[idx].id);
    } else {
      setActiveVideo(null);
    }
  }, [hovered, selected, filteredDots, fetchVideoDetail]);

  const [colorBy, setColorBy] = useState<'age' | 'score'>('score');
  const svgRef = useRef<SVGSVGElement>(null);

  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const allLogSubs = dots.map(d => logSafe(d.s));
  const allLogViews = dots.map(d => logSafe(d.v));
  // Snap axis endpoints to whole decades so major tick labels (1, 10, 100,
  // 1K, 10K, ...) always appear at the expected positions. Without this, an
  // axis running from e.g. log(300)=2.48 to log(500K)=5.70 hides the 1M
  // tick and crams the 100K label next to a 500K dot at the right edge.
  const rawMinSubs = allLogSubs.length > 0 ? Math.min(...allLogSubs) : 0;
  const rawMaxSubs = allLogSubs.length > 0 ? Math.max(...allLogSubs) : 6;
  const rawMinViews = allLogViews.length > 0 ? Math.min(...allLogViews) : 0;
  const rawMaxViews = allLogViews.length > 0 ? Math.max(...allLogViews) : 7;
  const minLogSubs  = Math.floor(rawMinSubs);
  const maxLogSubs  = Math.ceil(rawMaxSubs);
  const minLogViews = Math.floor(rawMinViews);
  const maxLogViews = Math.ceil(rawMaxViews);
  const rangeX = maxLogSubs - minLogSubs || 1;
  const rangeY = maxLogViews - minLogViews || 1;

  // Real data medians — the quadrant dashed lines are drawn at these so the
  // visual "top-left / bottom-right" regions actually match the statistical
  // split the Top-Left Density indicator uses.
  const median = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
  };
  const medSubs = median(dots.map(d => d.s).filter(v => v > 0));
  const medViews = median(dots.map(d => d.v).filter(v => v > 0));
  const medianXpct = medSubs > 0 ? ((logSafe(medSubs) - minLogSubs) / rangeX) * 100 : 50;
  const medianYpct = medViews > 0 ? 100 - ((logSafe(medViews) - minLogViews) / rangeY) * 100 : 50;

  const vbW = 100 / zoom;
  const vbH = 100 / zoom;
  const vbX = pan.x;
  const vbY = pan.y;
  const viewBox = `${vbX} ${vbY} ${vbW} ${vbH}`;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = ((e.clientX - dragStart.current.x) / rect.width) * vbW;
    const dy = ((e.clientY - dragStart.current.y) / rect.height) * vbH;
    setPan({ x: dragStart.current.panX - dx, y: dragStart.current.panY - dy });
  }, [dragging, vbW, vbH]);

  const handleMouseUp = useCallback(() => { setDragging(false); }, []);
  const resetView = () => { setPan({ x: 0, y: 0 }); setZoom(1); };

  const getColor = (d: ScatterDot) => {
    if (colorBy === 'age') {
      if (d.a === null) return '#555';
      if (d.a < 30) return '#f97316';
      if (d.a < 180) return '#22c55e';
      return '#6b7280';
    }
    if (d.sc >= 80) return '#22c55e';
    if (d.sc >= 50) return '#eab308';
    return '#ef4444';
  };

  // Axis ticks = every decade whose log lies inside [minLog, maxLog] now that
  // those bounds are snapped to whole decades. No fudge factor needed.
  const decadeSeq = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000];
  const xTicks = decadeSeq.filter(v => logSafe(v) >= minLogSubs && logSafe(v) <= maxLogSubs);
  const yTicks = decadeSeq.filter(v => logSafe(v) >= minLogViews && logSafe(v) <= maxLogViews);
  const fmtTick = (n: number) => n >= 1000000 ? `${n / 1000000}M` : n >= 1000 ? `${n / 1000}K` : String(n);

  const chartW = 100;
  const chartH = 100;

  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-white">Channel Landscape</h3>
          <p className="text-[10px] text-[#666]">{filteredDots.length} videos — channel subs vs video views (log scale)</p>
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
          <div className="flex items-center gap-0.5 ml-2">
            <button onClick={() => { setZoom(z => Math.min(z * 1.4, 20)); }}
              className="w-6 h-6 rounded-md text-sm bg-white/10 text-white hover:bg-white/15 transition flex items-center justify-center">+</button>
            <button onClick={() => {
              const newZ = Math.max(zoom / 1.4, 1);
              setZoom(newZ);
              if (newZ <= 1) setPan({ x: 0, y: 0 });
            }}
              className="w-6 h-6 rounded-md text-sm bg-white/10 text-white hover:bg-white/15 transition flex items-center justify-center">−</button>
            {(zoom > 1 || pan.x !== 0 || pan.y !== 0) && (
              <button onClick={resetView}
                className="px-2 py-0.5 rounded-md text-[10px] bg-white/10 text-white hover:bg-white/15 transition ml-0.5">
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

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

      <div className="flex gap-4">
        <div className="flex-1 min-w-0 relative" style={{ paddingLeft: 40, paddingBottom: 28 }}>
          <div className="absolute left-0 top-0 bottom-[28px] w-[36px]">
            {yTicks.map(t => {
              const pct = ((logSafe(t) - minLogViews) / rangeY) * 100;
              return <span key={t} className="absolute text-[10px] text-[#888] font-mono right-1 translate-y-1/2" style={{ bottom: `${pct}%` }}>{fmtTick(t)}</span>;
            })}
          </div>
          <div className="absolute left-[-2px] top-1/2 -translate-y-1/2 -rotate-90 text-[10px] text-[#666] font-medium whitespace-nowrap">Views</div>

          <svg ref={svgRef} viewBox={viewBox} className="w-full bg-[#0a0a0a] rounded-lg select-none" style={{ aspectRatio: '4 / 3', cursor: dragging ? 'grabbing' : 'grab' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => { setHovered(null); handleMouseUp(); }}>
            {yTicks.map(t => {
              const y = chartH - ((logSafe(t) - minLogViews) / rangeY) * chartH;
              return <line key={`y${t}`} x1="0" y1={y} x2={chartW} y2={y} stroke="#1a1a1a" strokeWidth="0.15" />;
            })}
            {xTicks.map(t => {
              const x = ((logSafe(t) - minLogSubs) / rangeX) * chartW;
              return <line key={`x${t}`} x1={x} y1="0" x2={x} y2={chartH} stroke="#1a1a1a" strokeWidth="0.15" />;
            })}
            {/* Median lines at ACTUAL data medians (log-space) — match the
                Top-Left Density quadrant the indicator card computes against. */}
            <line x1={medianXpct} y1="0" x2={medianXpct} y2={chartH} stroke="#444" strokeWidth="0.22" strokeDasharray="1.5 1" />
            <line x1="0" y1={medianYpct} x2={chartW} y2={medianYpct} stroke="#444" strokeWidth="0.22" strokeDasharray="1.5 1" />
            {/* Quadrant labels — placed in the corners of the viewport, not at the median
                (so they remain readable even when the median is near an edge). */}
            <rect x="1" y="1" width="24" height="5" rx="1" fill="#1a1a1a" opacity="0.8" />
            <text x="3" y="4.5" fill="#888" fontSize="2.5" fontWeight="600">High views, few subs</text>
            <rect x={chartW - 15} y="1" width="14" height="5" rx="1" fill="#1a1a1a" opacity="0.8" />
            <text x={chartW - 2} y="4.5" fill="#888" fontSize="2.5" fontWeight="600" textAnchor="end">Big players</text>
            <rect x="1" y={chartH - 6} width="12" height="5" rx="1" fill="#1a1a1a" opacity="0.8" />
            <text x="3" y={chartH - 2.5} fill="#888" fontSize="2.5" fontWeight="600">Newcomers</text>
            <rect x={chartW - 20} y={chartH - 6} width="19" height="5" rx="1" fill="#1a1a1a" opacity="0.8" />
            <text x={chartW - 2} y={chartH - 2.5} fill="#888" fontSize="2.5" fontWeight="600" textAnchor="end">High subs, low views</text>
            {filteredDots.map((d, i) => {
              if (d.s <= 0 && d.v <= 0) return null;
              const x = Math.max(0, Math.min(chartW, ((logSafe(d.s) - minLogSubs) / rangeX) * chartW));
              const y = Math.max(0, Math.min(chartH, chartH - ((logSafe(d.v) - minLogViews) / rangeY) * chartH));
              const isH = hovered === i || selected === i;
              return (
                <circle key={i} cx={x} cy={y} r={isH ? 1 : 0.6}
                  fill={getColor(d)} opacity={isH ? 1 : 0.45}
                  stroke={isH ? '#fff' : 'none'} strokeWidth={isH ? 0.2 : 0}
                  className="cursor-pointer"
                  onMouseEnter={() => setHovered(i)}
                  onClick={() => setSelected(selected === i ? null : i)} />
              );
            })}
          </svg>
          <div className="relative mt-1.5" style={{ height: 14 }}>
            {xTicks.map(t => {
              const pct = ((logSafe(t) - minLogSubs) / rangeX) * 100;
              return <span key={t} className="absolute text-[10px] text-[#888] font-mono -translate-x-1/2" style={{ left: `${pct}%` }}>{fmtTick(t)}</span>;
            })}
          </div>
          <div className="text-center text-[10px] text-[#666] font-medium mt-0.5">Subscribers →</div>
        </div>

        {/* Right panel — video detail + filters */}
        <div className="w-72 flex-shrink-0 hidden lg:block">
          <div className="h-[420px] overflow-hidden">
            {(() => {
              const ch = activeVideo;
              if (!ch) {
                return (
                  <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl h-full flex items-center justify-center p-6">
                    <p className="text-[#444] text-xs text-center">{(hovered ?? selected) !== null ? 'Loading...' : 'Hover or click a dot\nto see the video'}</p>
                  </div>
                );
              }
              const timeAgo = (dateStr: string) => {
                const d = new Date(dateStr);
                const days = Math.floor((Date.now() - d.getTime()) / 86400000);
                if (days < 1) return 'Just now';
                if (days < 7) return `${days} days ago`;
                if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
                return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
              };
              return (
                <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden">
                  <div className="relative aspect-video bg-[#0a0a0a]">
                    {ch.thumbnail ? (
                      <a href={ch.videoUrl || '#'} target="_blank" rel="noopener noreferrer">
                        <img src={ch.thumbnail} alt="" className="w-full h-full object-cover" />
                      </a>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#333]">
                        <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </div>
                    )}
                    <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${
                      ch.avgScore >= 80 ? 'bg-green-500 text-white' : ch.avgScore >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'
                    }`}>⚡ {ch.avgScore}</div>
                  </div>
                  <div className="p-3">
                    <div className="flex items-center justify-between mb-2 gap-2">
                      {ch.keyword ? (
                        <span className="text-xs bg-purple-600/30 text-purple-300 border border-purple-600/50 rounded-full px-2 py-0.5 truncate">{ch.keyword}</span>
                      ) : <span />}
                      {/* Refresh button — right of the keyword tag, same row */}
                      <button
                        onClick={(e) => { e.stopPropagation(); refreshVideo(ch.id); }}
                        disabled={refreshingIds.has(ch.id)}
                        title="Refresh data from YouTube"
                        className="w-6 h-6 rounded-full bg-[#1f1f1f] hover:bg-[#2a2a2a] disabled:bg-[#1a1a1a] flex items-center justify-center text-[#888] hover:text-white transition group/refresh flex-shrink-0"
                      >
                        <svg className={`w-3 h-3 ${refreshingIds.has(ch.id) ? 'animate-spin' : 'group-hover/refresh:rotate-90 transition-transform'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      </button>
                    </div>
                    <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{ch.videoTitle || ch.name}</h3>
                    <div className="flex items-center gap-2 text-xs text-[#888] mb-1.5">
                      <span className="text-green-400 font-medium">{fmtYT(ch.views)} views</span>
                      <span>· {ch.name}</span>
                      {(ch.postedAt || ch.postedDate) && <span>· {ch.postedAt ? timeAgo(ch.postedAt) : ch.postedDate}</span>}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-[#666] mb-2">
                      {ch.likeCount > 0 && <span>👍 {fmtYT(ch.likeCount)}</span>}
                      {ch.commentCount > 0 && <span>💬 {fmtYT(ch.commentCount)}</span>}
                      {ch.subs > 0 && <span>👥 {fmtYT(ch.subs)} subs</span>}
                      <ChannelAgeChip
                        firstUploadAt={ch.firstUploadAt}
                        createdAt={
                          // reconstruct ISO from creationAgeDays if we don't have the raw field
                          ch.creationAgeDays != null
                            ? new Date(Date.now() - ch.creationAgeDays * 86_400_000).toISOString()
                            : (ch.ageDays != null && !ch.firstUploadAt
                                ? new Date(Date.now() - ch.ageDays * 86_400_000).toISOString()
                                : undefined)
                        }
                        dormancyDays={ch.dormancyDays}
                      />
                    </div>
                    <div className="flex items-center justify-between mt-2 gap-2">
                      {ch.videoUrl && (
                        <a href={ch.videoUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300 truncate min-w-0 flex-1">{ch.videoUrl}</a>
                      )}
                      {ch.embeddedAt && (
                        <button onClick={() => openSimilar(ch.id)}
                          className="flex items-center gap-1 text-xs bg-green-600/20 text-green-400 border border-green-600/40 px-2.5 py-1 rounded-full hover:bg-green-600/30 transition flex-shrink-0 font-medium">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          Similar
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

          <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3 mt-3">
            <div className="flex items-center justify-between mb-2.5">
              <div className="text-[10px] text-[#666] uppercase tracking-wider">Filters</div>
              {(minViews || maxViews || minSubs || maxSubs || minChAge || maxChAge || minVidAge || maxVidAge) && (
                <button
                  onClick={() => {
                    setMinViews(''); setMaxViews('');
                    setMinSubs(''); setMaxSubs('');
                    setMinChAge(''); setMaxChAge('');
                    setMinVidAge(''); setMaxVidAge('');
                    setHovered(null); setSelected(null);
                  }}
                  className="text-[9px] text-[#888] hover:text-white uppercase tracking-wider"
                >
                  Clear
                </button>
              )}
            </div>

            <label className="flex items-center gap-2 cursor-pointer mb-3">
              <input type="checkbox" checked={onePerChannel} onChange={e => { setOnePerChannel(e.target.checked); setHovered(null); setSelected(null); }}
                className="w-3.5 h-3.5 rounded bg-[#1f1f1f] border-[#333] text-amber-500 focus:ring-amber-500" />
              <span className="text-xs text-[#888]">Best video per channel only</span>
            </label>

            {([
              { label: 'Video views', min: minViews, max: maxViews, setMin: setMinViews, setMax: setMaxViews, ph: ['0', '∞'] },
              { label: 'Subscribers', min: minSubs, max: maxSubs, setMin: setMinSubs, setMax: setMaxSubs, ph: ['0', '∞'] },
              { label: 'Channel age (days)', min: minChAge, max: maxChAge, setMin: setMinChAge, setMax: setMaxChAge, ph: ['0', '∞'] },
              { label: 'Video age (days)', min: minVidAge, max: maxVidAge, setMin: setMinVidAge, setMax: setMaxVidAge, ph: ['0', '∞'] },
            ] as const).map(row => (
              <div key={row.label} className="mb-2 last:mb-0">
                <div className="text-[10px] text-[#888] mb-1">{row.label}</div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number" min="0" inputMode="numeric"
                    value={row.min} onChange={e => { row.setMin(e.target.value); setHovered(null); setSelected(null); }}
                    placeholder={row.ph[0]}
                    className="w-full min-w-0 bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-white placeholder-[#555] focus:outline-none focus:border-amber-500"
                  />
                  <span className="text-[#555] text-xs">–</span>
                  <input
                    type="number" min="0" inputMode="numeric"
                    value={row.max} onChange={e => { row.setMax(e.target.value); setHovered(null); setSelected(null); }}
                    placeholder={row.ph[1]}
                    className="w-full min-w-0 bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-white placeholder-[#555] focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
