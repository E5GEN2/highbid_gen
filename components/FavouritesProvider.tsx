'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Favourites + Custom Niches — the shared provider for every video
 * / niche save action on the site.
 *
 * Three pieces of state, all globally scoped (no per-user yet, same
 * as the original favourites system):
 *
 *   1. `ids`            — Set of starred video ids (Favourites)
 *   2. `nicheIds`       — Set of starred cluster ids
 *   3. `customNiches`   — User-curated collections of videos
 *
 * Star-button UX:
 *   - Click a video star → opens the StarChooser modal (lets the user
 *     add to Favourites and/or any custom niche in one place).
 *   - Click a niche/cluster star → direct toggle into the niche
 *     favourites set. No chooser for clusters because they're not
 *     part of the custom-niche surface (custom niches collect videos).
 *
 * Both writes are optimistic: local state flips first, server call
 * goes after, rollback on failure. A full re-fetch on mount keeps
 * everything consistent across navigation and hard refresh.
 */

export interface CustomNiche {
  id: number;
  name: string;
  description: string | null;
  videoCount: number;
  createdAt: string;
  updatedAt: string;
  /** Manually-designated central video. When set, the niche card
   *  bubbles this video to position 0 of popularVideos and marks
   *  its thumb so the card visually leads with it. */
  centerVideoId?: number | null;
  // Aggregate fields populated by /api/niche-spy/custom-niches GET
  // so the My Niches tab can render the full NicheClusterCard.
  // Optional because /api/niche-spy/custom-niches/[id] (single-row
  // fetch on the detail page) doesn't bother computing them.
  avgScore?: number | null;
  avgViews?: number | null;
  totalViews?: number | null;
  channelCount?: number;
  topChannels?: string[];
  popularVideos?: Array<{
    videoId: number;
    title: string | null;
    thumbnail: string | null;
    url: string | null;
    viewCount: number | null;
    channelName: string | null;
  }>;
  uploadHistogram?: number[];
  opportunity?: {
    sample: number;
    nos: number;
    nosDisplay: number;
    topLeftPct: number;
    newcomerRate: number;
    lowSubCeiling: number;
  } | null;
}

interface FavouritesContextType {
  // Video favourites
  ids: Set<number>;
  isStarred: (videoId: number) => boolean;
  toggleStar: (videoId: number) => Promise<void>;
  count: number;

  // Niche / cluster favourites
  nicheIds: Set<number>;
  isNicheStarred: (clusterId: number) => boolean;
  toggleNicheStar: (clusterId: number) => Promise<void>;
  nicheCount: number;

  // Custom niches (collections)
  customNiches: CustomNiche[];
  customNichesLoading: boolean;
  refreshCustomNiches: () => Promise<void>;
  createCustomNiche: (name: string, description?: string) => Promise<CustomNiche | null>;

  // Star chooser modal control — exposed so any video star button on
  // any page can open the chooser without remounting it. The modal
  // is rendered once inside this provider's children tree.
  activeChooserVideoId: number | null;
  openStarChooser: (videoId: number) => void;
  closeStarChooser: () => void;

  /** Monotonic counter that ticks every time a custom-niche
   *  membership write succeeds (chooser save, bulk-add, etc.).
   *  Pages showing membership-dependent data depend on this in a
   *  useEffect so they re-fetch when memberships change elsewhere
   *  — keeps the niche detail page reactive when the user unchecks
   *  a niche from the star chooser. */
  membershipNonce: number;
  bumpMembership: () => void;

  loading: boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<FavouritesContextType | null>(null);

export function useFavourites() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useFavourites must be used within FavouritesProvider');
  return ctx;
}

export function FavouritesProvider({ children }: { children: React.ReactNode }) {
  const [ids, setIds] = useState<Set<number>>(new Set());
  const [nicheIds, setNicheIds] = useState<Set<number>>(new Set());
  const [customNiches, setCustomNiches] = useState<CustomNiche[]>([]);
  const [customNichesLoading, setCustomNichesLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [activeChooserVideoId, setActiveChooserVideoId] = useState<number | null>(null);
  // Membership change nonce — tick after any custom-niche
  // membership write so subscribers can re-fetch on demand.
  const [membershipNonce, setMembershipNonce] = useState(0);
  const bumpMembership = useCallback(() => setMembershipNonce(n => n + 1), []);

  const refreshCustomNiches = useCallback(async () => {
    setCustomNichesLoading(true);
    try {
      const r = await fetch('/api/niche-spy/custom-niches').then(r => r.json());
      setCustomNiches(r.niches || []);
    } catch { /* ignore */ }
    finally { setCustomNichesLoading(false); }
  }, []);

  const refresh = useCallback(async () => {
    // Pull video + niche favourite ids + custom-niche list in
    // parallel. None of them depend on each other.
    try {
      const [vRes, nRes, cRes] = await Promise.all([
        fetch('/api/niche-spy/favourites?onlyIds=1').then(r => r.json()).catch(() => ({ ids: [] })),
        fetch('/api/niche-spy/favourite-niches?onlyIds=1').then(r => r.json()).catch(() => ({ ids: [] })),
        fetch('/api/niche-spy/custom-niches').then(r => r.json()).catch(() => ({ niches: [] })),
      ]);
      setIds(new Set<number>(vRes.ids || []));
      setNicheIds(new Set<number>(nRes.ids || []));
      setCustomNiches(cRes.niches || []);
    } catch { /* ignore */ }
    finally { setLoading(false); setCustomNichesLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const isStarred = useCallback((videoId: number) => ids.has(videoId), [ids]);
  const isNicheStarred = useCallback((clusterId: number) => nicheIds.has(clusterId), [nicheIds]);

  // Direct toggle (used by chooser modal save + niche cards). The
  // chooser uses this for the Favourites checkbox; we still expose
  // it on the type so existing call-sites that want toggle-on-click
  // (admin pages, debug surfaces) keep working.
  const toggleStar = useCallback(async (videoId: number) => {
    const wasStarred = ids.has(videoId);
    setIds(prev => {
      const next = new Set(prev);
      if (wasStarred) next.delete(videoId); else next.add(videoId);
      return next;
    });
    try {
      await fetch('/api/niche-spy/favourites', {
        method: wasStarred ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId }),
      });
    } catch {
      setIds(prev => {
        const next = new Set(prev);
        if (wasStarred) next.add(videoId); else next.delete(videoId);
        return next;
      });
    }
  }, [ids]);

  const toggleNicheStar = useCallback(async (clusterId: number) => {
    const wasStarred = nicheIds.has(clusterId);
    setNicheIds(prev => {
      const next = new Set(prev);
      if (wasStarred) next.delete(clusterId); else next.add(clusterId);
      return next;
    });
    try {
      await fetch('/api/niche-spy/favourite-niches', {
        method: wasStarred ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterId }),
      });
    } catch {
      setNicheIds(prev => {
        const next = new Set(prev);
        if (wasStarred) next.add(clusterId); else next.delete(clusterId);
        return next;
      });
    }
  }, [nicheIds]);

  const createCustomNiche = useCallback(async (name: string, description?: string): Promise<CustomNiche | null> => {
    try {
      const r = await fetch('/api/niche-spy/custom-niches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description }),
      });
      if (!r.ok) return null;
      const d = await r.json() as { niche?: CustomNiche };
      if (d.niche) {
        // Prepend so the new niche shows up at the top of the list
        // (updated_at DESC ordering on the server).
        setCustomNiches(prev => [d.niche!, ...prev]);
        return d.niche;
      }
    } catch { /* ignore */ }
    return null;
  }, []);

  const openStarChooser = useCallback((videoId: number) => {
    setActiveChooserVideoId(videoId);
  }, []);
  const closeStarChooser = useCallback(() => {
    setActiveChooserVideoId(null);
  }, []);

  const value = useMemo<FavouritesContextType>(() => ({
    ids, nicheIds,
    isStarred, isNicheStarred,
    toggleStar, toggleNicheStar,
    count: ids.size, nicheCount: nicheIds.size,
    customNiches, customNichesLoading,
    refreshCustomNiches, createCustomNiche,
    activeChooserVideoId, openStarChooser, closeStarChooser,
    membershipNonce, bumpMembership,
    loading, refresh,
  }), [
    ids, nicheIds, isStarred, isNicheStarred, toggleStar, toggleNicheStar,
    customNiches, customNichesLoading, refreshCustomNiches, createCustomNiche,
    activeChooserVideoId, openStarChooser, closeStarChooser,
    membershipNonce, bumpMembership,
    loading, refresh,
  ]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Star chooser mounts once here — any star button anywhere on
          the page can pop it open without remounting. Imported here
          inline (lazy via require would cost a render) so the bundle
          is a single chunk. */}
      <LazyStarChooser />
    </Ctx.Provider>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Lazy import wrapper — keeps the chooser logic in its own file
 *  but mounted from here so the modal is always available.
 * ──────────────────────────────────────────────────────────────── */
function LazyStarChooser() {
  // dynamic import keeps the chooser code out of the critical
  // bundle of pages that never open it, but inside the same render
  // tree so it can hook into useFavourites().
  const [Comp, setComp] = useState<React.ComponentType | null>(null);
  const { activeChooserVideoId } = useFavourites();
  useEffect(() => {
    if (activeChooserVideoId == null || Comp) return;
    import('./StarChooserModal').then(m => setComp(() => m.StarChooserModal));
  }, [activeChooserVideoId, Comp]);
  if (!Comp) return null;
  return <Comp />;
}

/* ─────────────────────────────────────────────────────────────────
 *  StarButton — clicks now OPEN the chooser modal (the chooser
 *  handles Favourites + custom-niche memberships in one place).
 *  Visual state is driven by the Favourites set: filled amber when
 *  the video is in Favourites, hollow otherwise.
 * ──────────────────────────────────────────────────────────────── */
export function StarButton({ videoId, className = '' }: { videoId: number; className?: string }) {
  const { isStarred, openStarChooser } = useFavourites();
  const starred = isStarred(videoId);
  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); openStarChooser(videoId); }}
      title={starred ? 'Manage saves for this video' : 'Save this video'}
      className={`w-6 h-6 rounded-full flex items-center justify-center transition flex-shrink-0 ${
        starred
          ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
          : 'bg-[#1f1f1f] text-[#888] hover:bg-[#2a2a2a] hover:text-white'
      } ${className}`}
    >
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={starred ? 'currentColor' : 'none'} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
      </svg>
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  NicheStarButton — direct toggle, no chooser (custom niches
 *  collect VIDEOS, not clusters). Pill-shaped to sit next to the
 *  green Similar button on the cluster card.
 * ──────────────────────────────────────────────────────────────── */
export function NicheStarButton({ clusterId, className = '' }: { clusterId: number; className?: string }) {
  const { isNicheStarred, toggleNicheStar } = useFavourites();
  const starred = isNicheStarred(clusterId);
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleNicheStar(clusterId); }}
      title={starred ? 'Remove niche from Favourites' : 'Add niche to Favourites'}
      className={`flex items-center gap-1 text-xs rounded-full px-2 py-0.5 transition flex-shrink-0 font-medium ${
        starred
          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30'
          : 'bg-[#1f1f1f] text-[#888] border border-[#2a2a2a] hover:bg-[#2a2a2a] hover:text-white hover:border-[#3a3a3a]'
      } ${className}`}
    >
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={starred ? 'currentColor' : 'none'} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
      </svg>
    </button>
  );
}
