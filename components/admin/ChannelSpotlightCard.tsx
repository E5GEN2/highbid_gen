'use client';

import React, { useRef } from 'react';
import { NICHE_COLORS } from '../../lib/niches';

interface ChannelSpotlightProps {
  channelName: string;
  avatarUrl: string | null;
  niche: string;
  subscriberCount: number | null;
  ageDays: number | null;
  totalViews: number;
  videoCount: number | null;
  thumbnails: string[];
}

function formatNumber(n: number | null): string {
  if (n === null || n === undefined) return '?';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function formatAge(days: number | null): string {
  if (days === null) return '?';
  if (days < 30) return `${days} days`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  return `${(days / 365).toFixed(1)} years`;
}

export default function ChannelSpotlightCard({
  channelName, avatarUrl, niche, subscriberCount,
  ageDays, totalViews, videoCount, thumbnails,
}: ChannelSpotlightProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const handleDownload = async () => {
    try {
      const html2canvas = (await import('html2canvas')).default;
      if (!cardRef.current) return;
      const canvas = await html2canvas(cardRef.current, {
        backgroundColor: null,
        scale: 2,
        useCORS: true,
        allowTaint: false,
        logging: false,
      });
      const link = document.createElement('a');
      link.download = `spotlight-${channelName.replace(/\s+/g, '-')}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (err) {
      console.error('Download failed:', err);
      alert('Download failed — check console for details');
    }
  };

  return (
    <div>
      <div
        ref={cardRef}
        className="rounded-2xl p-6 w-full max-w-lg"
        style={{ background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' }}
      >
        {/* Channel header */}
        <div className="flex items-center gap-3 mb-4">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="w-14 h-14 rounded-full" />
          ) : (
            <div className="w-14 h-14 rounded-full bg-gray-700 flex items-center justify-center text-white text-xl font-bold">
              {(channelName?.[0] ?? '?').toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-white text-lg font-bold truncate">{channelName}</div>
            <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold text-white mt-1 ${NICHE_COLORS[niche] || 'bg-gray-600'}`}>
              {niche}
            </span>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {[
            { label: 'Subscribers', value: formatNumber(subscriberCount) },
            { label: 'Age', value: formatAge(ageDays) },
            { label: 'Total Views', value: formatNumber(totalViews) },
            { label: 'Videos', value: videoCount !== null ? videoCount.toString() : '?' },
          ].map((stat, i) => (
            <div key={i} className="bg-white/5 rounded-lg p-2 text-center">
              <div className="text-white text-sm font-bold">{stat.value}</div>
              <div className="text-gray-500 text-[10px] mt-0.5">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* 2x2 thumbnail grid */}
        {thumbnails.length > 0 && (
          <div className="grid grid-cols-2 gap-1 rounded-xl overflow-hidden">
            {thumbnails.slice(0, 4).map((src, i) => (
              <img key={i} src={src} alt="" className="w-full h-28 object-cover" />
            ))}
          </div>
        )}

        {/* Watermark */}
        <div className="text-center mt-4 text-xs text-gray-600">rofe.ai</div>
      </div>

      <button
        onClick={handleDownload}
        className="mt-3 px-4 py-2 text-xs bg-gray-900 text-gray-400 rounded-lg hover:bg-gray-800 hover:text-white transition flex items-center gap-1.5"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
        Download Card
      </button>
    </div>
  );
}
