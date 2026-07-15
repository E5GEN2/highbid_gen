'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { NicheVideoCard, type NicheVideoCardData } from '@/components/NicheVideoCard';
import { ClusterTabs } from '@/components/ClusterTabs';
import { ClusterHeader } from '@/components/ClusterHeader';
import { NicheWatchButton, useFavourites } from '@/components/FavouritesProvider';

interface PopularVideo {
  videoId: number;
  title: string | null;
  thumbnail: string | null;
  url: string | null;
  viewCount: number | null;
  channelName: string | null;
  postedAt: string | null;
  postedDate: string | null;
  score: number | null;
}
interface ClusterCard {
  id: number;
  level: number;
  parentClusterId: number | null;
  autoLabel: string | null;
  label: string | null;
  videoCount: number;
  channelCount?: number;
  avgScore: number | null;
  avgViews: number | null;
  totalViews: number | null;
  topChannels: string[];
  representativeVideoId: number | null;
  repTitle: string | null;
  repThumbnail: string | null;
  repUrl: string | null;
  repViewCount: number | null;
  repChannelName: string | null;
  popularVideos: PopularVideo[];
  uploadHistogram?: number[];
  opportunity?: {
    sample: number;
    nos: number;
    nosDisplay: number;
    topLeftPct: number;
    newcomerRate: number;
    lowSubCeiling: number;
  } | null;
  childrenCount: number;
}
interface ClusterVideo {
  videoId: number;
  url: string | null;
  title: string | null;
  thumbnail: string | null;
  channelName: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  subscriberCount: number | null;
  channelCreatedAt: string | null;
  postedAt: string | null;
  postedDate: string | null;
  score: number | null;
  topComment: string | null;
  keyword: string | null;
  distanceToCentroid: number | null;
}
interface Ancestor { id: number; level: number; label: string | null; autoLabel: string | null; clusterIndex: number; }

type VideoSort = 'centroid' | 'outlier' | 'score' | 'views' | 'date' | 'oldest' | 'likes';

export default function ClusterDetailPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const clusterId = parseInt(rawId);

  const [parent, setParent] = useState<ClusterCard | null>(null);
  const [ancestors, setAncestors] = useState<Ancestor[]>([]);
  const [children, setChildren] = useState<ClusterCard[]>([]);
  const [videos, setVideos] = useState<ClusterVideo[]>([]);
  const [totalVideos, setTotalVideos] = useState(0);
  const [loading, setLoading] = useState(true);          // initial header+first-page load
  const [loadingMore, setLoadingMore] = useState(false); // subsequent infinite-scroll pages
  const [error, setError] = useState<string | null>(null);
  const [videoSort, setVideoSort] = useState<VideoSort>('centroid');
  // Page size = how many videos we fetch per scroll page. Was the
  // hard cap with no "load more" UI. Now we fetch this many at a time
  // and append on scroll until totalVideos is reached.
  const [pageSize, setPageSize] = useState(60);

  // Fresh uploads — the Niche Watcher's payoff surface. The /fresh endpoint
  // returns videos the agent discovered in this niche, flags isNew per video
  // (since the watcher's last visit), and advances the seen-watermark.
  const { isWatching, watchSlotsUsed, watchSlotsTotal } = useFavourites();
  const watching = isWatching(clusterId);
  const [freshVideos, setFreshVideos] = useState<NicheVideoCardData[]>([]);
  const [freshLoading, setFreshLoading] = useState(true);
  const [freshNewCount, setFreshNewCount] = useState(0);
  // Guard so the seen-mark fires at most once per cluster (survives React
  // strict-mode double-invoke). Depend ONLY on clusterId — NOT `watching` —
  // because isNew/watching come from the server (DB), so a single GET is
  // correct regardless of the client's hydration state, and re-firing on the
  // provider's false->true `watching` flip could read a just-advanced
  // watermark and wipe the NEW badges.
  const seenMarkedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!clusterId) return;
    setFreshLoading(true);
    fetch(`/api/niche-spy/tree-clusters/${clusterId}/fresh`)
      .then(r => r.json())
      .then(d => {
        setFreshVideos((d.videos || []) as NicheVideoCardData[]);
        setFreshNewCount(d.newCount || 0);
        // Mark seen ONCE per cluster, after we have the data — a separate
        // idempotent POST so the GET stays a pure read (no self-wipe on refetch).
        if (d.watching && d.cursor && seenMarkedRef.current !== clusterId) {
          seenMarkedRef.current = clusterId;
          fetch(`/api/niche-spy/tree-clusters/${clusterId}/fresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cursor: d.cursor }),
          }).catch(() => {});
        }
      })
      .catch(() => setFreshVideos([]))
      .finally(() => setFreshLoading(false));
  }, [clusterId]);

  // First page (resets when clusterId / sort / pageSize change).
  useEffect(() => {
    if (!clusterId) return;
    setLoading(true);
    setError(null);
    setVideos([]);
    const qs = new URLSearchParams({
      videoSort,
      videoLimit: String(pageSize),
      videoOffset: '0',
    });
    fetch(`/api/niche-spy/tree-clusters/${clusterId}?${qs}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setParent(d.parent || null);
        setAncestors(d.ancestors || []);
        setChildren(d.children || []);
        setVideos(d.videos || []);
        setTotalVideos(d.totalVideos || 0);
      })
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [clusterId, videoSort, pageSize]);

  // Load the next page of videos. Called when the sentinel scrolls into
  // view (or as a manual "Load more" fallback). No-ops if already loading,
  // if the initial fetch hasn't completed, or if we've fetched everything.
  const loadMore = useCallback(async () => {
    if (!clusterId || loading || loadingMore) return;
    if (videos.length >= totalVideos) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams({
        videoSort,
        videoLimit: String(pageSize),
        videoOffset: String(videos.length),
        skipChildren: '1',
      });
      const r = await fetch(`/api/niche-spy/tree-clusters/${clusterId}?${qs}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setVideos(prev => [...prev, ...(d.videos || [])]);
      // Refresh total in case the cluster grew between paginations
      if (typeof d.totalVideos === 'number') setTotalVideos(d.totalVideos);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [clusterId, loading, loadingMore, videos.length, totalVideos, videoSort, pageSize]);

  // IntersectionObserver — triggers loadMore when the sentinel comes
  // within 600px of the viewport. Ref re-created when loadMore changes
  // so it always closes over fresh state.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore]);

  const breadcrumbItems = useMemo(() => {
    const items: Ancestor[] = [...ancestors].reverse();
    return items;
  }, [ancestors]);
  void breadcrumbItems;   // kept for backward-compat references; ClusterHeader owns rendering now

  if (!clusterId) return <div className="px-8 py-8 text-red-400">Invalid cluster id</div>;

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <ClusterHeader
        parent={parent}
        ancestors={ancestors}
        childrenCount={children.length}
        loading={loading}
        error={error}
      />

      <ClusterTabs clusterId={clusterId} active="videos" childrenCount={children.length} />

      {/* Fresh uploads — Niche Watcher payoff. Videos the agent discovered in
          this niche; NEW-badged for watchers since their last visit. Shown to
          everyone (a preview of the watcher's value); NEW highlights + tracking
          are the watch perk. */}
      <div className="mb-8 bg-gradient-to-br from-cyan-500/[0.04] to-transparent border border-cyan-500/20 rounded-xl p-4">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
              <span className="text-cyan-400 text-base leading-none">◉</span> Fresh uploads
            </h2>
            {freshNewCount > 0 && (
              <span className="text-[10px] font-bold bg-emerald-500 text-black rounded-full px-2 py-0.5">{freshNewCount} NEW</span>
            )}
            <span className="text-[11px] text-[#666]">
              {watching ? `Watching · ${watchSlotsUsed}/${watchSlotsTotal} slots` : 'discovered by the niche agent'}
            </span>
          </div>
          <NicheWatchButton clusterId={clusterId} />
        </div>

        {freshLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden animate-pulse">
                <div className="aspect-video bg-[#1a1a1a]" />
                <div className="p-3 space-y-2"><div className="h-3 w-3/4 bg-[#1f1f1f] rounded" /></div>
              </div>
            ))}
          </div>
        ) : freshVideos.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {freshVideos.map(v => <NicheVideoCard key={v.id} video={v} />)}
          </div>
        ) : (
          <div className="text-sm text-[#888] py-4 text-center">
            {watching
              ? 'The agent is watching this niche. New uploads from its channels will appear here as they’re discovered — check back soon.'
              : 'Watch this niche to have the agent pulse its channels and highlight new uploads here the moment they appear.'}
          </div>
        )}
      </div>

      {/* Videos in this cluster */}
      <div>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h2 className="text-sm font-medium text-white">
            Videos ({videos.length} of {totalVideos})
          </h2>
          <div className="flex items-center gap-2">
            <label className="text-xs text-[#888]">Sort:</label>
            <select
              value={videoSort}
              onChange={e => setVideoSort(e.target.value as VideoSort)}
              className="bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded px-2 py-1 focus:outline-none focus:border-amber-500"
            >
              <option value="centroid">Most central</option>
              <option value="outlier">Most outlier</option>
              <option value="score">Highest score</option>
              <option value="views">Most views</option>
              <option value="likes">Most likes</option>
              <option value="date">Newest</option>
              <option value="oldest">Oldest</option>
            </select>
            <label className="text-xs text-[#888] ml-2">Page size:</label>
            <select
              value={pageSize}
              onChange={e => setPageSize(parseInt(e.target.value))}
              className="bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded px-2 py-1 focus:outline-none focus:border-amber-500"
            >
              <option value={30}>30</option>
              <option value={60}>60</option>
              <option value={120}>120</option>
              <option value={200}>200</option>
            </select>
            {totalVideos > 0 && (
              <span className="text-xs text-[#666] ml-1">
                {videos.length} / {totalVideos.toLocaleString()}
              </span>
            )}
          </div>
        </div>

        {loading && videos.length === 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden animate-pulse">
                <div className="aspect-video bg-[#1a1a1a]" />
                <div className="p-3 space-y-2">
                  <div className="h-4 w-3/4 bg-[#1f1f1f] rounded" />
                  <div className="h-3 w-1/2 bg-[#1f1f1f] rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : videos.length === 0 ? (
          <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#888]">
            No videos in this cluster.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {videos.map(v => (
                <NicheVideoCard
                  key={v.videoId}
                  video={clusterVideoToCard(v)}
                />
              ))}
            </div>
            {/* Infinite-scroll sentinel — observed by IntersectionObserver
                in the page effect; loads the next page when scrolled into
                view. Manual "Load more" link is a fallback for users who
                navigate via keyboard or screen reader. */}
            <div ref={sentinelRef} aria-hidden="true" />
            {videos.length < totalVideos && (
              <div className="flex justify-center mt-6">
                {loadingMore ? (
                  <div className="text-xs text-[#666]">Loading more…</div>
                ) : (
                  <button
                    onClick={() => loadMore()}
                    className="text-xs text-[#888] hover:text-white border border-[#1f1f1f] hover:border-[#333] rounded px-3 py-1.5 transition"
                  >
                    Load more ({(totalVideos - videos.length).toLocaleString()} remaining)
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function clusterVideoToCard(v: ClusterVideo): NicheVideoCardData {
  return {
    id: v.videoId,
    url: v.url,
    title: v.title,
    thumbnail: v.thumbnail,
    channelName: v.channelName,
    viewCount: v.viewCount,
    likeCount: v.likeCount,
    subscriberCount: v.subscriberCount,
    channelCreatedAt: v.channelCreatedAt,
    firstUploadAt: null,
    dormancyDays: null,
    postedAt: v.postedAt,
    postedDate: v.postedDate,
    score: v.score,
    distanceToCentroid: v.distanceToCentroid,
  };
}
