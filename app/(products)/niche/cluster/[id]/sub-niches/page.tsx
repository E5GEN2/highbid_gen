'use client';

/**
 * /niche/cluster/[id]/sub-niches
 *
 * Lists the L2 children of an L1 cluster (or the L3-equivalent
 * children of an L2, if/when we go deeper). Same wide-row
 * NicheClusterCard the home grid uses.
 *
 * Reaches into /api/niche-spy/tree-clusters/[id] to get both the
 * parent header info and the children array. videoLimit=1 keeps the
 * payload small — we don't render videos here.
 */

import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { NicheClusterCard, type ClusterCardData } from '@/components/NicheClusterCard';
import { ClusterTabs } from '@/components/ClusterTabs';
import { ClusterHeader, type ClusterHeaderParent, type ClusterHeaderAncestor } from '@/components/ClusterHeader';

export default function ClusterSubNichesPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const clusterId = parseInt(rawId);

  const [parent, setParent] = useState<ClusterHeaderParent | null>(null);
  const [ancestors, setAncestors] = useState<ClusterHeaderAncestor[]>([]);
  const [children, setChildren] = useState<ClusterCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clusterId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/niche-spy/tree-clusters/${clusterId}?videoLimit=1`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setParent(d.parent || null);
        setAncestors(d.ancestors || []);
        setChildren(d.children || []);
      })
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [clusterId]);

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

      <ClusterTabs clusterId={clusterId} active="sub-niches" childrenCount={children.length} />

      {loading && children.length === 0 ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl h-32 animate-pulse" />
          ))}
        </div>
      ) : children.length === 0 ? (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#888]">
          No sub-niches under this cluster.
          {parent?.level === 2 && (
            <div className="text-xs text-[#666] mt-2">
              L2 clusters are the deepest layer in the current tree — go up to the parent L1 to see siblings.
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-[#666] mb-1">
            {children.length} sub-niche{children.length === 1 ? '' : 's'}
          </div>
          {children.map(c => <NicheClusterCard key={c.id} cluster={c} />)}
        </div>
      )}
    </div>
  );
}
