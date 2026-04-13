'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
  const [distLoading, setDistLoading] = useState(true);

  // Scatter: lightweight dot data (loaded with distribution)
  const [scatterDots, setScatterDots] = useState<Array<{
    id: number; ch: string; s: number; v: number; sc: number; a: number | null; e: boolean;
  }>>([]);

  useEffect(() => { setSelectedKeyword(keyword); }, [keyword, setSelectedKeyword]);

  useEffect(() => {
    fetch(`/api/niche-spy/saturation?keyword=${encodeURIComponent(keyword)}`)
      .then(r => r.json()).then(d => setSaturation(d)).catch(() => {});
    fetch(`/api/niche-spy/channels?keyword=${encodeURIComponent(keyword)}&limit=0&sort=views&minScore=${filter.minScore}`)
      .then(r => r.json()).then(d => { if (d.stats) setChannelStats(d.stats); }).catch(() => {});
    // Single fast API call for distributions + scatter (all server-side SQL, no limit caps)
    setDistLoading(true);
    fetch(`/api/niche-spy/distribution?keyword=${encodeURIComponent(keyword)}&minScore=${filter.minScore}`)
      .then(r => r.json()).then(d => {
        if (d.subsDist) setSubsDist(d.subsDist);
        if (d.viewsDist) setViewsDist(d.viewsDist);
        if (d.scatter) setScatterDots(d.scatter);
      }).catch(() => {}).finally(() => setDistLoading(false));
  }, [keyword, filter.minScore]);

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto space-y-6">
      {/* Channel Landscape scatter — TOP */}
      {distLoading ? (
        <SkeletonCard title="Channel Landscape" height={300} />
      ) : scatterDots.length > 0 ? (
        <ChannelScatter dots={scatterDots} />
      ) : null}

      {/* Distribution Charts — side by side, below scatter */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {distLoading ? (
          <>
            <SkeletonCard title="Subscriber Distribution" />
            <SkeletonCard title="Views Distribution" />
          </>
        ) : (
          <>
            {subsDist.some(b => b.count > 0) && <DistChart title="Subscriber Distribution" unit="channels" buckets={subsDist} />}
            {viewsDist.some(b => b.count > 0) && <DistChart title="Views Distribution" unit="videos" buckets={viewsDist} />}
          </>
        )}
      </div>

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

/** Loading skeleton placeholder */
function SkeletonCard({ title, height = 130 }: { title: string; height?: number }) {
  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-5 py-4 animate-pulse">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-white">{title}</h3>
          <div className="h-3 w-24 bg-[#1f1f1f] rounded mt-1" />
        </div>
      </div>
      <div className="flex items-end gap-1" style={{ height }}>
        {[35, 55, 80, 65, 40, 20].map((h, i) => (
          <div key={i} className="flex-1 flex items-end">
            <div className="w-full rounded-t-sm bg-[#1f1f1f]" style={{ height: `${h}%` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-2">
        {[1,2,3,4,5,6].map(i => <div key={i} className="h-2 w-8 bg-[#1f1f1f] rounded" />)}
      </div>
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
// Lightweight dot from distribution API
interface ScatterDot {
  id: number; ch: string; s: number; v: number; sc: number; a: number | null; e: boolean;
}

// Full video detail (fetched on demand)
interface ScatterVideo {
  id: number; name: string; subs: number; views: number; avgScore: number; ageDays: number | null; channelId: string | null;
  videoUrl: string | null; videoTitle: string | null; thumbnail: string | null;
  likeCount: number; commentCount: number; postedAt: string | null; postedDate: string | null; keyword: string | null;
  embeddedAt: string | null; topComment: string | null;
}

function ChannelScatter({ dots }: { dots: ScatterDot[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  // On-demand video detail cache
  const [videoCache, setVideoCache] = useState<Record<number, ScatterVideo>>({});
  const [activeVideo, setActiveVideo] = useState<ScatterVideo | null>(null);
  const fetchingRef = useRef<Set<number>>(new Set());

  // Fetch full video data on hover/click (with cache)
  const fetchVideoDetail = useCallback((id: number) => {
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
  }, [videoCache]);

  // Trigger detail fetch when hovered/selected changes
  useEffect(() => {
    const idx = hovered ?? selected;
    if (idx !== null && dots[idx]) {
      fetchVideoDetail(dots[idx].id);
    } else {
      setActiveVideo(null);
    }
  }, [hovered, selected, dots, fetchVideoDetail]);

  // Similar modal state
  const [similarSource, setSimilarSource] = useState<{ id: number; title: string } | null>(null);
  const [allSimilarVideos, setAllSimilarVideos] = useState<Array<{ id: number; title: string; url: string; view_count: number; channel_name: string; score: number; subscriber_count: number; like_count: number; posted_at: string; posted_date: string; thumbnail: string; keyword: string; _similarity: number }>>([]);
  const [similarVideos, setSimilarVideos] = useState<typeof allSimilarVideos>([]);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarMinScore, setSimilarMinScore] = useState(0.7);
  const [similarSort, setSimilarSort] = useState<'similarity' | 'views' | 'score' | 'newest' | 'likes'>('similarity');

  const fetchSimilar = async (videoId: number, title: string) => {
    setSimilarSource({ id: videoId, title });
    setSimilarLoading(true);
    try {
      const res = await fetch(`/api/niche-spy/similar?videoId=${videoId}&limit=500&minSimilarity=0`);
      const data = await res.json();
      const mapped = (data.similar || []).map((v: Record<string, unknown>) => {
        const vidMatch = (v.url as string)?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
        return {
          id: v.id as number, title: v.title as string, url: v.url as string,
          view_count: (v.viewCount as number) || 0, channel_name: v.channelName as string,
          score: (v.score as number) || 0, subscriber_count: (v.subscriberCount as number) || 0,
          like_count: (v.likeCount as number) || 0, posted_at: v.postedAt as string, posted_date: v.postedDate as string,
          thumbnail: vidMatch ? `https://img.youtube.com/vi/${vidMatch[1]}/hqdefault.jpg` : (v.thumbnail as string || ''),
          keyword: v.keyword as string, _similarity: (v.similarity as number) || 0,
        };
      });
      setAllSimilarVideos(mapped);
      setSimilarVideos(mapped.filter((v: { _similarity: number }) => v._similarity >= similarMinScore));
    } catch (err) { console.error('Similar fetch error:', err); }
    setSimilarLoading(false);
  };

  useEffect(() => {
    if (allSimilarVideos.length > 0) {
      setSimilarVideos(allSimilarVideos.filter(v => v._similarity >= similarMinScore));
    }
  }, [similarMinScore, allSimilarVideos]);
  const [colorBy, setColorBy] = useState<'age' | 'score'>('score');
  const [onePerChannel, setOnePerChannel] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  // Pan & zoom state
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const logSafe = (n: number) => Math.log10(Math.max(n, 1));

  // Include ALL dots in range calculation (including subs=0 which maps to log10(1)=0)
  const allLogSubs = dots.map(d => logSafe(d.s));
  const allLogViews = dots.map(d => logSafe(d.v));
  const minLogSubs = allLogSubs.length > 0 ? Math.min(...allLogSubs) : 0;
  const maxLogSubs = allLogSubs.length > 0 ? Math.max(...allLogSubs) : 6;
  const minLogViews = allLogViews.length > 0 ? Math.min(...allLogViews) : 0;
  const maxLogViews = allLogViews.length > 0 ? Math.max(...allLogViews) : 7;
  const rangeX = maxLogSubs - minLogSubs || 1;
  const rangeY = maxLogViews - minLogViews || 1;

  // Compute viewBox from pan + zoom
  const vbW = 100 / zoom;
  const vbH = 100 / zoom;
  const vbX = pan.x;
  const vbY = pan.y;
  const viewBox = `${vbX} ${vbY} ${vbW} ${vbH}`;

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(1, Math.min(zoom * delta, 20));
    // Zoom toward mouse position
    if (svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * vbW + vbX;
      const my = ((e.clientY - rect.top) / rect.height) * vbH + vbY;
      const newVbW = 100 / newZoom;
      const newVbH = 100 / newZoom;
      setPan({
        x: mx - (mx - vbX) * (newVbW / vbW),
        y: my - (my - vbY) * (newVbH / vbH),
      });
    }
    setZoom(newZoom);
  }, [zoom, vbW, vbH, vbX, vbY]);

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

  // Filter: 1 per channel (max views) or all
  const filteredDots = useMemo(() => {
    if (!onePerChannel) return dots;
    const best = new Map<string, number>();
    dots.forEach((d, i) => {
      const prev = best.get(d.ch);
      if (prev === undefined || d.v > dots[prev].v) best.set(d.ch, i);
    });
    return [...best.values()].sort((a, b) => a - b).map(i => dots[i]);
  }, [dots, onePerChannel]);

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

      {/* Chart + Video Card side by side */}
      <div className="flex gap-4">
        {/* Scatter chart — left side */}
        <div className="flex-1 min-w-0 relative" style={{ paddingLeft: 40, paddingBottom: 28 }}>
          {/* Y-axis labels */}
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
            <line x1={chartW / 2} y1="0" x2={chartW / 2} y2={chartH} stroke="#333" strokeWidth="0.2" strokeDasharray="1.5 1" />
            <line x1="0" y1={chartH / 2} x2={chartW} y2={chartH / 2} stroke="#333" strokeWidth="0.2" strokeDasharray="1.5 1" />
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

        {/* Right panel — two fixed sections */}
        <div className="w-72 flex-shrink-0 hidden lg:block">
          {/* Section 1: Video Card — fixed height so filters don't bounce */}
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
                    <div className="flex items-center justify-between mb-2">
                      {ch.keyword && (
                        <span className="text-xs bg-purple-600/30 text-purple-300 border border-purple-600/50 rounded-full px-2 py-0.5">{ch.keyword}</span>
                      )}
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
                      {ch.ageDays !== null && (() => {
                        if (ch.ageDays! < 30) return <span className="text-orange-400">📅 {ch.ageDays}d old</span>;
                        if (ch.ageDays! < 365) return <span>📅 {Math.floor(ch.ageDays! / 30)}mo old</span>;
                        return <span>📅 {(ch.ageDays! / 365).toFixed(1)}yr old</span>;
                      })()}
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      {ch.videoUrl && (
                        <a href={ch.videoUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300 truncate">{ch.videoUrl}</a>
                      )}
                      {ch.embeddedAt && (
                        <button onClick={() => fetchSimilar(ch.id, ch.videoTitle || ch.name)}
                          className="flex items-center gap-1 text-xs bg-green-600/20 text-green-400 border border-green-600/40 px-2.5 py-1 rounded-full hover:bg-green-600/30 transition flex-shrink-0 font-medium ml-2">
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

          {/* Section 2: Filters (always at bottom, never moves) */}
          <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3 mt-3">
            <div className="text-[10px] text-[#666] uppercase tracking-wider mb-2.5">Filters</div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={onePerChannel} onChange={e => { setOnePerChannel(e.target.checked); setHovered(null); setSelected(null); }}
                className="w-3.5 h-3.5 rounded bg-[#1f1f1f] border-[#333] text-amber-500 focus:ring-amber-500" />
              <span className="text-xs text-[#888]">Best video per channel only</span>
            </label>
          </div>
        </div>
      </div>

      {/* Similar Videos Modal — exact same as videos page */}
      {similarSource && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] flex items-start justify-center pt-10 px-4 overflow-y-auto" onClick={() => { setSimilarSource(null); setSimilarVideos([]); setAllSimilarVideos([]); }}>
          <div className="bg-[#111] border border-[#1f1f1f] rounded-2xl w-full max-w-6xl mb-10" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-[#1f1f1f] flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-white">Similar to: <span className="text-purple-400">{similarSource.title}</span></h3>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-xs text-[#888]">{similarVideos.length} results</span>
                  <label className="text-xs text-[#888]">Min match:</label>
                  <select value={similarMinScore} onChange={e => setSimilarMinScore(parseFloat(e.target.value))}
                    className="bg-[#141414] border border-[#1f1f1f] text-white text-xs rounded px-2 py-0.5">
                    <option value={0}>All</option>
                    <option value={0.5}>50%+</option>
                    <option value={0.6}>60%+</option>
                    <option value={0.7}>70%+</option>
                    <option value={0.8}>80%+</option>
                    <option value={0.9}>90%+</option>
                    <option value={0.95}>95%+</option>
                  </select>
                </div>
              </div>
              <button onClick={() => { setSimilarSource(null); setSimilarVideos([]); setAllSimilarVideos([]); }} className="text-[#888] hover:text-white">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            {/* Sort pills */}
            <div className="px-6 pt-3 pb-0 flex gap-2 flex-wrap">
              {([
                { value: 'similarity', label: 'Best Match' },
                { value: 'views', label: 'Most Views' },
                { value: 'score', label: 'Highest Score' },
                { value: 'newest', label: 'Newest' },
                { value: 'likes', label: 'Most Likes' },
              ] as const).map(opt => (
                <button key={opt.value} onClick={() => setSimilarSort(opt.value)}
                  className={`px-3 py-1 rounded-full text-xs transition ${
                    similarSort === opt.value ? 'bg-white text-black font-medium' : 'text-[#888] border border-[#333] hover:border-[#555]'
                  }`}>{opt.label}</button>
              ))}
            </div>
            <div className="p-6">
              {similarLoading ? (
                <div className="text-center py-12 text-[#888]">Finding similar videos...</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {[...similarVideos].sort((a, b) => {
                    switch (similarSort) {
                      case 'views': return b.view_count - a.view_count;
                      case 'score': return b.score - a.score;
                      case 'newest': return new Date(b.posted_at || 0).getTime() - new Date(a.posted_at || 0).getTime();
                      case 'likes': return b.like_count - a.like_count;
                      default: return b._similarity - a._similarity;
                    }
                  }).map(v => (
                    <div key={v.id} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden">
                      <div className="relative aspect-video bg-[#0a0a0a]">
                        {v.thumbnail && <img src={v.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />}
                        <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'}`}>
                          ⚡ {v.score}
                        </div>
                        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs font-bold bg-purple-600 text-white">
                          {Math.round(v._similarity * 100)}% match
                        </div>
                      </div>
                      <div className="p-3">
                        <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
                        <div className="flex items-center gap-2 text-xs text-[#888] mb-1">
                          <span className="text-green-400">{fmtYT(v.view_count)} views</span>
                          {v.channel_name && <span>· {v.channel_name}</span>}
                          {(v.posted_at || v.posted_date) && <span>· {v.posted_at ? (() => {
                            const days = Math.floor((Date.now() - new Date(v.posted_at).getTime()) / 86400000);
                            if (days < 1) return 'Just now';
                            if (days < 7) return `${days} days ago`;
                            if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
                            return new Date(v.posted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                          })() : v.posted_date}</span>}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-[#666]">
                          {v.like_count > 0 && <span>👍 {fmtYT(v.like_count)}</span>}
                          {v.subscriber_count > 0 && <span>👥 {fmtYT(v.subscriber_count)}</span>}
                        </div>
                        {v.url && <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-400 mt-1 block truncate">{v.url}</a>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
