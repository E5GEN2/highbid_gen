'use client';

import React, { useEffect, useState } from 'react';
import { fmtYT } from '@/lib/format';
import { useSimilarModal } from '@/components/SimilarModal';
import { ChannelAgeChip } from '@/components/ChannelAgeChip';
import { StarButton, useFavourites } from '@/components/FavouritesProvider';

interface FavVideo {
  id: number; keyword: string; url: string; title: string; view_count: number;
  channel_name: string; posted_date: string; posted_at: string; score: number;
  channel_created_at: string;
  // Three separate embedding flags so the Similar button can check the
  // right one for the active similarity source.
  embedded_at: string | null;                  // v1 legacy
  title_embedded_v2_at?: string | null;        // v2 title
  thumbnail_embedded_v2_at?: string | null;    // v2 thumbnail
  subscriber_count: number; like_count: number; comment_count: number;
  thumbnail: string; first_upload_at?: string | null; dormancy_days?: number | null;
  added_at: string;
}

type SimilaritySource = 'title_v1' | 'title_v2' | 'thumbnail_v2';
function favHasSimilarEmbedding(v: FavVideo, source: SimilaritySource): boolean {
  switch (source) {
    case 'title_v2':     return !!v.title_embedded_v2_at;
    case 'thumbnail_v2': return !!v.thumbnail_embedded_v2_at;
    default:             return !!v.embedded_at;
  }
}

export default function FavouritesPage() {
  const { openSimilar } = useSimilarModal();
  const { count, ids } = useFavourites();
  const [videos, setVideos] = useState<FavVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [similaritySource, setSimilaritySource] = useState<SimilaritySource>('title_v1');

  // Re-fetch full video rows whenever the global favourites set changes.
  // Using `ids` instead of `count` in the dep so we also refresh on swaps.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/niche-spy/favourites')
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        setVideos(d.videos || []);
        if (d.similaritySource) setSimilaritySource(d.similaritySource);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ids]);

  const timeAgo = (dateStr: string) => {
    const d = new Date(dateStr);
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days < 1) return 'Just now';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getThumb = (url: string | null | undefined, fallback: string) => {
    if (!fallback || fallback.includes('ytimg.com')) {
      const m = url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
      if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
    }
    return fallback || '';
  };

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Favourites</h1>
        <p className="text-sm text-[#888]">
          {count} starred {count === 1 ? 'video' : 'videos'}. Click the ⭐ on any video card to add or remove.
        </p>
      </div>

      {loading && videos.length === 0 && (
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
      )}

      {!loading && videos.length === 0 && (
        <div className="bg-[#141414] border border-dashed border-[#1f1f1f] rounded-xl px-6 py-16 text-center">
          <div className="text-5xl mb-3">⭐</div>
          <h3 className="text-base font-medium text-white mb-1">No favourites yet</h3>
          <p className="text-sm text-[#666]">Browse any niche and tap the star icon on a video card to save it here.</p>
        </div>
      )}

      {videos.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {videos.map(v => (
            <div key={v.id} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden hover:border-[#333] transition">
              <div className="relative aspect-video bg-[#0a0a0a]">
                {(() => {
                  const t = getThumb(v.url, v.thumbnail);
                  return t ? <img src={t} alt="" className="w-full h-full object-cover" loading="lazy" /> : null;
                })()}
                <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${
                  v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'
                }`}>⚡ {v.score}</div>
              </div>
              <div className="p-3">
                <div className="flex items-center justify-between mb-2 gap-2">
                  {v.keyword && (
                    <span className="text-xs bg-purple-600/30 text-purple-300 border border-purple-600/50 rounded-full px-2 py-0.5">
                      {v.keyword}
                    </span>
                  )}
                  <div className="flex items-center gap-1.5 ml-auto">
                    <StarButton videoId={v.id} />
                    {favHasSimilarEmbedding(v, similaritySource) && (
                      <button
                        onClick={() => openSimilar(v.id)}
                        className="flex items-center gap-1 text-xs bg-green-600/20 text-green-400 border border-green-600/40 px-2.5 py-1 rounded-full hover:bg-green-600/30 transition flex-shrink-0 font-medium"
                      >
                        Similar
                      </button>
                    )}
                  </div>
                </div>
                <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
                <div className="flex items-center gap-2 text-xs text-[#888] mb-1.5 flex-wrap">
                  <span className="text-green-400 font-medium">{v.view_count ? fmtYT(v.view_count) + ' views' : ''}</span>
                  {v.channel_name && <span>· {v.channel_name}</span>}
                  {(v.posted_at || v.posted_date) && <span>· {v.posted_at ? timeAgo(v.posted_at) : v.posted_date}</span>}
                </div>
                <div className="flex items-center gap-3 text-xs text-[#666] flex-wrap mb-2">
                  {v.like_count > 0 && <span>👍 {fmtYT(v.like_count)}</span>}
                  {v.comment_count > 0 && <span>💬 {fmtYT(v.comment_count)}</span>}
                  {v.subscriber_count > 0 && <span>👥 {fmtYT(v.subscriber_count)} subscribers</span>}
                  <ChannelAgeChip
                    createdAt={v.channel_created_at}
                    firstUploadAt={v.first_upload_at}
                    dormancyDays={v.dormancy_days}
                  />
                </div>
                {v.url && (
                  <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300 truncate block">
                    {v.url}
                  </a>
                )}
                <div className="text-[10px] text-[#555] mt-2">Starred {timeAgo(v.added_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
