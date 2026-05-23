'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { fmtYT } from '@/lib/format';
import { useSimilarModal } from '@/components/SimilarModal';
import { ChannelAgeChip } from '@/components/ChannelAgeChip';
import { StarButton, useFavourites } from '@/components/FavouritesProvider';
import { AddFromFavouritesModal } from '@/components/AddFromFavouritesModal';
import { SetNicheCenterModal } from '@/components/SetNicheCenterModal';

/**
 * Custom niche detail page. Shows the niche's metadata up top
 * (name, description, video count) with a small edit/rename row,
 * then the grid of videos inside it. Empty state explains how to
 * add the first video.
 *
 * Layout/style mirrors /niche/favourites Videos panel for visual
 * continuity — same card shape, same Similar pill, same ChannelAge
 * chip — so users don't need to learn a second pattern.
 */

interface NicheRow {
  id: number; name: string; description: string | null;
  videoCount: number; createdAt: string; updatedAt: string;
  centerVideoId: number | null;
}
interface VideoRow {
  id: number; keyword: string; url: string; title: string; view_count: number;
  channel_name: string; posted_date: string; posted_at: string; score: number;
  channel_created_at: string;
  subscriber_count: number; like_count: number; comment_count: number;
  thumbnail: string; first_upload_at?: string | null; dormancy_days?: number | null;
  added_at: string;
}

export default function CustomNichePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const nicheId = parseInt(params.id);
  const { openSimilar } = useSimilarModal();
  const { refreshCustomNiches, membershipNonce, bumpMembership } = useFavourites();

  const [niche, setNiche] = useState<NicheRow | null>(null);
  const [nicheError, setNicheError] = useState<string | null>(null);
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [centreUnavailable, setCentreUnavailable] = useState(false);

  // Sort + min-score filter — mirror the pattern used on other
  // video grids across the product. `recent` is the default
  // because added_at order matches what the user just curated.
  type SortKey = 'recent' | 'centre' | 'views' | 'likes' | 'score' | 'newest' | 'oldest';
  const [sort, setSort] = useState<SortKey>('recent');
  const [minScore, setMinScore] = useState<0 | 50 | 70 | 80 | 90>(0);

  // Edit-name state
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  // Add-from-favourites modal state — kept local because this is
  // the only surface that opens it (vs. the StarChooser which any
  // page can open via the FavouritesProvider).
  const [addOpen, setAddOpen] = useState(false);
  // Set-niche-centre modal — same scoping rationale.
  const [centerOpen, setCenterOpen] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ sort, minScore: String(minScore) });
      const [nicheRes, videosRes] = await Promise.all([
        fetch(`/api/niche-spy/custom-niches/${nicheId}`).then(r => r.json()),
        fetch(`/api/niche-spy/custom-niches/${nicheId}/videos?${qs.toString()}`).then(r => r.json()),
      ]);
      if (nicheRes.error) {
        setNicheError(nicheRes.error);
      } else {
        setNiche(nicheRes.niche);
        setEditName(nicheRes.niche.name);
        setEditDesc(nicheRes.niche.description || '');
      }
      setVideos(videosRes.videos || []);
      setCentreUnavailable(!!videosRes.centreUnavailable);
    } catch (e) {
      setNicheError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [nicheId, sort, minScore]);

  // Refetch on niche change, on sort / minScore change, AND on
  // membership-nonce ticks so the grid drops videos the user
  // unchecks from the star chooser elsewhere on the page. All
  // three end up running the same loadAll; the deps just listen
  // for any of them to flip.
  useEffect(() => {
    if (!Number.isFinite(nicheId)) return;
    loadAll();
  }, [nicheId, loadAll, membershipNonce]);

  const handleSaveEdit = async () => {
    if (!niche) return;
    setSavingEdit(true);
    try {
      const r = await fetch(`/api/niche-spy/custom-niches/${niche.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, description: editDesc }),
      });
      if (r.ok) {
        setNiche({ ...niche, name: editName, description: editDesc || null });
        setEditing(false);
        refreshCustomNiches();
      }
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async () => {
    if (!niche) return;
    if (!confirm(`Delete "${niche.name}"? Videos inside it won't be deleted — just the collection.`)) return;
    await fetch(`/api/niche-spy/custom-niches/${niche.id}`, { method: 'DELETE' });
    refreshCustomNiches();
    router.push('/niche/favourites');
  };

  // Per-card "remove from niche" used by the × overlay in edit
  // mode. Optimistic: drop the row from local state first, then
  // POST. On error we put the video back and surface a confirm
  // dialog asking the user to retry — keeps the grid snappy in
  // the common case where DELETE just succeeds.
  const handleRemoveVideo = useCallback(async (videoId: number) => {
    if (!niche) return;
    const prev = videos;
    setVideos(curr => curr.filter(v => v.id !== videoId));
    try {
      const r = await fetch(`/api/niche-spy/custom-niches/${niche.id}/videos`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoIds: [videoId] }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { centreCleared?: boolean };
      // If the removed video was the centre, the API cleared
      // center_video_id — reflect that locally so the badge stops
      // painting on the (now-gone) thumb without waiting for a
      // full refetch.
      if (d.centreCleared) {
        setNiche(curr => curr ? { ...curr, centerVideoId: null } : curr);
      }
      // Bump the global membership nonce so My Niches counts +
      // any other open surface re-sync. We don't refetch this
      // page's videos — optimistic drop already happened.
      bumpMembership();
      refreshCustomNiches();
    } catch {
      // Restore on failure.
      setVideos(prev);
      alert('Could not remove the video. Try again?');
    }
  }, [niche, videos, bumpMembership, refreshCustomNiches]);

  if (!Number.isFinite(nicheId)) {
    return <div className="p-8 text-red-400">Invalid niche id.</div>;
  }

  if (nicheError) {
    return (
      <div className="px-8 py-8 max-w-7xl mx-auto">
        <Link href="/niche/favourites" className="text-sm text-amber-400 hover:text-amber-300">
          ← Back to favourites
        </Link>
        <div className="mt-6 bg-[#141414] border border-red-500/30 rounded-xl p-6 text-sm text-red-400">
          {nicheError}
        </div>
      </div>
    );
  }

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-2">
        <Link href="/niche/favourites" className="text-xs text-[#888] hover:text-white transition">
          ← Favourites / My niches
        </Link>
      </div>

      {/* Niche header — name + description + actions */}
      <div className="mb-8">
        {!editing && niche && (
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold text-white">{niche.name}</h1>
              {niche.description && (
                <p className="text-sm text-[#888] mt-1.5 max-w-2xl">{niche.description}</p>
              )}
              <div className="flex items-center gap-2 mt-3 text-xs text-[#666]">
                <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-medium">
                  {niche.videoCount} {niche.videoCount === 1 ? 'video' : 'videos'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
              {/* "Set niche centre" — placed to the LEFT of Add
                  from Favourites per design request. Disabled when
                  the niche has no videos yet (nothing to pick from).
                  Filled-amber when a centre is set, outlined when
                  not, mirrors the star button's filled/hollow
                  language. */}
              <button
                type="button"
                onClick={() => setCenterOpen(true)}
                disabled={!niche || niche.videoCount === 0}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed ${
                  niche?.centerVideoId != null
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30'
                    : 'bg-transparent text-amber-300 border border-amber-500/40 hover:bg-amber-500/10'
                }`}
                title={
                  niche?.centerVideoId != null
                    ? 'Change the niche centre'
                    : 'Pick the most representative video for this niche'
                }
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={niche?.centerVideoId != null ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                </svg>
                {niche?.centerVideoId != null ? 'Niche centre' : 'Set niche centre'}
              </button>

              {/* Primary action — adds from the existing Favourites
                  list in bulk. Comes second now (centre setter is
                  the new leading action). */}
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-amber-400 text-black rounded-md hover:bg-amber-300 transition"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Add from Favourites
              </button>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="px-3 py-1.5 text-xs text-[#888] border border-[#2a2a2a] rounded-md hover:bg-[#1a1a1a] hover:text-white transition"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="px-3 py-1.5 text-xs text-red-400 border border-red-500/20 rounded-md hover:bg-red-500/10 transition"
              >
                Delete
              </button>
            </div>
          </div>
        )}

        {editing && niche && (
          <div className="p-4 rounded-xl bg-[#0f0f0f] border border-[#1f1f1f] space-y-2.5">
            <input
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              maxLength={80}
              className="w-full px-3 py-2 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-white focus:outline-none focus:border-amber-400/50"
            />
            <input
              type="text"
              value={editDesc}
              onChange={e => setEditDesc(e.target.value)}
              placeholder="Description (optional)"
              maxLength={280}
              className="w-full px-3 py-2 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-white placeholder-[#555] focus:outline-none focus:border-amber-400/50"
            />
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={savingEdit}
                className="px-3 py-1.5 text-xs font-semibold bg-amber-400 text-black rounded-md hover:bg-amber-300 transition disabled:opacity-50"
              >
                {savingEdit ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => { setEditing(false); setEditName(niche.name); setEditDesc(niche.description || ''); }}
                className="px-3 py-1.5 text-xs text-[#888] hover:text-white"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Sort pills + min-score filter. Same vocabulary as the
          other video grids across the product — Recent, Most
          views, etc. Closest-to-centre only renders when the
          niche has a centre set; clicking it triggers the
          vector-DB cosine sort. If the centre lacks an embedding
          the API falls back to recent and we render a soft
          warning. Hidden until the niche has at least one video
          (so the empty state isn't crowded). */}
      {(niche?.videoCount ?? 0) > 0 && (
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {([
              { value: 'recent', label: 'Recently added' },
              ...(niche?.centerVideoId != null
                ? [{ value: 'centre', label: 'Closest to centre' } as const]
                : []),
              { value: 'views',  label: 'Most views'    },
              { value: 'likes',  label: 'Most likes'    },
              { value: 'score',  label: 'Highest score' },
              { value: 'newest', label: 'Newest'        },
              { value: 'oldest', label: 'Oldest'        },
            ] as const).map(opt => (
              <button
                key={opt.value}
                onClick={() => setSort(opt.value as SortKey)}
                className={`px-3 py-1 rounded-full text-xs transition ${
                  sort === opt.value
                    ? 'bg-white text-black font-medium'
                    : 'text-[#888] border border-[#333] hover:border-[#555]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-[#888]">
            <span>Min score</span>
            <select
              value={minScore}
              onChange={e => setMinScore(Number(e.target.value) as 0 | 50 | 70 | 80 | 90)}
              className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-md px-2 py-1 text-white focus:outline-none focus:border-amber-400/50"
            >
              <option value={0}>Any</option>
              <option value={50}>50+</option>
              <option value={70}>70+</option>
              <option value={80}>80+</option>
              <option value={90}>90+</option>
            </select>
          </div>
        </div>
      )}

      {sort === 'centre' && centreUnavailable && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[12px] text-amber-300">
          Centre video has no embedding yet, so sorting by closest is unavailable.
          Showing recently-added order instead.
        </div>
      )}

      {/* Video grid (same shape as the Favourites Videos tab) */}
      {loading && videos.length === 0 && (
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
      )}

      {!loading && videos.length === 0 && (
        <div className="bg-[#141414] border border-dashed border-[#1f1f1f] rounded-xl px-6 py-16 text-center">
          <div className="text-5xl mb-3">🗂️</div>
          <h3 className="text-base font-medium text-white mb-1">No videos in this niche yet</h3>
          <p className="text-sm text-[#666] mb-5">
            Pull videos in from your Favourites, or star any video from
            anywhere on the site — the chooser lets you drop it here.
          </p>
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold bg-amber-400 text-black hover:bg-amber-300 transition"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add from Favourites
            </button>
            <Link
              href="/niche/niches"
              className="px-4 py-2 rounded-full text-sm font-semibold bg-white/[0.04] border border-white/[0.08] text-white hover:bg-white/[0.08] transition"
            >
              Browse niches →
            </Link>
          </div>
        </div>
      )}

      {videos.length > 0 && (() => {
        // Order: the niche-centre video always shows first, the
        // rest follow in their original added_at order from the
        // server. Stable + predictable; if no centre is set the
        // grid is unchanged.
        const centerId = niche?.centerVideoId ?? null;
        const center = centerId != null ? videos.find(v => v.id === centerId) : null;
        const rest = center ? videos.filter(v => v.id !== center.id) : videos;
        const ordered = center ? [center, ...rest] : rest;
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {ordered.map(v => (
              <VideoCard
                key={v.id}
                v={v}
                isCenter={v.id === centerId}
                openSimilar={openSimilar}
                // Pass the remove handler only while the niche is
                // in edit mode — the card uses its presence as the
                // signal to render the × overlay.
                onRemove={editing ? () => handleRemoveVideo(v.id) : undefined}
              />
            ))}
          </div>
        );
      })()}

      {/* Add-from-favourites modal. Mounted at the page root so the
          backdrop covers the whole viewport. existingVideoIds is
          built from the current page video list — that way the
          modal hides what's already in. On save we re-fetch the
          full niche state so counts, ordering, and the grid stay
          in lockstep. */}
      {niche && (
        <AddFromFavouritesModal
          open={addOpen}
          onClose={() => setAddOpen(false)}
          nicheId={niche.id}
          nicheName={niche.name}
          existingVideoIds={new Set(videos.map(v => v.id))}
          onAdded={() => {
            refreshCustomNiches();
            loadAll();
          }}
        />
      )}

      {/* Set-niche-centre modal — picks one video from the niche
          to designate as its canonical centre. After save, the
          page reloads so the badge + bubble-to-top take effect. */}
      {niche && (
        <SetNicheCenterModal
          open={centerOpen}
          onClose={() => setCenterOpen(false)}
          nicheId={niche.id}
          nicheName={niche.name}
          videos={videos.map(v => ({
            id: v.id,
            title: v.title,
            url: v.url,
            thumbnail: v.thumbnail,
            view_count: v.view_count,
            channel_name: v.channel_name,
            score: v.score,
          }))}
          currentCenterId={niche.centerVideoId}
          onSaved={() => loadAll()}
        />
      )}
    </div>
  );
}

function VideoCard({
  v, openSimilar, isCenter = false, onRemove,
}: {
  v: VideoRow;
  openSimilar: (id: number) => void;
  /** When true, this video is the niche centre — render an amber
   *  ring + corner badge so it visually leads the grid. */
  isCenter?: boolean;
  /** When provided, the card renders a red × overlay in the
   *  top-right of the thumbnail. Click → optimistic remove via
   *  the supplied handler. Page only sets this in edit mode. */
  onRemove?: () => void;
}) {
  const t = getThumb(v.url, v.thumbnail);
  return (
    <div className={`bg-[#141414] rounded-xl overflow-hidden transition ${
      isCenter
        ? 'border-2 border-amber-400/60 hover:border-amber-400/90 shadow-lg shadow-amber-500/[0.08]'
        : 'border border-[#1f1f1f] hover:border-[#333]'
    }`}>
      <div className="relative aspect-video bg-[#0a0a0a]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {t ? <img src={t} alt="" className="w-full h-full object-cover" loading="lazy" /> : null}
        {isCenter && (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-amber-400 text-black text-[10px] font-bold flex items-center gap-1 shadow">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
            NICHE CENTRE
          </div>
        )}
        {/* Edit-mode remove button. Top-left so it stays out of
            the way of the score chip on the right and (when set)
            the centre badge — when both centre + onRemove are on
            we shift the × to a slightly lower row. */}
        {onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (confirm('Remove this video from the niche?')) onRemove();
            }}
            title="Remove from this niche"
            className={`absolute z-10 w-7 h-7 rounded-full flex items-center justify-center bg-red-500/95 text-white border border-red-400/60 hover:bg-red-500 hover:scale-110 transition shadow-lg ${
              isCenter ? 'top-9 left-2' : 'top-2 left-2'
            }`}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${
          v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'
        }`}>⚡ {v.score}</div>
      </div>
      <div className="p-3">
        <div className="flex items-center justify-between mb-2 gap-2">
          {v.keyword && (
            <span className="text-xs bg-purple-600/30 text-purple-300 border border-purple-600/50 rounded-full px-2 py-0.5">
              {v.keyword}
            </span>
          )}
          <div className="flex items-center gap-1.5 ml-auto">
            <StarButton videoId={v.id} />
            <button
              onClick={() => openSimilar(v.id)}
              className="flex items-center gap-1 text-xs bg-green-600/20 text-green-400 border border-green-600/40 px-2.5 py-1 rounded-full hover:bg-green-600/30 transition flex-shrink-0 font-medium"
            >
              Similar
            </button>
          </div>
        </div>
        <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
        <div className="flex items-center gap-2 text-xs text-[#888] mb-1.5 flex-wrap">
          <span className="text-green-400 font-medium">{v.view_count ? fmtYT(v.view_count) + ' views' : ''}</span>
          {v.channel_name && <span>· {v.channel_name}</span>}
          {(v.posted_at || v.posted_date) && <span>· {v.posted_at ? timeAgo(v.posted_at) : v.posted_date}</span>}
        </div>
        <div className="flex items-center gap-3 text-xs text-[#666] flex-wrap mb-2">
          {v.like_count > 0 && <span>👍 {fmtYT(v.like_count)}</span>}
          {v.comment_count > 0 && <span>💬 {fmtYT(v.comment_count)}</span>}
          {v.subscriber_count > 0 && <span>👥 {fmtYT(v.subscriber_count)} subscribers</span>}
          <ChannelAgeChip
            createdAt={v.channel_created_at}
            firstUploadAt={v.first_upload_at}
            dormancyDays={v.dormancy_days}
          />
        </div>
        {v.url && (
          <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300 truncate block">
            {v.url}
          </a>
        )}
        <div className="text-[10px] text-[#555] mt-2">Added {timeAgo(v.added_at)}</div>
      </div>
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return 'Just now';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getThumb(url: string | null | undefined, fallback: string): string {
  if (!fallback || fallback.includes('ytimg.com')) {
    const m = url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
  }
  return fallback || '';
}
