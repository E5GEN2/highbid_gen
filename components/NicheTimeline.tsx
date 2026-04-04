'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

interface TimelinePoint {
  period: string;
  count: number;
  avgScore: number;
  totalViews: number;
  keywords: number;
  channels: number;
}

interface TimelineData {
  timeline: TimelinePoint[];
  granularity: string;
  stats: {
    total: number;
    avgScore: number;
    earliest: string;
    latest: string;
    keywords: number;
    channels: number;
  };
}

interface Props {
  keyword?: string;
  minScore?: number;
  maxScore?: number;
  onRangeChange?: (from: string | null, to: string | null) => void;
}

function formatDate(d: Date, granularity: string): string {
  if (granularity === 'day') return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (granularity === 'week') return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

export default function NicheTimeline({ keyword, minScore, maxScore, onRangeChange }: Props) {
  const [data, setData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(false);
  const [rangeFrom, setRangeFrom] = useState<string | null>(null);
  const [rangeTo, setRangeTo] = useState<string | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchTimeline = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (keyword && keyword !== 'all') params.set('keyword', keyword);
    if (rangeFrom) params.set('from', rangeFrom);
    if (rangeTo) params.set('to', rangeTo);
    if (minScore) params.set('minScore', String(minScore));
    if (maxScore && maxScore < 100) params.set('maxScore', String(maxScore));

    try {
      const res = await fetch(`/api/niche-spy/timeline?${params}`);
      const d = await res.json();
      setData(d);
    } catch (err) { console.error('Timeline fetch error:', err); }
    setLoading(false);
  }, [keyword, rangeFrom, rangeTo, minScore, maxScore]);

  useEffect(() => { fetchTimeline(); }, [fetchTimeline]);

  const getBarX = useCallback((idx: number, total: number, width: number): number => {
    const barWidth = width / Math.max(total, 1);
    return idx * barWidth;
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!containerRef.current || !data) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setIsDragging(true);
    setDragStart(x);
    setDragEnd(x);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current || !data) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (isDragging) {
      setDragEnd(x);
    } else {
      // Hover
      const barW = rect.width / data.timeline.length;
      const idx = Math.floor(x / barW);
      setHoveredIdx(idx >= 0 && idx < data.timeline.length ? idx : null);
    }
  };

  const handleMouseUp = () => {
    if (!isDragging || dragStart === null || dragEnd === null || !data || !containerRef.current) {
      setIsDragging(false);
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    const barW = rect.width / data.timeline.length;
    const startIdx = Math.max(0, Math.floor(Math.min(dragStart, dragEnd) / barW));
    const endIdx = Math.min(data.timeline.length - 1, Math.floor(Math.max(dragStart, dragEnd) / barW));

    if (endIdx - startIdx >= 1) {
      const from = data.timeline[startIdx].period;
      const to = data.timeline[endIdx].period;
      setRangeFrom(from);
      setRangeTo(to);
      onRangeChange?.(from, to);
    }

    setIsDragging(false);
    setDragStart(null);
    setDragEnd(null);
  };

  const resetZoom = () => {
    setRangeFrom(null);
    setRangeTo(null);
    onRangeChange?.(null, null);
  };

  if (loading && !data) return <div className="h-48 bg-gray-800/40 rounded-xl animate-pulse" />;
  if (!data || data.timeline.length === 0) return null;

  const maxCount = Math.max(...data.timeline.map(t => t.count));
  const timeline = data.timeline;

  return (
    <div className="bg-gray-800/40 border border-gray-700 rounded-xl p-4 mb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-white">Video Timeline</h3>
          <span className="text-xs text-gray-500">
            {data.stats.total.toLocaleString()} videos · {data.stats.keywords} keywords · {data.stats.channels.toLocaleString()} channels
          </span>
          {(rangeFrom || rangeTo) && (
            <button onClick={resetZoom} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7" />
              </svg>
              Reset zoom
            </button>
          )}
        </div>
        <span className="text-xs text-gray-500">{data.granularity} · drag to zoom</span>
      </div>

      {/* Chart — SVG bar chart */}
      <div
        ref={containerRef}
        className="relative h-40 select-none cursor-crosshair"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { setHoveredIdx(null); if (isDragging) handleMouseUp(); }}
      >
        <svg width="100%" height="100%" viewBox={`0 0 ${timeline.length * 40} 160`} preserveAspectRatio="none">
          {/* Grid lines */}
          {[0.25, 0.5, 0.75].map(f => (
            <line key={f} x1="0" y1={160 * (1 - f)} x2={timeline.length * 40} y2={160 * (1 - f)} stroke="#374151" strokeWidth="0.5" strokeDasharray="4" />
          ))}

          {/* Bars */}
          {timeline.map((t, i) => {
            const barH = maxCount > 0 ? (t.count / maxCount) * 140 : 2;
            const x = i * 40;
            const isHovered = hoveredIdx === i;
            const fill = isHovered ? '#60a5fa'
              : t.avgScore >= 80 ? '#22c55e'
              : t.avgScore >= 50 ? '#eab308'
              : '#ef4444';
            return (
              <rect
                key={i}
                x={x + 4}
                y={160 - Math.max(barH, 2)}
                width={32}
                height={Math.max(barH, 2)}
                rx={3}
                fill={fill}
                opacity={isHovered ? 1 : 0.75}
              />
            );
          })}

          {/* Area/line overlay for trend */}
          <polyline
            points={timeline.map((t, i) => `${i * 40 + 20},${160 - (maxCount > 0 ? (t.count / maxCount) * 140 : 0)}`).join(' ')}
            fill="none"
            stroke="rgba(96,165,250,0.5)"
            strokeWidth="2"
          />
        </svg>

        {/* Drag selection overlay */}
        {isDragging && dragStart !== null && dragEnd !== null && (
          <div
            className="absolute top-0 bottom-0 bg-blue-500/20 border-x-2 border-blue-400 rounded"
            style={{
              left: Math.min(dragStart, dragEnd),
              width: Math.abs(dragEnd - dragStart),
            }}
          />
        )}

        {/* Hover tooltip */}
        {hoveredIdx !== null && hoveredIdx < timeline.length && (
          <div
            className="absolute bg-gray-900/95 border border-gray-600 rounded-lg px-3 py-2 pointer-events-none z-10 shadow-xl backdrop-blur-sm"
            style={{
              left: `${Math.min((hoveredIdx / timeline.length) * 100, 80)}%`,
              top: '4px',
            }}
          >
            <p className="text-xs text-white font-medium">
              {formatDate(new Date(timeline[hoveredIdx].period), data.granularity)}
            </p>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-sm text-blue-300 font-bold">{timeline[hoveredIdx].count} videos</span>
              <span className="text-xs text-gray-400">score: {timeline[hoveredIdx].avgScore}</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              {formatCount(timeline[hoveredIdx].totalViews)} views · {timeline[hoveredIdx].channels} channels
            </p>
          </div>
        )}
      </div>

      {/* X-axis labels */}
      <div className="flex justify-between mt-1">
        {timeline.length > 0 && (
          <>
            <span className="text-[10px] text-gray-600">{formatDate(new Date(timeline[0].period), data.granularity)}</span>
            {timeline.length > 4 && (
              <span className="text-[10px] text-gray-600">{formatDate(new Date(timeline[Math.floor(timeline.length / 2)].period), data.granularity)}</span>
            )}
            <span className="text-[10px] text-gray-600">{formatDate(new Date(timeline[timeline.length - 1].period), data.granularity)}</span>
          </>
        )}
      </div>
    </div>
  );
}
