'use client';

import React from 'react';
import Link from 'next/link';

/**
 * Detail / Insights pill toggle for /niche/cluster/[id] pages.
 * Mirrors the per-keyword Videos / Channels / Insights tabs that
 * lived in the keyword-niche product, just scoped to the new
 * tree-clusters surface.
 */
export function ClusterTabs({ clusterId, active }: { clusterId: number; active: 'detail' | 'insights' }) {
  const tabs: Array<{ key: 'detail' | 'insights'; label: string; href: string }> = [
    { key: 'detail',   label: 'Detail',   href: `/niche/cluster/${clusterId}` },
    { key: 'insights', label: 'Insights', href: `/niche/cluster/${clusterId}/insights` },
  ];
  return (
    <div className="flex gap-2 mb-6">
      {tabs.map(t => (
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
