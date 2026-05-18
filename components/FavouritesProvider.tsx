'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Favourites — two parallel global starred sets: one for videos
 * (the original /api/niche-spy/favourites surface) and one for
 * niches/clusters (/api/niche-spy/favourite-niches, added later).
 *
 * Both behave the same: optimistic local update on toggle, then
 * server sync, with rollback on failure. A full re-fetch on mount
 * keeps sidebar counts + star states consistent across navigation
 * and hard refresh.
 *
 * Components consume the relevant pair:
 *   - Video cards   → `useFavourites().isStarred / toggleStar`
 *   - Niche cards   → `useFavourites().isNicheStarred / toggleNicheStar`
 */

interface FavouritesContextType {
  ids: Set<number>;
  nicheIds: Set<number>;
  isStarred: (videoId: number) => boolean;
  isNicheStarred: (clusterId: number) => boolean;
  toggleStar: (videoId: number) => Promise<void>;
  toggleNicheStar: (clusterId: number) => Promise<void>;
  count: number;
  nicheCount: number;
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
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    // Pull video + niche favourite ids in parallel — keeps initial
    // mount cheap and the two sets never race.
    try {
      const [vRes, nRes] = await Promise.all([
        fetch('/api/niche-spy/favourites?onlyIds=1').then(r => r.json()).catch(() => ({ ids: [] })),
        fetch('/api/niche-spy/favourite-niches?onlyIds=1').then(r => r.json()).catch(() => ({ ids: [] })),
      ]);
      setIds(new Set<number>(vRes.ids || []));
      setNicheIds(new Set<number>(nRes.ids || []));
    } catch { /* ignore — empty state is fine */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const isStarred = useCallback((videoId: number) => ids.has(videoId), [ids]);
  const isNicheStarred = useCallback((clusterId: number) => nicheIds.has(clusterId), [nicheIds]);

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
      // Roll back on failure
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

  const value = useMemo(() => ({
    ids, nicheIds,
    isStarred, isNicheStarred,
    toggleStar, toggleNicheStar,
    count: ids.size, nicheCount: nicheIds.size,
    loading, refresh,
  }), [ids, nicheIds, isStarred, isNicheStarred, toggleStar, toggleNicheStar, loading, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Small star button for video cards. Hollow when unstarred, filled amber
 *  when starred. onClick stops propagation so parents (like a card-wide
 *  click handler) don't trigger. */
export function StarButton({ videoId, className = '' }: { videoId: number; className?: string }) {
  const { isStarred, toggleStar } = useFavourites();
  const starred = isStarred(videoId);
  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleStar(videoId); }}
      title={starred ? 'Remove from Favourites' : 'Add to Favourites'}
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

/** Star button for niche / cluster cards. Pill-shaped to sit next to
 *  the green "Similar" button on each card (same height + roundness).
 *  Same colour language as StarButton — hollow when unstarred, filled
 *  amber when starred. Stops propagation so the card-wide click
 *  handler doesn't fire when the button is hit. */
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
