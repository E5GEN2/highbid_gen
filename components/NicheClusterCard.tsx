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
  /** Distinct channels contributing videos to the cluster — replaces
   *  the redundant videoCount stat tile on the card (videoCount is
   *  already shown as the orange badge in the header). */
  channelCount?: number;
  avgScore: number | null;
  avgViews: number | null;
  totalViews: number | null;
  topChannels: string[];
  popularVideos: ClusterCardPopularVideo[];
  /** 52 weekly upload counts (oldest → newest) covering the last
   *  year. Drives the inline heartbeat sparkline that replaces the
   *  Top channels tile. */
  uploadHistogram?: number[];
  childrenCount: number;
  /** Optional cosine similarity to a query — set when this card is
   *  rendered as a search result. Drives the "% match" pill. */
  similarity?: number;
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
            {c.similarity !== undefined && (
              <span className="text-xs bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-full px-2 py-0.5 whitespace-nowrap font-medium">
                {Math.round(c.similarity * 100)}% match
              </span>
            )}
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

      {/* 4-tile stats row. Video count lives in the header badge so
          slot 4 shows total-channels; slot 2 swaps the static "Top
          channels" count for an inline heartbeat sparkline of weekly
          upload counts over the last year — lets the user instantly
          see whether a niche is alive or has gone quiet. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-4 mb-3">
        <Stat label="Avg views per video" value={c.avgViews != null ? fmtYT(c.avgViews) : '—'} />
        <HeartbeatTile histogram={c.uploadHistogram} />
        <Stat label="Total views"         value={c.totalViews != null ? fmtYT(c.totalViews) : '—'} valueColor="text-green-400" />
        <Stat label="Total channels"      value={c.channelCount != null ? c.channelCount.toLocaleString() : '—'} valueColor="text-blue-400" />
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

/**
 * Inline weekly-upload sparkline. 52 buckets, oldest → newest. The
 * "heartbeat" name comes from the visual: a steady stream of bars
 * across the year reads as alive, while a flatlined right side reads
 * as a niche that's gone quiet.
 *
 * Colors are derived from the most-recent quarter's volume vs the
 * trailing nine months — green when the niche is uptrending, red
 * when it's falling off, neutral when it's been steady.
 */
function HeartbeatTile({ histogram }: { histogram?: number[] }) {
  const buckets = histogram && histogram.length > 0 ? histogram : new Array(52).fill(0);
  const total = buckets.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...buckets);
  // Compare the last 13 weeks vs the prior 39 weeks to color the bar.
  const recent = buckets.slice(-13).reduce((a, b) => a + b, 0);
  const earlier = buckets.slice(0, -13).reduce((a, b) => a + b, 0);
  const recentRate = recent / 13;
  const earlierRate = earlier / 39 || 0.0001;
  const trend = recentRate / earlierRate;
  const fill =
    total === 0          ? '#333'           // dead
    : trend >= 1.3        ? '#34d399'        // uptrending — emerald-400
    : trend <= 0.5        ? '#f87171'        // falling off — red-400
                          : '#a78bfa';       // steady — violet-400
  const badge =
    total === 0          ? '— quiet'
    : trend >= 1.3        ? '↑ trending'
    : trend <= 0.5        ? '↓ slowing'
                          : 'steady';

  // SVG bars — fixed viewBox so it scales to the tile. 52 bars in
  // 100 wide = 1.92 each, gap 0.3.
  const W = 100, H = 28, gap = 0.3;
  const barW = (W - gap * (buckets.length - 1)) / buckets.length;
  return (
    <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-3 py-2 overflow-hidden">
      <div className="flex items-center justify-between gap-1">
        <div className="text-[10px] text-[#666] uppercase tracking-wider truncate">Heartbeat (52w)</div>
        <span className="text-[9px] text-[#888] flex-shrink-0">{badge}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-7 mt-1 block">
        {buckets.map((c, i) => {
          const h = c === 0 ? 1 : Math.max(1, (c / max) * (H - 2));
          return (
            <rect
              key={i}
              x={i * (barW + gap)}
              y={H - h}
              width={barW}
              height={h}
              fill={c === 0 ? '#1f1f1f' : fill}
              rx={0.4}
            />
          );
        })}
      </svg>
    </div>
  );
}
