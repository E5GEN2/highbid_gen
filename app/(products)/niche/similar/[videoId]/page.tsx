'use client';

import React, { useState, useEffect, useMemo, useCallback, Suspense } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { fmtYT } from '@/lib/format';
import { OpportunityIndicators, OpportunityIndicatorsSkeleton } from '@/components/OpportunityIndicators';
import { ChannelScatter, type ScatterDot, type ScatterVideo } from '@/components/ChannelScatter';
import { DistBars, DistBarsSkeleton, makeSubsBuckets, makeViewsBuckets } from '@/components/DistBars';

/**
 * /niche/similar/[videoId]
 *
 * Treats the set of videos similar to a given video as an ad-hoc niche.
 * Computes the same insights (opportunity, scatter, distributions) against
 * this semantic cluster — useful for evaluating whether a video's *style* is
 * an opportunity space, independent of its surrounding keyword.
 *
 * The `minSimilarity` slider filters which videos feed the insights and grid
 * live — drop it low for a wider view, push it high for a tight cluster.
 */

interface SimilarVideo {
  id: number;
  title: string;
  url: string;
  viewCount: number;
  channelName: string;
  postedAt: string | null;
  postedDate: string | null;
  score: number;
  subscriberCount: number;
  likeCount: number;
  commentCount: number;
  topComment: string | null;
  thumbnail: string | null;
  keyword: string | null;
  channelCreatedAt: string | null;
  similarity: number;
}

interface SimilarResponse {
  source: { id: number; title: string; keyword: string };
  similar: SimilarVideo[];
  totalCandidates?: number;
  message?: string;
}

export default function SimilarInsightsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[50vh]"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-amber-500" /></div>}>
      <SimilarInsightsInner />
    </Suspense>
  );
}

function SimilarInsightsInner() {
  const { videoId: rawId } = useParams<{ videoId: string }>();
  const videoId = parseInt(rawId);

  const [data, setData] = useState<SimilarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minSimilarity, setMinSimilarity] = useState(0.7);
  const [sort, setSort] = useState<'similarity' | 'views' | 'score' | 'newest' | 'likes'>('similarity');

  useEffect(() => {
    if (!videoId) return;
    setLoading(true);
    setError(null);
    // Pull the full set once (limit 500, minSimilarity=0) — we filter client-side
    fetch(`/api/niche-spy/similar?videoId=${videoId}&limit=500&minSimilarity=0`)
      .then(r => r.json())
      .then((d: SimilarResponse) => {
        if ((d as unknown as { error?: string }).error) throw new Error((d as unknown as { error: string }).error);
        setData(d);
      })
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [videoId]);

  // Filter by user-selected minSimilarity
  const filteredSimilar = useMemo(() => {
    if (!data) return [];
    return data.similar.filter(v => v.similarity >= minSimilarity);
  }, [data, minSimilarity]);

  // Build ScatterDot shape from similar videos (channel age in days, video age in days)
  const scatterDots: ScatterDot[] = useMemo(() => {
    return filteredSimilar.map(v => {
      const chAge = v.channelCreatedAt ? Math.floor((Date.now() - new Date(v.channelCreatedAt).getTime()) / 86400000) : null;
      const vidAge = v.postedAt ? Math.floor((Date.now() - new Date(v.postedAt).getTime()) / 86400000) : null;
      return {
        id: v.id,
        ch: v.channelName || '',
        s: v.subscriberCount || 0,
        v: v.viewCount || 0,
        sc: v.score || 0,
        a: chAge,
        va: vidAge,
        e: true,
      };
    });
  }, [filteredSimilar]);

  // Synchronous lookup for the scatter's video-detail card — no extra API call needed
  // since we already have everything in memory.
  const videoLookup = useCallback((id: number): ScatterVideo | null => {
    const v = filteredSimilar.find(x => x.id === id);
    if (!v) return null;
    const chAge = v.channelCreatedAt ? Math.floor((Date.now() - new Date(v.channelCreatedAt).getTime()) / 86400000) : null;
    const thumbFallback = (v.url || '').match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    return {
      id: v.id,
      name: v.channelName || '',
      subs: v.subscriberCount || 0,
      views: v.viewCount || 0,
      avgScore: v.score || 0,
      ageDays: chAge,
      channelId: null,
      videoUrl: v.url || null,
      videoTitle: v.title || null,
      thumbnail: v.thumbnail || (thumbFallback ? `https://img.youtube.com/vi/${thumbFallback[1]}/hqdefault.jpg` : null),
      likeCount: v.likeCount || 0,
      commentCount: v.commentCount || 0,
      postedAt: v.postedAt,
      postedDate: v.postedDate,
      keyword: v.keyword,
      embeddedAt: 'yes',   // already in the similar set → has embedding by definition
      topComment: v.topComment,
    };
  }, [filteredSimilar]);

  const indicatorDots = useMemo(
    () => scatterDots.map(d => ({ s: d.s, v: d.v, a: d.a })),
    [scatterDots]
  );

  const subsBuckets = useMemo(() => {
    // Unique channels: take max subs per channel name so the histogram counts channels not videos
    const byChannel = new Map<string, number>();
    for (const v of filteredSimilar) {
      if (!v.channelName) continue;
      const prev = byChannel.get(v.channelName);
      byChannel.set(v.channelName, Math.max(prev || 0, v.subscriberCount || 0));
    }
    return makeSubsBuckets([...byChannel.values()]);
  }, [filteredSimilar]);

  const viewsBuckets = useMemo(
    () => makeViewsBuckets(filteredSimilar.map(v => v.viewCount || 0)),
    [filteredSimilar]
  );

  const sortedGrid = useMemo(() => {
    const arr = [...filteredSimilar];
    switch (sort) {
      case 'views':      return arr.sort((a, b) => b.viewCount - a.viewCount);
      case 'score':      return arr.sort((a, b) => b.score - a.score);
      case 'newest':     return arr.sort((a, b) => new Date(b.postedAt || 0).getTime() - new Date(a.postedAt || 0).getTime());
      case 'likes':      return arr.sort((a, b) => b.likeCount - a.likeCount);
      default:           return arr.sort((a, b) => b.similarity - a.similarity);
    }
  }, [filteredSimilar, sort]);

  if (loading) {
    return (
      <div className="px-8 py-8 max-w-7xl mx-auto space-y-6">
        <OpportunityIndicatorsSkeleton />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <DistBarsSkeleton title="Subscriber Distribution" />
          <DistBarsSkeleton title="Views Distribution" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="px-8 py-8 max-w-7xl mx-auto">
        <div className="bg-red-900/20 border border-red-800/40 rounded-xl px-5 py-4 text-red-400">
          Couldn&apos;t load similar videos: {error || 'Unknown error'}
        </div>
      </div>
    );
  }

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-5 py-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Semantic cluster</div>
            <h1 className="text-lg font-bold text-white leading-tight mb-1">
              Similar to: <span className="text-purple-400">{data.source.title}</span>
            </h1>
            <div className="flex items-center gap-3 text-xs text-[#888]">
              {data.source.keyword && (
                <Link href={`/niche/niches/${encodeURIComponent(data.source.keyword)}/videos`}
                  className="text-purple-400 hover:text-purple-300 underline-offset-2 hover:underline">
                  from &quot;{data.source.keyword}&quot;
                </Link>
              )}
              <span>· {filteredSimilar.length} of {data.similar.length} match the similarity threshold</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-[#888]">Min match:</label>
            <select
              value={minSimilarity}
              onChange={e => setMinSimilarity(parseFloat(e.target.value))}
              className="bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded px-2 py-1 focus:outline-none focus:border-amber-500"
            >
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
      </div>

      {/* Indicators — sample size aware */}
      {filteredSimilar.length >= 10 ? (
        <OpportunityIndicators dots={indicatorDots} />
      ) : (
        <div className="bg-[#141414] border border-dashed border-[#1f1f1f] rounded-xl px-5 py-4 text-[#666] text-sm">
          Need at least 10 matches to compute opportunity indicators. Lower the min match threshold or pick a video with more embedded neighbours.
        </div>
      )}

      {/* Scatter */}
      {filteredSimilar.length > 0 && <ChannelScatter dots={scatterDots} videoLookup={videoLookup} />}

      {/* Distributions */}
      {filteredSimilar.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {subsBuckets.some(b => b.count > 0) && <DistBars title="Subscriber Distribution" unit="channels" buckets={subsBuckets} />}
          {viewsBuckets.some(b => b.count > 0) && <DistBars title="Views Distribution" unit="videos" buckets={viewsBuckets} />}
        </div>
      )}

      {/* Videos grid */}
      {filteredSimilar.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <h3 className="text-sm font-medium text-white mr-2">Videos</h3>
            {([
              { value: 'similarity', label: 'Best Match' },
              { value: 'views', label: 'Most Views' },
              { value: 'score', label: 'Highest Score' },
              { value: 'newest', label: 'Newest' },
              { value: 'likes', label: 'Most Likes' },
            ] as const).map(opt => (
              <button key={opt.value} onClick={() => setSort(opt.value)}
                className={`px-3 py-1 rounded-full text-xs transition ${
                  sort === opt.value ? 'bg-white text-black font-medium' : 'text-[#888] border border-[#333] hover:border-[#555]'
                }`}>{opt.label}</button>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedGrid.map(v => {
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
                    <div className="flex items-center gap-3 text-xs text-[#666]">
                      {v.likeCount > 0 && <span>👍 {fmtYT(v.likeCount)}</span>}
                      {v.subscriberCount > 0 && <span>👥 {fmtYT(v.subscriberCount)}</span>}
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
      )}
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
