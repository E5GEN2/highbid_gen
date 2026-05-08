'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { fmtYT } from '@/lib/format';
import { NicheClusterCard } from '@/components/NicheClusterCard';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [videoSort, setVideoSort] = useState<VideoSort>('centroid');
  const [videoLimit, setVideoLimit] = useState(60);

  useEffect(() => {
    if (!clusterId) return;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ videoSort, videoLimit: String(videoLimit) });
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
  }, [clusterId, videoSort, videoLimit]);

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
            <label className="text-xs text-[#888] ml-2">Show:</label>
            <select
              value={videoLimit}
              onChange={e => setVideoLimit(parseInt(e.target.value))}
              className="bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded px-2 py-1 focus:outline-none focus:border-amber-500"
            >
              <option value={30}>30</option>
              <option value={60}>60</option>
              <option value={120}>120</option>
              <option value={200}>200</option>
            </select>
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {videos.map(v => <VideoCard key={v.videoId} video={v} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function VideoCard({ video: v }: { video: ClusterVideo }) {
  const score = v.score ?? 0;
  const scoreBand = score >= 80 ? 'bg-green-500 text-white' :
                    score >= 50 ? 'bg-yellow-500 text-black' :
                                  'bg-red-500 text-white';
  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden hover:border-[#333] transition">
      <div className="relative aspect-video bg-[#0a0a0a]">
        {v.thumbnail && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={v.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
        )}
        <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${scoreBand}`}>⚡ {score}</div>
        {v.distanceToCentroid != null && (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-bold bg-black/70 text-white border border-white/10">
            d={v.distanceToCentroid.toFixed(2)}
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title || '(no title)'}</h3>
        <div className="flex items-center gap-2 text-xs text-[#888] mb-1.5">
          <span className="text-green-400">{fmtYT(v.viewCount ?? 0)} views</span>
          {v.channelName && <span>· {v.channelName}</span>}
        </div>
        <div className="flex items-center gap-3 text-xs text-[#666] mb-2">
          {(v.likeCount ?? 0) > 0    && <span>👍 {fmtYT(v.likeCount ?? 0)}</span>}
          {(v.commentCount ?? 0) > 0 && <span>💬 {fmtYT(v.commentCount ?? 0)}</span>}
          {(v.subscriberCount ?? 0) > 0 && <span>👥 {fmtYT(v.subscriberCount ?? 0)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          {v.url && (
            <a href={v.url} target="_blank" rel="noopener noreferrer"
               className="text-[10px] text-blue-400 truncate min-w-0 flex-1">{v.url}</a>
          )}
          <Link href={`/niche/similar/${v.videoId}`}
                className="flex-shrink-0 text-[10px] bg-green-600/20 text-green-400 border border-green-600/40 px-2 py-0.5 rounded-full hover:bg-green-600/30 transition font-medium">
            Similar
          </Link>
        </div>
      </div>
    </div>
  );
}
