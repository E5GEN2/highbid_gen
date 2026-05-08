'use client';

/**
 * /niche/cluster/[id]/insights
 *
 * Same chart panel that lived under the per-keyword Insights tab,
 * scoped to the new tree-clusters via treeClusterId. Reuses every
 * existing component (OpportunityIndicators / ChannelScatter /
 * DistBars / NicheTimeline) — only the data scope differs.
 *
 * Saturation + new-vs-established channels stats from the keyword
 * version are dropped because they're scrape-run scoped (saturation
 * tracks redundancy of a keyword scrape) and don't apply to an
 * embedding-derived cluster.
 */

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { fmtYT } from '@/lib/format';
import { ClusterTabs } from '@/components/ClusterTabs';
import NicheTimeline from '@/components/NicheTimeline';
import { OpportunityIndicators, OpportunityIndicatorsSkeleton } from '@/components/OpportunityIndicators';
import { ChannelScatter, type ScatterDot } from '@/components/ChannelScatter';
import { DistBars, DistBarsSkeleton, type DistBucket } from '@/components/DistBars';

interface Ancestor { id: number; level: number; label: string | null; autoLabel: string | null; clusterIndex: number; }
interface ParentCluster {
  id: number; level: number; videoCount: number; avgScore: number | null;
  totalViews: number | null; avgViews: number | null; topChannels: string[];
  label: string | null; autoLabel: string | null;
}

export default function ClusterInsightsPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const clusterId = parseInt(rawId);

  const [parent, setParent] = useState<ParentCluster | null>(null);
  const [ancestors, setAncestors] = useState<Ancestor[]>([]);
  const [parentLoading, setParentLoading] = useState(true);
  const [parentError, setParentError] = useState<string | null>(null);

  const [minScore, setMinScore] = useState<number>(80);

  const [subsDist, setSubsDist] = useState<DistBucket[]>([]);
  const [viewsDist, setViewsDist] = useState<DistBucket[]>([]);
  const [scatter, setScatter] = useState<ScatterDot[]>([]);
  const [distLoading, setDistLoading] = useState(true);

  // Pull cluster header (ancestors + label + counts).
  useEffect(() => {
    if (!clusterId) return;
    setParentLoading(true);
    fetch(`/api/niche-spy/tree-clusters/${clusterId}?videoLimit=1`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setParent(d.parent || null);
        setAncestors(d.ancestors || []);
      })
      .catch(err => setParentError((err as Error).message))
      .finally(() => setParentLoading(false));
  }, [clusterId]);

  // Pull distribution + scatter via the existing endpoint with
  // treeClusterId branch.
  useEffect(() => {
    if (!clusterId) return;
    setDistLoading(true);
    fetch(`/api/niche-spy/distribution?treeClusterId=${clusterId}&minScore=${minScore}`)
      .then(r => r.json())
      .then(d => {
        if (d.subsDist)  setSubsDist(d.subsDist);
        if (d.viewsDist) setViewsDist(d.viewsDist);
        if (d.scatter)   setScatter(d.scatter);
      })
      .catch(() => {})
      .finally(() => setDistLoading(false));
  }, [clusterId, minScore]);

  const breadcrumbItems = useMemo(() => [...ancestors].reverse(), [ancestors]);

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

      {/* Ancestors */}
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

      {/* Cluster header — same shape as detail page but read-only here. */}
      {parentLoading && !parent ? (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-6 mb-6 animate-pulse">
          <div className="h-6 w-72 bg-[#1f1f1f] rounded mb-3" />
          <div className="h-4 w-48 bg-[#1f1f1f] rounded" />
        </div>
      ) : parentError ? (
        <div className="bg-[#141414] border border-red-500/30 rounded-xl p-6 mb-6 text-sm text-red-400">
          Failed to load cluster: {parentError}
        </div>
      ) : parent ? (
        <div className="mb-6">
          <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">
            L{parent.level} cluster · {parent.videoCount} videos
          </div>
          <h1 className="text-2xl font-bold text-white leading-tight mb-2">
            {parent.label || parent.autoLabel || `Cluster ${parent.id}`}
          </h1>
          <div className="flex items-center gap-4 flex-wrap text-xs text-[#888]">
            <span><span className="text-green-400">{fmtYT(parent.totalViews ?? 0)}</span> total views</span>
            <span><span className="text-blue-400">{fmtYT(parent.avgViews ?? 0)}</span> avg / video</span>
            <span>⚡ <span className="text-white">{parent.avgScore ?? 0}</span> avg score</span>
          </div>
        </div>
      ) : null}

      <ClusterTabs clusterId={clusterId} active="insights" />

      {/* Min-score filter — opportunity math is more meaningful at
          score ≥ 80 (the high-performers), but operators may want to
          look at the whole cluster too. */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-3 mb-4 flex items-center gap-3 flex-wrap">
        <span className="text-xs text-[#888]">Filter videos at min score:</span>
        <div className="flex gap-2 flex-wrap">
          {[0, 50, 70, 80, 90].map(s => (
            <button
              key={s}
              onClick={() => setMinScore(s)}
              className={`px-3 py-1 rounded-full text-xs transition ${
                minScore === s
                  ? 'bg-white text-black font-medium'
                  : 'text-[#888] border border-[#333] hover:border-[#555]'
              }`}
            >
              {s === 0 ? 'Any' : `${s}+`}
            </button>
          ))}
        </div>
        <span className="text-xs text-[#666]">{scatter.length} videos with subs + views data</span>
      </div>

      <div className="space-y-6">
        {/* Opportunity indicators */}
        {distLoading ? (
          <OpportunityIndicatorsSkeleton />
        ) : scatter.length > 0 ? (
          <OpportunityIndicators dots={scatter.map(d => ({ s: d.s, v: d.v, a: d.a }))} />
        ) : (
          <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-6 text-center text-sm text-[#888]">
            Not enough enriched videos at min score {minScore}+ to compute indicators.
          </div>
        )}

        {/* Channel landscape */}
        {distLoading ? (
          <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-5 py-4 animate-pulse">
            <div className="h-4 w-32 bg-[#1f1f1f] rounded mb-4" />
            <div className="h-64 bg-[#1f1f1f] rounded" />
          </div>
        ) : scatter.length > 0 ? (
          <ChannelScatter dots={scatter} />
        ) : null}

        {/* Distribution charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {distLoading ? (
            <>
              <DistBarsSkeleton title="Subscriber Distribution" />
              <DistBarsSkeleton title="Views Distribution" />
            </>
          ) : (
            <>
              {subsDist.some(b => b.count > 0) && <DistBars title="Subscriber Distribution" unit="channels" buckets={subsDist} />}
              {viewsDist.some(b => b.count > 0) && <DistBars title="Views Distribution" unit="videos" buckets={viewsDist} />}
            </>
          )}
        </div>

        {/* Timeline — uploads over time, scoped to this cluster. */}
        <NicheTimeline treeClusterId={clusterId} minScore={minScore} maxScore={100} />
      </div>
    </div>
  );
}
