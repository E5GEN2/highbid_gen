'use client';

/**
 * /niche/cluster/[id]/channels
 *
 * Channels list scoped to one cluster's videos. Same NicheChannelCard
 * styling as the global /niche/channels page, just aggregated from
 * niche_tree_assignments WHERE cluster_id = X instead of by keyword.
 *
 * Filters are intentionally stripped down vs the global page — a
 * single cluster is already a tight scope, so the age / subs / views
 * dropdowns add noise. Sort + Load-More is enough here.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import { fmtYT } from '@/lib/format';
import { NicheChannelCard, type ChannelCardData } from '@/components/NicheChannelCard';
import { ClusterTabs } from '@/components/ClusterTabs';
import { ClusterHeader, type ClusterHeaderParent, type ClusterHeaderAncestor } from '@/components/ClusterHeader';

type Sort = 'views' | 'videos' | 'subs' | 'newest' | 'score';
const PAGE_SIZE = 60;

export default function ClusterChannelsPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const clusterId = parseInt(rawId);

  const [parent, setParent] = useState<ClusterHeaderParent | null>(null);
  const [ancestors, setAncestors] = useState<ClusterHeaderAncestor[]>([]);
  const [childrenCount, setChildrenCount] = useState<number | undefined>(undefined);
  const [headerLoading, setHeaderLoading] = useState(true);
  const [headerError, setHeaderError] = useState<string | null>(null);

  const [channels, setChannels] = useState<ChannelCardData[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<{
    totalChannels: number; newChannels: number; veryNewChannels: number; establishedChannels: number;
    newAvgSubs: number; estAvgSubs: number;
  } | null>(null);
  const [sort, setSort] = useState<Sort>('views');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Header data (parent + ancestors + children count).
  useEffect(() => {
    if (!clusterId) return;
    setHeaderLoading(true);
    fetch(`/api/niche-spy/tree-clusters/${clusterId}?videoLimit=1`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setParent(d.parent || null);
        setAncestors(d.ancestors || []);
        setChildrenCount((d.children || []).length);
      })
      .catch(err => setHeaderError((err as Error).message))
      .finally(() => setHeaderLoading(false));
  }, [clusterId]);

  // Channels — fetches first page when sort changes, loadMore appends.
  const fetchChannels = useCallback(async (offset: number) => {
    if (!clusterId) return;
    const isFirst = offset === 0;
    if (isFirst) setLoading(true);
    else setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        sort, limit: String(PAGE_SIZE), offset: String(offset),
      });
      const r = await fetch(`/api/niche-spy/tree-clusters/${clusterId}/channels?${params}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      if (isFirst) setChannels(d.channels || []);
      else setChannels(prev => [...prev, ...(d.channels || [])]);
      setTotal(d.total || 0);
      setStats(d.stats || null);
    } catch (err) {
      console.error('Channel fetch error:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [clusterId, sort]);

  useEffect(() => { fetchChannels(0); }, [fetchChannels]);

  // Infinite scroll sentinel — same pattern as the Videos tab.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting && !loading && !loadingMore && channels.length < total) {
          fetchChannels(channels.length);
        }
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchChannels, channels.length, total, loading, loadingMore]);

  if (!clusterId) return <div className="px-8 py-8 text-red-400">Invalid cluster id</div>;

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <ClusterHeader
        parent={parent}
        ancestors={ancestors}
        childrenCount={childrenCount}
        loading={headerLoading}
        error={headerError}
      />

      <ClusterTabs clusterId={clusterId} active="channels" childrenCount={childrenCount} />

      {/* Sort pills */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-2 flex-wrap flex-1">
            {[
              { value: 'views',  label: 'Total Views' },
              { value: 'videos', label: 'Video Count' },
              { value: 'subs',   label: 'Subscribers' },
              { value: 'newest', label: 'Newest' },
              { value: 'score',  label: 'Avg Score' },
            ].map(opt => (
              <button
                key={opt.value}
                onClick={() => setSort(opt.value as Sort)}
                className={`px-4 py-1.5 rounded-full text-sm transition ${
                  sort === opt.value
                    ? 'bg-white text-black font-medium'
                    : 'text-[#888] border border-[#333] hover:border-[#555]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="text-sm font-medium text-white">
            {total.toLocaleString()} channel{total === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {/* Stats summary */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
          {[
            { label: 'Total',         value: stats.totalChannels.toLocaleString(),  color: 'text-white' },
            { label: '<30 days',      value: stats.veryNewChannels.toLocaleString(), color: 'text-orange-400' },
            { label: '<6 months',     value: stats.newChannels.toLocaleString(),     color: 'text-green-400' },
            { label: 'Established',   value: stats.establishedChannels.toLocaleString(), color: 'text-[#888]' },
            { label: 'New Avg Subs',  value: fmtYT(stats.newAvgSubs),                 color: 'text-green-400' },
            { label: 'Est Avg Subs',  value: fmtYT(stats.estAvgSubs),                 color: 'text-[#888]' },
          ].map((s, i) => (
            <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-3 text-center">
              <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-[#666]">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Cards */}
      {loading && channels.length === 0 ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl h-40 animate-pulse" />
          ))}
        </div>
      ) : channels.length === 0 ? (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#888]">
          No channels in this cluster yet.
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {channels.map(ch => (
              <NicheChannelCard key={`${ch.channelId || ch.channelName}`} channel={ch} />
            ))}
          </div>
          <div ref={sentinelRef} aria-hidden="true" />
          {channels.length < total && (
            <div className="flex justify-center mt-6">
              {loadingMore ? (
                <div className="text-xs text-[#666]">Loading more…</div>
              ) : (
                <button
                  onClick={() => fetchChannels(channels.length)}
                  className="text-xs text-[#888] hover:text-white border border-[#1f1f1f] hover:border-[#333] rounded px-3 py-1.5 transition"
                >
                  Load more ({(total - channels.length).toLocaleString()} remaining)
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
