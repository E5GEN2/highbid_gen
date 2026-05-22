'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { fmtYT } from '@/lib/format';
import { useSimilar } from '@/components/SimilarProvider';
import { ChannelAgeChip } from '@/components/ChannelAgeChip';
import { StarButton } from '@/components/FavouritesProvider';
import { BulkAddToNicheModal } from '@/components/BulkAddToNicheModal';

/** Similar-cluster Videos tab — grid of matching videos sorted by similarity/views/etc. */
export default function SimilarVideos() {
  const { filtered, loading, error } = useSimilar();
  const router = useRouter();
  const [sort, setSort] = useState<'similarity' | 'views' | 'score' | 'newest' | 'likes'>('similarity');

  // Bulk-select state. selectionMode flips on when the user clicks
  // "Select"; clicking cards then toggles membership instead of
  // navigating. The selected Set is keyed on video id.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sort) {
      case 'views':  return arr.sort((a, b) => b.viewCount - a.viewCount);
      case 'score':  return arr.sort((a, b) => b.score - a.score);
      case 'newest': return arr.sort((a, b) => new Date(b.postedAt || 0).getTime() - new Date(a.postedAt || 0).getTime());
      case 'likes':  return arr.sort((a, b) => b.likeCount - a.likeCount);
      default:       return arr.sort((a, b) => b.similarity - a.similarity);
    }
  }, [filtered, sort]);

  const allIds = useMemo(() => sorted.map(v => v.id), [sorted]);
  const allSelected = selected.size > 0 && allIds.every(id => selected.has(id));
  const someSelected = selected.size > 0;

  const toggleOne = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(allIds));
  const clearAll  = () => setSelected(new Set());
  const exitSelectionMode = () => { setSelectionMode(false); setSelected(new Set()); };

  if (loading) {
    return (
      <div className="px-8 pb-8 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden animate-pulse">
              <div className="aspect-video bg-[#1f1f1f]" />
              <div className="p-3 space-y-2">
                <div className="h-4 w-3/4 bg-[#1f1f1f] rounded" />
                <div className="h-3 w-1/2 bg-[#1f1f1f] rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-8 pb-8 max-w-7xl mx-auto">
        <div className="bg-red-900/20 border border-red-800/40 rounded-xl px-5 py-4 text-red-400">
          Couldn&apos;t load similar videos: {error}
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="px-8 pb-8 max-w-7xl mx-auto">
        <div className="bg-[#141414] border border-dashed border-[#1f1f1f] rounded-xl px-5 py-8 text-center text-[#666]">
          No similar videos match the threshold. Lower the min match from the header.
        </div>
      </div>
    );
  }

  return (
    <div className="px-8 pb-8 max-w-7xl mx-auto space-y-4">
      {/* Sort pills + bulk-select toggle. The "Select" button flips
          the page into selection mode; once on, cards click to
          toggle and the toolbar grows a counter + action buttons. */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {([
            { value: 'similarity', label: 'Best Match' },
            { value: 'views', label: 'Most Views' },
            { value: 'score', label: 'Highest Score' },
            { value: 'newest', label: 'Newest' },
            { value: 'likes', label: 'Most Likes' },
          ] as const).map(opt => (
            <button
              key={opt.value}
              onClick={() => setSort(opt.value)}
              className={`px-3 py-1 rounded-full text-xs transition ${
                sort === opt.value ? 'bg-white text-black font-medium' : 'text-[#888] border border-[#333] hover:border-[#555]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {!selectionMode && (
          <button
            type="button"
            onClick={() => setSelectionMode(true)}
            className="px-3.5 py-1.5 rounded-full text-xs font-medium bg-white/[0.04] border border-white/[0.1] text-white hover:bg-white/[0.08] hover:border-white/[0.2] transition flex items-center gap-1.5"
            title="Select multiple videos to add them to a niche"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 17h7M17.5 13.5v7" />
            </svg>
            Select
          </button>
        )}
      </div>

      {/* Selection toolbar — sticks at top of grid when in
          selection mode. Shows counter + select-all / clear /
          "Add N to niche" / exit actions. Sticky so it stays
          visible while scrolling the grid. */}
      {selectionMode && (
        <div className="sticky top-0 z-20 -mx-2 px-2 py-2 bg-[#0a0a0a]/95 backdrop-blur-md border-b border-[#1f1f1f] flex items-center gap-3 flex-wrap">
          <span className="text-sm text-white font-medium">
            {selected.size === 0
              ? 'Selection mode'
              : `${selected.size} of ${sorted.length} selected`}
          </span>
          <button
            type="button"
            onClick={allSelected ? clearAll : selectAll}
            className="text-xs text-[#888] hover:text-white transition"
          >
            {allSelected ? 'Clear selection' : `Select all ${sorted.length}`}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setBulkOpen(true)}
            disabled={!someSelected}
            className="px-3.5 py-1.5 rounded-full text-xs font-semibold bg-amber-400 text-black hover:bg-amber-300 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            {someSelected ? `Add ${selected.size} to niche…` : 'Add to niche…'}
          </button>
          <button
            type="button"
            onClick={exitSelectionMode}
            className="px-3 py-1.5 text-xs text-[#888] border border-[#2a2a2a] rounded-full hover:bg-[#1a1a1a] hover:text-white transition"
          >
            Done
          </button>
        </div>
      )}

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sorted.map(v => {
          const vidMatch = (v.url || '').match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
          const thumb = v.thumbnail || (vidMatch ? `https://img.youtube.com/vi/${vidMatch[1]}/hqdefault.jpg` : '');
          const isSelected = selected.has(v.id);

          // In selection mode the whole card becomes a toggle. The
          // inner anchors / star button stop propagation so they
          // still work normally (open YT, navigate to similar,
          // star/unstar) — only the card body click toggles.
          const onCardClick = () => { if (selectionMode) toggleOne(v.id); };
          return (
            <div
              key={v.id}
              onClick={onCardClick}
              className={`relative bg-[#141414] rounded-xl overflow-hidden transition ${
                selectionMode && isSelected
                  ? 'border-2 border-amber-400/60 ring-2 ring-amber-400/20'
                  : selectionMode
                    ? 'border border-[#1f1f1f] hover:border-amber-400/40'
                    : 'border border-[#1f1f1f]'
              } ${selectionMode ? 'cursor-pointer' : ''}`}
            >
              <div className="relative aspect-video bg-[#0a0a0a]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {thumb && <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />}

                {/* Selection-mode checkbox overlay. Sits over the
                    thumbnail; large hit target. Click also fires
                    the card-level toggle via bubble, but explicit
                    handler kept for affordance. */}
                {selectionMode && (
                  <div className={`absolute top-2 left-2 w-7 h-7 rounded-md flex items-center justify-center border-2 transition shadow ${
                    isSelected
                      ? 'bg-amber-400 border-amber-400'
                      : 'bg-black/60 border-white/40 hover:bg-black/80'
                  }`}>
                    {isSelected && (
                      <svg className="w-4 h-4 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                )}

                <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'}`}>
                  ⚡ {v.score}
                </div>
                {!selectionMode && (
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs font-bold bg-purple-600 text-white">
                    {Math.round(v.similarity * 100)}% match
                  </div>
                )}
              </div>
              <div className="p-3">
                <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
                <div className="flex items-center gap-2 text-xs text-[#888] mb-1">
                  <span className="text-green-400">{fmtYT(v.viewCount)} views</span>
                  {v.channelName && <span>· {v.channelName}</span>}
                  {v.postedAt && <span>· {formatTimeAgo(v.postedAt)}</span>}
                </div>
                <div className="flex items-center gap-3 text-xs text-[#666] flex-wrap">
                  {v.likeCount > 0 && <span>👍 {fmtYT(v.likeCount)}</span>}
                  {v.subscriberCount > 0 && <span>👥 {fmtYT(v.subscriberCount)}</span>}
                  <ChannelAgeChip
                    createdAt={v.channelCreatedAt}
                    firstUploadAt={v.firstUploadAt}
                    dormancyDays={v.dormancyDays}
                  />
                </div>
                <div className="flex items-center justify-between mt-2 gap-2">
                  {v.url && (
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="text-[10px] text-blue-400 truncate min-w-0 flex-1"
                    >
                      {v.url}
                    </a>
                  )}
                  {/* Star and Similar both swallow propagation so
                      clicking them in selection mode doesn't also
                      toggle the card. */}
                  <span onClick={e => e.stopPropagation()}>
                    <StarButton videoId={v.id} />
                  </span>
                  <Link
                    href={`/niche/similar/${v.id}`}
                    onClick={e => e.stopPropagation()}
                    className="flex items-center gap-1 text-xs bg-green-600/20 text-green-400 border border-green-600/40 px-2 py-0.5 rounded-full hover:bg-green-600/30 transition flex-shrink-0 font-medium"
                  >
                    Similar
                  </Link>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bulk-add modal — chooser opens with the current selection
          baked in. onAdded closes the modal, then we exit selection
          mode and offer the user a quick nav to the destination
          niche via a router push. */}
      <BulkAddToNicheModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        videoIds={[...selected]}
        onAdded={(nicheId) => {
          setBulkOpen(false);
          exitSelectionMode();
          router.push(`/niche/custom/${nicheId}`);
        }}
      />
    </div>
  );
}

function formatTimeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return 'Just now';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
