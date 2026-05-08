'use client';

import React from 'react';
import Link from 'next/link';
import { ChannelAgeChip } from './ChannelAgeChip';
import { StarButton } from './FavouritesProvider';
import { fmtYT } from '@/lib/format';

/**
 * Shared video card for niche grids — same shape as the similar-page
 * cards (/niche/similar/[id]/videos) so every video grid in the
 * product looks consistent. Lean by design: thumbnail + score, title,
 * channel + time, likes/subs/age, URL + Star + Similar link. No
 * top-comment quote or refresh button — those belong on the deeper
 * keyword-scoped Videos tab where editing/refreshing is the user's job.
 *
 * Optional `similarity` shows a purple "% match" pill (search results,
 * similar-to-video). Optional `distanceToCentroid` shows a small
 * `d=0.42` chip when ranking by cluster centrality.
 */

export interface NicheVideoCardData {
  id: number;
  url: string | null;
  title: string | null;
  thumbnail: string | null;
  channelName: string | null;
  viewCount: number | null;
  likeCount: number | null;
  subscriberCount: number | null;
  channelCreatedAt: string | null;
  firstUploadAt: string | null;
  dormancyDays: number | null;
  postedAt: string | null;
  postedDate: string | null;
  score: number | null;
  similarity?: number;
  distanceToCentroid?: number | null;
}

export function NicheVideoCard({ video: v }: { video: NicheVideoCardData }) {
  const thumb = getThumb(v.url ?? '', v.thumbnail ?? '');
  const score = v.score ?? 0;
  const scoreBand = score >= 80 ? 'bg-green-500 text-white'
    : score >= 50 ? 'bg-yellow-500 text-black'
    : 'bg-red-500 text-white';

  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden">
      <div className="relative aspect-video bg-[#0a0a0a]">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : null}
        <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${scoreBand}`}>
          ⚡ {score}
        </div>
        {v.similarity !== undefined ? (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs font-bold bg-purple-600 text-white">
            {Math.round(v.similarity * 100)}% match
          </div>
        ) : v.distanceToCentroid != null ? (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-bold bg-black/70 text-white border border-white/10" title="Distance to cluster centroid (lower = more representative)">
            d={v.distanceToCentroid.toFixed(2)}
          </div>
        ) : null}
      </div>
      <div className="p-3">
        <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title ?? '(no title)'}</h3>
        <div className="flex items-center gap-2 text-xs text-[#888] mb-1 flex-wrap">
          {v.viewCount != null && <span className="text-green-400">{fmtYT(v.viewCount)} views</span>}
          {v.channelName && <span>· {v.channelName}</span>}
          {(v.postedAt || v.postedDate) && (
            <span>· {v.postedAt ? formatTimeAgo(v.postedAt) : v.postedDate}</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-[#666] flex-wrap">
          {(v.likeCount ?? 0) > 0 && <span>👍 {fmtYT(v.likeCount ?? 0)}</span>}
          {(v.subscriberCount ?? 0) > 0 && <span>👥 {fmtYT(v.subscriberCount ?? 0)}</span>}
          <ChannelAgeChip
            createdAt={v.channelCreatedAt}
            firstUploadAt={v.firstUploadAt}
            dormancyDays={v.dormancyDays}
          />
        </div>
        <div className="flex items-center justify-between mt-2 gap-2">
          {v.url ? (
            <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-400 truncate min-w-0 flex-1">{v.url}</a>
          ) : (
            <span className="flex-1" />
          )}
          <StarButton videoId={v.id} />
          <Link
            href={`/niche/similar/${v.id}`}
            className="flex items-center gap-1 text-xs bg-green-600/20 text-green-400 border border-green-600/40 px-2 py-0.5 rounded-full hover:bg-green-600/30 transition flex-shrink-0 font-medium"
          >
            Similar
          </Link>
        </div>
      </div>
    </div>
  );
}

function formatTimeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return 'Just now';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getThumb(url: string, thumb: string): string {
  const m = url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : (thumb || '');
}
