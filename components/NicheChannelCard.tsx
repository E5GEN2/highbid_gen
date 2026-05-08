'use client';

import React from 'react';
import { ChannelAgeChip } from './ChannelAgeChip';
import { fmtYT } from '@/lib/format';

/**
 * Wide-row channel card — same shape as NicheClusterCard so a user
 * scanning the Channels grid gets the same density and visual rhythm
 * as the Niches grid. Avatar + name + meta on the header, 4-tile stat
 * row, then a "Most Popular Videos" thumb strip with titles + view
 * counts. Picks readability over density: each row is full-width,
 * thumbs are large enough to read titles and recognise channels.
 */

export interface ChannelCardPopularVideo {
  videoId: number;
  title: string | null;
  thumbnail: string | null;
  url: string | null;
  viewCount: number | null;
  postedAt: string | null;
  postedDate: string | null;
}

export interface ChannelCardData {
  channelName: string;
  channelAvatar: string | null;
  channelId: string | null;
  channelHandle: string | null;
  channelCreatedAt: string | null;
  firstUploadAt: string | null;
  dormancyDays: number | null;
  subscribers: number;
  videoCount: number;            // authoritative YT total when enriched
  videoCountInNiche: number;     // count we've scraped
  totalVideoCount: number | null;
  totalViews: number;
  avgViews: number;
  maxViews: number;
  avgScore: number;
  maxScore: number;
  totalLikes: number;
  totalComments: number;
  keywords: string[];
  popularVideos: ChannelCardPopularVideo[];
}

function youtubeChannelUrl(ch: { channelHandle: string | null; channelId: string | null }): string | null {
  if (ch.channelHandle) {
    const h = ch.channelHandle.startsWith('@') ? ch.channelHandle : `@${ch.channelHandle}`;
    return `https://www.youtube.com/${h}`;
  }
  if (ch.channelId) return `https://www.youtube.com/channel/${ch.channelId}`;
  return null;
}

export function NicheChannelCard({ channel: ch }: { channel: ChannelCardData }) {
  const ytUrl = youtubeChannelUrl(ch);
  const score = ch.avgScore || 0;
  const scoreColor =
    score >= 80 ? 'text-green-400' :
    score >= 50 ? 'text-yellow-400' :
                  'text-red-400';

  // Pad popular videos to 4 slots so the thumb strip stays aligned for
  // sparse channels.
  const slots: Array<ChannelCardPopularVideo | null> = [...ch.popularVideos];
  while (slots.length < 4) slots.push(null);

  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl hover:border-[#333] transition">
      {/* Header strip: avatar + name + handle + subs + age + score */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <a
            href={ytUrl || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className={`w-12 h-12 rounded-full bg-[#1f1f1f] flex-shrink-0 overflow-hidden ${ytUrl ? 'hover:ring-2 hover:ring-red-500/50 transition' : 'pointer-events-none'}`}
            aria-label={ytUrl ? `Open ${ch.channelName} on YouTube` : undefined}
            onClick={e => e.stopPropagation()}
          >
            {ch.channelAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={ch.channelAvatar} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[#666] text-base font-bold">
                {(ch.channelName || '?').charAt(0).toUpperCase()}
              </div>
            )}
          </a>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {ytUrl ? (
                <a href={ytUrl} target="_blank" rel="noopener noreferrer"
                  className="text-base font-semibold text-white hover:text-red-400 transition truncate"
                  onClick={e => e.stopPropagation()}
                  title={ch.channelName}>
                  {ch.channelName}
                </a>
              ) : (
                <h3 className="text-base font-semibold text-white truncate" title={ch.channelName}>{ch.channelName}</h3>
              )}
              {ch.channelHandle && (
                <span className="text-[11px] text-[#555] truncate">
                  {ch.channelHandle.startsWith('@') ? ch.channelHandle : `@${ch.channelHandle}`}
                </span>
              )}
              <ChannelAgeChip
                createdAt={ch.channelCreatedAt}
                firstUploadAt={ch.firstUploadAt}
                dormancyDays={ch.dormancyDays}
              />
            </div>
            <div className="text-xs text-[#888] mt-0.5 flex items-center gap-2 flex-wrap">
              {ch.subscribers > 0 && <span>{fmtYT(ch.subscribers)} subscribers</span>}
              {ch.keywords.length > 0 && (
                <span className="truncate" title={ch.keywords.join(', ')}>
                  · {ch.keywords.slice(0, 3).join(', ')}
                  {ch.keywords.length > 3 && ` +${ch.keywords.length - 3}`}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="text-right flex-shrink-0">
          <div className={`text-lg font-bold ${scoreColor}`}>⚡ {score}</div>
          <div className="text-[10px] text-[#666] uppercase tracking-wider">avg score</div>
        </div>
      </div>

      {/* 4-tile stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-4 mb-3">
        <Stat label="Total views"      value={fmtYT(ch.totalViews)}    valueColor="text-green-400" />
        <Stat label="Avg views / video" value={fmtYT(ch.avgViews)} />
        <Stat label="Best video"        value={fmtYT(ch.maxViews)}     valueColor="text-purple-400" />
        <Stat
          label={ch.totalVideoCount == null ? 'Videos (partial)' : 'Videos'}
          value={fmtYT(ch.videoCount)}
          valueColor="text-blue-400"
          tooltip={ch.totalVideoCount != null
            ? `${ch.totalVideoCount} total on YouTube · ${ch.videoCountInNiche} scraped`
            : `${ch.videoCountInNiche} scraped · channel not yet enriched`}
        />
      </div>

      {/* Popular Videos strip — same hover-zoom pattern as the niche
          cluster card. transformOrigin per index so edge tiles expand
          inward instead of clipping past the row's edge. */}
      <div className="px-4 pb-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[11px] text-[#666] uppercase tracking-wider">Most popular videos</h4>
          {ch.popularVideos.length > 0 && (
            <span className="text-[10px] text-[#666]" title="Top videos by view count from this channel.">
              top {ch.popularVideos.length} by views
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {slots.map((v, i) => {
            const origin = i === 0 ? 'left center' : i === 3 ? 'right center' : 'center';
            return v ? (
              <a
                key={v.videoId}
                href={v.url || '#'}
                target="_blank"
                rel="noreferrer"
                onClick={e => e.stopPropagation()}
                className="block group/thumb relative transition-transform duration-200 ease-out hover:scale-[1.45] hover:z-20 hover:shadow-2xl"
                style={{ transformOrigin: origin }}
              >
                <div className="relative aspect-video bg-[#0a0a0a] rounded-md overflow-hidden border border-[#1f1f1f] group-hover/thumb:border-[#444] transition">
                  {v.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[#333] text-[10px]">no thumb</div>
                  )}
                </div>
                <div className="mt-1.5 text-[11px] text-white line-clamp-2 leading-tight" title={v.title || ''}>
                  {v.title || '(no title)'}
                </div>
                <div className="mt-0.5 text-[10px] text-[#666]">
                  {v.viewCount != null && <span className="text-green-400/90">{fmtYT(v.viewCount)} views</span>}
                </div>
              </a>
            ) : (
              <div key={`empty-${i}`} className="aspect-video bg-[#0a0a0a] border border-dashed border-[#1f1f1f] rounded-md flex items-center justify-center text-[#333] text-[10px]">
                —
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, valueColor = 'text-white', tooltip }: { label: string; value: string; valueColor?: string; tooltip?: string }) {
  return (
    <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-3 py-2" title={tooltip}>
      <div className="text-[10px] text-[#666] uppercase tracking-wider">{label}</div>
      <div className={`text-base font-semibold ${valueColor} mt-0.5`}>{value}</div>
    </div>
  );
}
