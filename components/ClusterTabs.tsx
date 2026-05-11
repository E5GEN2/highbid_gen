'use client';

import React from 'react';
import Link from 'next/link';

export type ClusterTab = 'videos' | 'sub-niches' | 'channels' | 'insights';

/**
 * Pill toggle row for /niche/cluster/[id] sub-pages.
 *
 * Videos is the default landing (path = /niche/cluster/[id]) so users
 * who follow links from niche grids / search results land on the
 * thing they came to look at. Insights stays last to match the global
 * niche page pattern.
 *
 * Sub-niches is hidden when childrenCount===0 (a leaf L2 cluster
 * with no further subdivision wouldn't have anything to show there).
 */
export function ClusterTabs({
  clusterId,
  active,
  childrenCount,
}: {
  clusterId: number;
  active: ClusterTab;
  /** Hide the Sub-niches tab when this is 0 — leaf L2 clusters have
   *  no further subdivision so the tab would render an empty page. */
  childrenCount?: number;
}) {
  const tabs: Array<{ key: ClusterTab; label: string; href: string; hidden?: boolean }> = [
    { key: 'videos',     label: 'Videos',     href: `/niche/cluster/${clusterId}` },
    {
      key: 'sub-niches', label: 'Sub-niches',
      href: `/niche/cluster/${clusterId}/sub-niches`,
      hidden: childrenCount !== undefined && childrenCount === 0,
    },
    { key: 'channels',   label: 'Channels',   href: `/niche/cluster/${clusterId}/channels` },
    { key: 'insights',   label: 'Insights',   href: `/niche/cluster/${clusterId}/insights` },
  ];
  return (
    <div className="flex gap-2 mb-6 flex-wrap">
      {tabs.filter(t => !t.hidden).map(t => (
        <Link
          key={t.key}
          href={t.href}
          className={`px-4 py-1.5 rounded-full text-sm transition ${
            active === t.key
              ? 'bg-white text-black font-medium'
              : 'text-[#888] border border-[#333] hover:border-[#555]'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
