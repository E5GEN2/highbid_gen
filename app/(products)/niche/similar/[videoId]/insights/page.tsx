'use client';

import React, { useCallback, useMemo } from 'react';
import { useSimilar } from '@/components/SimilarProvider';
import { OpportunityIndicators, OpportunityIndicatorsSkeleton } from '@/components/OpportunityIndicators';
import { ChannelScatter, type ScatterDot, type ScatterVideo } from '@/components/ChannelScatter';
import { DistBars, DistBarsSkeleton, makeSubsBuckets, makeViewsBuckets } from '@/components/DistBars';

/**
 * Similar-cluster Insights tab — same indicators/scatter/distributions layout
 * as the keyword Insights page, but computed over the set of semantically
 * similar videos filtered by the min-match selector in the layout header.
 */
export default function SimilarInsights() {
  const { filtered, loading, error } = useSimilar();

  // Build ScatterDot shape from the filtered similar videos
  const scatterDots: ScatterDot[] = useMemo(() => filtered.map(v => {
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
  }), [filtered]);

  const indicatorDots = useMemo(
    () => scatterDots.map(d => ({ s: d.s, v: d.v, a: d.a })),
    [scatterDots]
  );

  // Synchronous lookup for the scatter's hover card — we already have all the data
  const videoLookup = useCallback((id: number): ScatterVideo | null => {
    const v = filtered.find(x => x.id === id);
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
      embeddedAt: 'yes',
      topComment: v.topComment,
    };
  }, [filtered]);

  // Unique channels for subs histogram — max subs per channel name
  const subsBuckets = useMemo(() => {
    const byChannel = new Map<string, number>();
    for (const v of filtered) {
      if (!v.channelName) continue;
      const prev = byChannel.get(v.channelName);
      byChannel.set(v.channelName, Math.max(prev || 0, v.subscriberCount || 0));
    }
    return makeSubsBuckets([...byChannel.values()]);
  }, [filtered]);

  const viewsBuckets = useMemo(
    () => makeViewsBuckets(filtered.map(v => v.viewCount || 0)),
    [filtered]
  );

  if (loading) {
    return (
      <div className="px-8 pb-8 max-w-7xl mx-auto space-y-6">
        <OpportunityIndicatorsSkeleton />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <DistBarsSkeleton title="Subscriber Distribution" />
          <DistBarsSkeleton title="Views Distribution" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-8 pb-8 max-w-7xl mx-auto">
        <div className="bg-red-900/20 border border-red-800/40 rounded-xl px-5 py-4 text-red-400">
          Couldn&apos;t load insights: {error}
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="px-8 pb-8 max-w-7xl mx-auto">
        <div className="bg-[#141414] border border-dashed border-[#1f1f1f] rounded-xl px-5 py-8 text-center text-[#666]">
          No matches at the current threshold. Lower the min match from the header to see insights.
        </div>
      </div>
    );
  }

  return (
    <div className="px-8 pb-8 max-w-7xl mx-auto space-y-6">
      {filtered.length >= 10 ? (
        <OpportunityIndicators dots={indicatorDots} />
      ) : (
        <div className="bg-[#141414] border border-dashed border-[#1f1f1f] rounded-xl px-5 py-4 text-[#666] text-sm">
          Need at least 10 matches to compute opportunity indicators — lower the min match or pick a video with more embedded neighbours.
        </div>
      )}

      <ChannelScatter dots={scatterDots} videoLookup={videoLookup} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {subsBuckets.some(b => b.count > 0) && <DistBars title="Subscriber Distribution" unit="channels" buckets={subsBuckets} />}
        {viewsBuckets.some(b => b.count > 0) && <DistBars title="Views Distribution" unit="videos" buckets={viewsBuckets} />}
      </div>
    </div>
  );
}
