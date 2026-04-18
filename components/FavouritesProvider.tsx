'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Favourites — single global starred-video set. Any component can read the
 * current set (via `isStarred(id)`) or flip an id (via `toggleStar(id)`).
 * Backed by /api/niche-spy/favourites — optimistic local update on toggle,
 * then server sync. A full re-fetch runs on mount so the sidebar + star
 * states stay in sync across tab navigation and hard refresh.
 */

interface FavouritesContextType {
  ids: Set<number>;
  isStarred: (videoId: number) => boolean;
  toggleStar: (videoId: number) => Promise<void>;
  count: number;
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
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/niche-spy/favourites?onlyIds=1');
      const data = await res.json();
      setIds(new Set<number>(data.ids || []));
    } catch { /* ignore — empty state is fine */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const isStarred = useCallback((videoId: number) => ids.has(videoId), [ids]);

  const toggleStar = useCallback(async (videoId: number) => {
    // Optimistic flip so the star reacts instantly
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

  const value = useMemo(() => ({
    ids, isStarred, toggleStar, count: ids.size, loading, refresh,
  }), [ids, isStarred, toggleStar, loading, refresh]);

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
