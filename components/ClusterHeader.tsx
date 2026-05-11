'use client';

import React from 'react';
import Link from 'next/link';
import { fmtYT } from '@/lib/format';

export interface ClusterHeaderParent {
  id: number;
  level: number;
  videoCount: number;
  avgScore: number | null;
  totalViews: number | null;
  avgViews: number | null;
  topChannels: string[];
  label: string | null;
  autoLabel: string | null;
  aiLabel?: string | null;
}

export interface ClusterHeaderAncestor {
  id: number;
  level: number;
  label: string | null;
  autoLabel: string | null;
  clusterIndex: number;
}

/**
 * Back link + ancestor breadcrumb + cluster header card.
 * Shared across all /niche/cluster/[id]/* sub-pages so the chrome
 * stays consistent and we don't duplicate the markup four times.
 *
 * `loading` and `error` are handled here so each page only needs to
 * decide what to show below the header. childrenCount is rendered in
 * the sub-niche counter; pass undefined to hide it.
 */
export function ClusterHeader({
  parent,
  ancestors,
  childrenCount,
  loading,
  error,
}: {
  parent: ClusterHeaderParent | null;
  ancestors: ClusterHeaderAncestor[];
  childrenCount?: number;
  loading: boolean;
  error: string | null;
}) {
  const breadcrumb = [...ancestors].reverse();

  return (
    <>
      <Link
        href="/niche/niches"
        className="inline-flex items-center gap-1.5 text-xs text-[#888] hover:text-white transition mb-3"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to niches
      </Link>

      {breadcrumb.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-[#666] mb-3 flex-wrap">
          {breadcrumb.map((a, i) => (
            <React.Fragment key={a.id}>
              <Link href={`/niche/cluster/${a.id}`} className="hover:text-amber-400 transition">
                L{a.level}: {a.label || a.autoLabel || `Cluster ${a.id}`}
              </Link>
              {i < breadcrumb.length - 1 && <span className="text-[#444]">›</span>}
            </React.Fragment>
          ))}
        </div>
      )}

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
            L{parent.level} cluster · {parent.videoCount.toLocaleString()} videos
            {childrenCount !== undefined && (
              <> · {childrenCount} sub-niche{childrenCount === 1 ? '' : 's'}</>
            )}
          </div>
          <h1 className="text-2xl font-bold text-white leading-tight mb-2">
            {parent.label || parent.aiLabel || parent.autoLabel || `Cluster ${parent.id}`}
          </h1>
          <div className="flex items-center gap-4 flex-wrap text-xs text-[#888]">
            <span>
              <span className="text-green-400">{fmtYT(parent.totalViews ?? 0)}</span> total views
            </span>
            <span>
              <span className="text-blue-400">{fmtYT(parent.avgViews ?? 0)}</span> avg / video
            </span>
            <span>
              ⚡ <span className="text-white">{parent.avgScore ?? 0}</span> avg score
            </span>
            {parent.topChannels.length > 0 && (
              <span className="truncate" title={parent.topChannels.join(' · ')}>
                top: {parent.topChannels.slice(0, 3).join(' · ')}
              </span>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
