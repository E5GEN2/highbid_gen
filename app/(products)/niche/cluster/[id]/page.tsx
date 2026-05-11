'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { fmtYT } from '@/lib/format';
import { NicheClusterCard } from '@/components/NicheClusterCard';
import { NicheVideoCard, type NicheVideoCardData } from '@/components/NicheVideoCard';
import { ClusterTabs } from '@/components/ClusterTabs';

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

  if (!clusterId) return <div className="px-8 py-8 text-red-400">Invalid cluster id</div>;

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Back link */}
      <Link href="/niche/niches" className="inline-flex items-center gap-1.5 text-xs text-[#888] hover:text-white transition mb-3">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to niches
      </Link>

      {/* Ancestor chain — clickable so users can step back up the tree */}
      {breadcrumbItems.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-[#666] mb-3 flex-wrap">
          {breadcrumbItems.map((a, i) => (
            <React.Fragment key={a.id}>
              <Link href={`/niche/cluster/${a.id}`} className="hover:text-amber-400 transition">
                L{a.level}: {a.label || a.autoLabel || `Cluster ${a.id}`}
              </Link>
              {i < breadcrumbItems.length - 1 && <span className="text-[#444]">›</span>}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Cluster header */}
      {loading && !parent ? (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-6 mb-6 animate-pulse">
          <div className="h-6 w-72 bg-[#1f1f1f] rounded mb-3" />
          <div className="h-4 w-48 bg-[#1f1f1f] rounded" />
        </div>
      ) : error ? (
        <div className="bg-[#141414] border border-red-500/30 rounded-xl p-6 mb-6 text-sm text-red-400">
          Failed to load cluster: {error}
        </div>
      ) : parent ? (
        <div className="mb-6">
          <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">
            L{parent.level} cluster · {parent.videoCount} videos · {children.length} sub-niche{children.length === 1 ? '' : 's'}
          </div>
          <h1 className="text-2xl font-bold text-white leading-tight mb-2">
            {parent.label || parent.autoLabel || `Cluster ${parent.id}`}
          </h1>
          <div className="flex items-center gap-4 flex-wrap text-xs text-[#888]">
            <span><span className="text-green-400">{fmtYT(parent.totalViews ?? 0)}</span> total views</span>
            <span><span className="text-blue-400">{fmtYT(parent.avgViews ?? 0)}</span> avg / video</span>
            <span>⚡ <span className="text-white">{parent.avgScore ?? 0}</span> avg score</span>
            {parent.topChannels.length > 0 && (
              <span className="truncate" title={parent.topChannels.join(' · ')}>
                top: {parent.topChannels.slice(0, 3).join(' · ')}
              </span>
            )}
          </div>
        </div>
      ) : null}

      <ClusterTabs clusterId={clusterId} active="detail" />

      {/* L2 children — same wide-row card as the home grid */}
      {children.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-medium text-white mb-3">Sub-niches ({children.length})</h2>
          <div className="space-y-3">
            {children.map(c => <NicheClusterCard key={c.id} cluster={c} />)}
          </div>
        </div>
      )}

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
