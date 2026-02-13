'use client';

import React, { useRef } from 'react';
import { NICHE_COLORS } from '../../lib/niches';

interface LeaderboardChannel {
  channel_name: string;
  avatar_url: string | null;
  subscriber_count: number | null;
  age_days: number | null;
  velocity: number;
  niche: string;
}

interface LeaderboardCardProps {
  channels: LeaderboardChannel[];
  date: string;
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

export default function LeaderboardCard({ channels, date }: LeaderboardCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const handleDownload = async () => {
    try {
      const html2canvas = (await import('html2canvas-pro')).default;
      if (!cardRef.current) return;
      const canvas = await html2canvas(cardRef.current, {
        backgroundColor: null,
        scale: 2,
        useCORS: true,
        allowTaint: false,
        logging: false,
      });
      const link = document.createElement('a');
      link.download = `leaderboard-${date}.png`;
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
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <div className="text-xs text-gray-400 tracking-wider uppercase">rofe.ai</div>
            <h3 className="text-lg font-bold text-white mt-0.5">Today&apos;s Fastest Growing Shorts Channels</h3>
          </div>
          <div className="text-xs text-gray-500">{date}</div>
        </div>

        {/* Ranked list */}
        <div className="space-y-3">
          {channels.slice(0, 5).map((ch, i) => (
            <div key={i} className="flex items-center gap-3 bg-white/5 rounded-xl p-3">
              <div className="text-2xl font-bold text-gray-500 w-7 text-center shrink-0">
                {i + 1}
              </div>
              {ch.avatar_url ? (
                <img src={ch.avatar_url} alt="" className="w-10 h-10 rounded-full shrink-0" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center text-white text-sm font-bold shrink-0">
                  {(ch.channel_name?.[0] ?? '?').toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-white text-sm font-semibold truncate">{ch.channel_name}</div>
                <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
                  <span>{formatNumber(ch.subscriber_count)} subs</span>
                  <span>·</span>
                  <span>{formatAge(ch.age_days)} old</span>
                  <span>·</span>
                  <span>{formatNumber(ch.velocity)} views/day</span>
                </div>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold text-white shrink-0 ${NICHE_COLORS[ch.niche] || 'bg-gray-600'}`}>
                {ch.niche}
              </span>
            </div>
          ))}
        </div>

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
