'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtYT } from '@/lib/format';

/**
 * Bulk-add modal opened from a custom-niche detail page. Lists the
 * user's Favourites and lets them pick any number of videos to drop
 * into the current niche in one shot. Videos already in the niche
 * are hidden from the list so the modal only ever shows valid
 * additions.
 *
 * Mounted by the parent page (not the FavouritesProvider), keyed by
 * `open` so it unmounts after close — keeps the favourites fetch
 * fresh next time it opens.
 */

interface FavRow {
  id: number;
  title: string;
  url: string | null;
  thumbnail: string | null;
  view_count: number | null;
  channel_name: string | null;
  score: number | null;
  added_at: string;
}

export function AddFromFavouritesModal({
  open, onClose, nicheId, nicheName, existingVideoIds, onAdded,
}: {
  open: boolean;
  onClose: () => void;
  nicheId: number;
  nicheName: string;
  /** Videos already in this niche — pruned from the list so the
   *  user only sees fresh additions. */
  existingVideoIds: Set<number>;
  /** Fired after a successful save with the count actually added,
   *  so the parent can refresh its video grid. */
  onAdded: (added: number) => void;
}) {
  const [favs, setFavs] = useState<FavRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-fetch favourites every time the modal opens. Pulling on
  // mount-only would miss new stars the user might have just added.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setPicked(new Set());
    setFilter('');
    setLoading(true);
    fetch('/api/niche-spy/favourites')
      .then(r => r.json())
      .then((d: { videos?: FavRow[] }) => setFavs(d.videos || []))
      .catch(() => setError('Could not load favourites'))
      .finally(() => setLoading(false));
  }, [open]);

  // ESC closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Filter out videos already in the niche + apply search.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return favs
      .filter(v => !existingVideoIds.has(v.id))
      .filter(v =>
        !q
          ? true
          : (v.title || '').toLowerCase().includes(q) ||
            (v.channel_name || '').toLowerCase().includes(q),
      );
  }, [favs, existingVideoIds, filter]);

  const allVisibleSelected = visible.length > 0 && visible.every(v => picked.has(v.id));
  const someVisibleSelected = visible.some(v => picked.has(v.id));

  const toggleAllVisible = useCallback(() => {
    setPicked(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const v of visible) next.delete(v.id);
      } else {
        for (const v of visible) next.add(v.id);
      }
      return next;
    });
  }, [allVisibleSelected, visible]);

  const togglePick = (id: number) => {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    if (picked.size === 0) { onClose(); return; }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/niche-spy/custom-niches/${nicheId}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoIds: [...picked] }),
      });
      const d = await r.json() as { added?: number; error?: string };
      if (!r.ok) {
        setError(d.error || `HTTP ${r.status}`);
        return;
      }
      onAdded(d.added ?? 0);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/70 backdrop-blur-sm px-4 py-8 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#1f1f1f]">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">Add from Favourites</h2>
            <p className="text-xs text-[#888] mt-0.5 truncate">
              Pick videos from your starred list to add to{' '}
              <span className="text-white">{nicheName}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[#888] hover:text-white text-2xl leading-none px-2"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        {/* Search + select-all row — sticky at the top of the list */}
        <div className="px-5 py-3 border-b border-[#1f1f1f] bg-[#0a0a0a]">
          <div className="flex items-center gap-3">
            <div className="flex-1 relative">
              <svg className="w-3.5 h-3.5 text-[#666] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="7" />
                <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
              </svg>
              <input
                type="text"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Filter by title or channel…"
                className="w-full pl-9 pr-3 py-2 text-sm bg-[#0f0f0f] border border-[#1f1f1f] rounded-md text-white placeholder-[#555] focus:outline-none focus:border-amber-400/50"
              />
            </div>
            {visible.length > 0 && (
              <button
                type="button"
                onClick={toggleAllVisible}
                className="text-xs text-[#888] hover:text-white whitespace-nowrap"
              >
                {allVisibleSelected ? 'Clear' : `Select all (${visible.length})`}
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[55vh] overflow-y-auto">
          {loading && (
            <div className="text-center py-12 text-sm text-[#666]">Loading favourites…</div>
          )}

          {!loading && favs.length === 0 && (
            <div className="text-center py-12 text-sm text-[#888]">
              You haven&apos;t starred any videos yet.
              <p className="text-xs text-[#666] mt-1">
                Star a video first — then come back here to add it to a niche.
              </p>
            </div>
          )}

          {!loading && favs.length > 0 && visible.length === 0 && (
            <div className="text-center py-12 text-sm text-[#888]">
              {filter
                ? 'No favourites match that filter.'
                : 'All your starred videos are already in this niche.'}
            </div>
          )}

          {!loading && visible.length > 0 && (
            <div className="py-2">
              {visible.map(v => (
                <FavRowItem
                  key={v.id}
                  v={v}
                  checked={picked.has(v.id)}
                  onToggle={() => togglePick(v.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-[#1f1f1f]">
          {error
            ? <span className="text-xs text-red-400">{error}</span>
            : <span className="text-xs text-[#666]">
                {picked.size === 0
                  ? 'Nothing selected'
                  : `${picked.size} ${picked.size === 1 ? 'video' : 'videos'} selected`}
              </span>
          }
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-[#888] hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || picked.size === 0}
              className="px-4 py-1.5 text-sm font-semibold bg-amber-400 text-black rounded-md hover:bg-amber-300 transition disabled:opacity-50"
            >
              {saving
                ? 'Adding…'
                : picked.size === 0
                  ? 'Add'
                  : `Add ${picked.size}`}
            </button>
          </div>
        </div>
        {someVisibleSelected && null /* placeholder for future: bulk-actions hint */}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Row component — clickable area is the whole row for hit target.
 * ──────────────────────────────────────────────────────────────── */

function FavRowItem({
  v, checked, onToggle,
}: { v: FavRow; checked: boolean; onToggle: () => void }) {
  const thumb = getThumb(v.url, v.thumbnail);
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition border-b border-[#141414] last:border-b-0 ${
        checked ? 'bg-amber-500/5' : 'hover:bg-white/[0.02]'
      }`}
    >
      {/* Checkbox */}
      <div className={`w-5 h-5 rounded-md flex items-center justify-center border transition flex-shrink-0 ${
        checked ? 'bg-amber-400 border-amber-400' : 'bg-transparent border-[#3a3a3a]'
      }`}>
        {checked && (
          <svg className="w-3.5 h-3.5 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      {/* Thumb */}
      <div className="w-16 h-9 rounded bg-[#1a1a1a] overflow-hidden flex-shrink-0">
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />
        )}
      </div>
      {/* Meta */}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-white line-clamp-1">{v.title || '(untitled)'}</div>
        <div className="text-[11px] text-[#666] flex items-center gap-2 mt-0.5">
          {v.channel_name && <span className="truncate">{v.channel_name}</span>}
          {v.view_count != null && (
            <>
              <span>·</span>
              <span className="text-green-400/80">{fmtYT(v.view_count)}</span>
            </>
          )}
          {v.score != null && (
            <>
              <span>·</span>
              <span className={v.score >= 80 ? 'text-green-400' : v.score >= 50 ? 'text-yellow-400' : 'text-red-400'}>
                {v.score}
              </span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

function getThumb(url: string | null | undefined, fallback: string | null | undefined): string {
  if (!fallback || (fallback as string).includes('ytimg.com')) {
    const m = url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
  }
  return fallback || '';
}
