'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { fmtYT } from '@/lib/format';
import { useSimilar } from '@/components/SimilarProvider';

/** Similar-cluster Videos tab — grid of matching videos sorted by similarity/views/etc. */
export default function SimilarVideos() {
  const { filtered, loading, error } = useSimilar();
  const [sort, setSort] = useState<'similarity' | 'views' | 'score' | 'newest' | 'likes'>('similarity');

  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sort) {
      case 'views':  return arr.sort((a, b) => b.viewCount - a.viewCount);
      case 'score':  return arr.sort((a, b) => b.score - a.score);
      case 'newest': return arr.sort((a, b) => new Date(b.postedAt || 0).getTime() - new Date(a.postedAt || 0).getTime());
      case 'likes':  return arr.sort((a, b) => b.likeCount - a.likeCount);
      default:       return arr.sort((a, b) => b.similarity - a.similarity);
    }
  }, [filtered, sort]);

  if (loading) {
    return (
      <div className="px-8 pb-8 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden animate-pulse">
              <div className="aspect-video bg-[#1f1f1f]" />
              <div className="p-3 space-y-2">
                <div className="h-4 w-3/4 bg-[#1f1f1f] rounded" />
                <div className="h-3 w-1/2 bg-[#1f1f1f] rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-8 pb-8 max-w-7xl mx-auto">
        <div className="bg-red-900/20 border border-red-800/40 rounded-xl px-5 py-4 text-red-400">
          Couldn&apos;t load similar videos: {error}
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="px-8 pb-8 max-w-7xl mx-auto">
        <div className="bg-[#141414] border border-dashed border-[#1f1f1f] rounded-xl px-5 py-8 text-center text-[#666]">
          No similar videos match the threshold. Lower the min match from the header.
        </div>
      </div>
    );
  }

  return (
    <div className="px-8 pb-8 max-w-7xl mx-auto space-y-4">
      {/* Sort pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {([
          { value: 'similarity', label: 'Best Match' },
          { value: 'views', label: 'Most Views' },
          { value: 'score', label: 'Highest Score' },
          { value: 'newest', label: 'Newest' },
          { value: 'likes', label: 'Most Likes' },
        ] as const).map(opt => (
          <button
            key={opt.value}
            onClick={() => setSort(opt.value)}
            className={`px-3 py-1 rounded-full text-xs transition ${
              sort === opt.value ? 'bg-white text-black font-medium' : 'text-[#888] border border-[#333] hover:border-[#555]'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sorted.map(v => {
          const vidMatch = (v.url || '').match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
          const thumb = v.thumbnail || (vidMatch ? `https://img.youtube.com/vi/${vidMatch[1]}/hqdefault.jpg` : '');
          return (
            <div key={v.id} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden">
              <div className="relative aspect-video bg-[#0a0a0a]">
                {thumb && <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />}
                <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'}`}>
                  ⚡ {v.score}
                </div>
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs font-bold bg-purple-600 text-white">
                  {Math.round(v.similarity * 100)}% match
                </div>
              </div>
              <div className="p-3">
                <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
                <div className="flex items-center gap-2 text-xs text-[#888] mb-1">
                  <span className="text-green-400">{fmtYT(v.viewCount)} views</span>
                  {v.channelName && <span>· {v.channelName}</span>}
                  {v.postedAt && <span>· {formatTimeAgo(v.postedAt)}</span>}
                </div>
                <div className="flex items-center gap-3 text-xs text-[#666] flex-wrap">
                  {v.likeCount > 0 && <span>👍 {fmtYT(v.likeCount)}</span>}
                  {v.subscriberCount > 0 && <span>👥 {fmtYT(v.subscriberCount)}</span>}
                  {v.channelCreatedAt && (() => {
                    const days = Math.floor((Date.now() - new Date(v.channelCreatedAt).getTime()) / 86400000);
                    if (days < 30) return <span className="text-orange-400">📅 {days}d old</span>;
                    if (days < 365) return <span>📅 {Math.floor(days / 30)}mo old</span>;
                    return <span>📅 {(days / 365).toFixed(1)}yr old</span>;
                  })()}
                </div>
                <div className="flex items-center justify-between mt-2 gap-2">
                  {v.url && <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-400 truncate min-w-0 flex-1">{v.url}</a>}
                  <Link href={`/niche/similar/${v.id}`}
                    className="flex items-center gap-1 text-xs bg-green-600/20 text-green-400 border border-green-600/40 px-2 py-0.5 rounded-full hover:bg-green-600/30 transition flex-shrink-0 font-medium">
                    Similar
                  </Link>
                </div>
              </div>
            </div>
          );
        })}
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
