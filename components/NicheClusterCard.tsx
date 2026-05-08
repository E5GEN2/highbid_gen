'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { fmtYT } from '@/lib/format';

/**
 * Wide-row cluster card — mirrors the admin Niche Tree layout. Picked
 * over the dense thumbnail-collage grid because TF-IDF labels alone
 * are too thin to convey the niche; users need to see real video
 * titles and recognisable thumbnails to grok what's inside a cluster.
 *
 * Layout, top-to-bottom:
 *   • Header strip: video count + cluster# + sub-niche badge + top channels + score
 *   • 4-tile stats row (avg views / top channels / total views / videos)
 *   • 4-tile "most representative videos" strip — thumb + title + view count
 *     - Hover scales each tile to 1.45× so the title becomes legible
 *     - Tiles are real anchor links; clicking opens the YT video, not the cluster
 *   • Whole row links to /niche/cluster/[id] except for the inner anchors
 */

export interface ClusterCardPopularVideo {
  videoId: number;
  title: string | null;
  thumbnail: string | null;
  url: string | null;
  viewCount: number | null;
  channelName: string | null;
}

export interface ClusterCardData {
  id: number;
  level: number;
  autoLabel: string | null;
  label: string | null;
  videoCount: number;
  avgScore: number | null;
  avgViews: number | null;
  totalViews: number | null;
  topChannels: string[];
  popularVideos: ClusterCardPopularVideo[];
  childrenCount: number;
}

export function NicheClusterCard({ cluster: c }: { cluster: ClusterCardData }) {
  // Outer wrapper is a div+onClick (not <Link>) because we have real
  // <a> anchors INSIDE the card for the per-thumbnail YT links — and
  // nested <a> inside <a> is invalid HTML / triggers a hydration error
  // in React. Using router.push instead of <Link> preserves middle-
  // click on the inner anchors. Cmd/Ctrl/middle-click on the card
  // body still opens the cluster in a new tab via the explicit handler.
  const router = useRouter();
  const href = `/niche/cluster/${c.id}`;
  const onCardClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      window.open(href, '_blank');
      return;
    }
    router.push(href);
  };

  const label = c.label || c.autoLabel || `Cluster #${c.id}`;
  const score = c.avgScore != null ? Math.round(c.avgScore) : null;
  const scoreColor =
    score == null ? 'text-[#666]' :
    score >= 80   ? 'text-green-400' :
    score >= 50   ? 'text-yellow-400' :
                    'text-red-400';

  // Pad popular videos to 4 slots so the thumb strip alignment is
  // consistent for sparse small clusters.
  const slots: Array<ClusterCardPopularVideo | null> = [...c.popularVideos];
  while (slots.length < 4) slots.push(null);
  const subBadge = c.childrenCount > 0
    ? { label: `${c.childrenCount} sub-niche${c.childrenCount === 1 ? '' : 's'}`, cls: 'bg-green-500/15 text-green-400 border-green-500/25' }
    : null;

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={onCardClick}
      onKeyDown={e => { if (e.key === 'Enter') router.push(href); }}
      className="bg-[#141414] border border-[#1f1f1f] rounded-xl hover:border-amber-500/60 transition block group cursor-pointer"
    >
      {/* Header strip: cluster meta + score on the right */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs bg-amber-600/30 text-amber-300 border border-amber-600/50 rounded-full px-2 py-0.5 whitespace-nowrap">
              {c.videoCount.toLocaleString()} videos
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/60 text-[#aaa] border border-white/10 whitespace-nowrap">
              L{c.level}
            </span>
            {subBadge && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap ${subBadge.cls}`}>
                {subBadge.label}
              </span>
            )}
            {c.topChannels.length > 0 && (
              <span className="text-xs text-[#888] truncate" title={c.topChannels.join(', ')}>
                · {c.topChannels.slice(0, 3).join(', ')}
                {c.topChannels.length > 3 && ` +${c.topChannels.length - 3}`}
              </span>
            )}
          </div>
          <h3 className="text-sm font-medium text-white group-hover:text-amber-400 transition line-clamp-1" title={label}>
            {label}
          </h3>
        </div>
        {score != null && (
          <div className="text-right flex-shrink-0">
            <div className={`text-lg font-bold ${scoreColor}`}>⚡ {score}</div>
            <div className="text-[10px] text-[#666] uppercase tracking-wider">avg score</div>
          </div>
        )}
      </div>

      {/* 4-tile stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-4 mb-3">
        <Stat label="Avg views per video" value={c.avgViews != null ? fmtYT(c.avgViews) : '—'} />
        <Stat label="Top channels"        value={c.topChannels.length > 0 ? String(c.topChannels.length) : '—'} />
        <Stat label="Total views"         value={c.totalViews != null ? fmtYT(c.totalViews) : '—'} valueColor="text-green-400" />
        <Stat label="Videos"              value={c.videoCount.toLocaleString()} />
      </div>

      {/* Popular videos strip — 4 thumbs + title below each */}
      <div className="px-4 pb-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[11px] text-[#666] uppercase tracking-wider">Most representative videos</h4>
          {c.popularVideos.length > 0 && (
            <span className="text-[10px] text-[#666]" title="Closest to cluster centroid, deduped to one per channel.">
              closest to centroid · 1 per channel
            </span>
          )}
        </div>
        {/* Per-tile transformOrigin so edge tiles expand inward on hover
            instead of clipping past the row's edge. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {slots.map((v, i) => {
            const origin = i === 0 ? 'left center' : i === 3 ? 'right center' : 'center';
            return v ? (
              <a
                key={v.videoId}
                href={v.url || '#'}
                target="_blank"
                rel="noreferrer"
                onClick={e => e.stopPropagation()}
                className="block group/thumb relative transition-transform duration-200 ease-out hover:scale-[1.45] hover:z-20 hover:shadow-2xl"
                style={{ transformOrigin: origin }}
              >
                <div className="relative aspect-video bg-[#0a0a0a] rounded-md overflow-hidden border border-[#1f1f1f] group-hover/thumb:border-[#444] transition">
                  {v.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[#333] text-[10px]">no thumb</div>
                  )}
                </div>
                <div className="mt-1.5 text-[11px] text-white line-clamp-2 leading-tight" title={v.title || ''}>
                  {v.title || '(no title)'}
                </div>
                <div className="mt-0.5 text-[10px] text-[#666] flex items-center gap-1.5">
                  {v.viewCount != null && <span className="text-green-400/90">{fmtYT(v.viewCount)} views</span>}
                  {v.channelName && <span className="truncate">· {v.channelName}</span>}
                </div>
              </a>
            ) : (
              <div key={`empty-${i}`} className="aspect-video bg-[#0a0a0a] border border-dashed border-[#1f1f1f] rounded-md flex items-center justify-center text-[#333] text-[10px]">
                —
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, valueColor = 'text-white' }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-3 py-2">
      <div className="text-[10px] text-[#666] uppercase tracking-wider">{label}</div>
      <div className={`text-base font-semibold ${valueColor} mt-0.5`}>{value}</div>
    </div>
  );
}
