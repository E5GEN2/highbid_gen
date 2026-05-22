'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { fmtYT } from '@/lib/format';

/**
 * "Set niche center" modal. The user picks one video from inside
 * the niche to designate as its centre — the canonical, most-
 * representative item. Saved as custom_niches.center_video_id and
 * used downstream to anchor similarity sorts inside the niche.
 *
 * Single-select (radio). A "Clear centre" button lets the user
 * unset a previously-chosen one.
 *
 * Mounted by the parent page; keyed by `open` so it unmounts after
 * close — keeps the picker state fresh each time it opens.
 */

interface VideoOption {
  id: number;
  title: string;
  url: string | null;
  thumbnail: string | null;
  view_count: number | null;
  channel_name: string | null;
  score: number | null;
}

export function SetNicheCenterModal({
  open, onClose, nicheId, nicheName, videos, currentCenterId, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  nicheId: number;
  nicheName: string;
  /** Videos currently inside this niche — the picker only allows
   *  selecting from them (the API enforces the same rule). */
  videos: VideoOption[];
  currentCenterId: number | null;
  /** Fired after a successful save with the new value (or null on
   *  clear). Parent should refetch the niche row. */
  onSaved: (centerId: number | null) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the modal opens. Default selection mirrors
  // the currently-saved centre so the user can see the previous
  // pick and either keep it, change it, or clear it.
  useEffect(() => {
    if (!open) return;
    setPicked(currentCenterId);
    setFilter('');
    setError(null);
  }, [open, currentCenterId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return videos;
    return videos.filter(v =>
      (v.title || '').toLowerCase().includes(q) ||
      (v.channel_name || '').toLowerCase().includes(q),
    );
  }, [videos, filter]);

  const save = async (next: number | null) => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/niche-spy/custom-niches/${nicheId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ centerVideoId: next }),
      });
      const d = await r.json() as { error?: string };
      if (!r.ok) { setError(d.error || `HTTP ${r.status}`); return; }
      onSaved(next);
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
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#1f1f1f]">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">Set the niche centre</h2>
            <p className="text-xs text-[#888] mt-0.5 truncate">
              Pick the most representative video for{' '}
              <span className="text-white">{nicheName}</span>.
              It anchors what this niche &quot;means&quot;.
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

        {/* Search bar */}
        <div className="px-5 py-3 border-b border-[#1f1f1f]">
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
          </div>
        </div>

        <div className="max-h-[55vh] overflow-y-auto">
          {videos.length === 0 && (
            <div className="text-center py-12 text-sm text-[#888]">
              This niche has no videos yet.
              <p className="text-xs text-[#666] mt-1">
                Add some videos first, then come back here to pick a centre.
              </p>
            </div>
          )}

          {videos.length > 0 && visible.length === 0 && (
            <div className="text-center py-12 text-sm text-[#888]">
              No videos match that filter.
            </div>
          )}

          {visible.length > 0 && (
            <div className="py-2">
              {visible.map(v => (
                <VideoOptionRow
                  key={v.id}
                  v={v}
                  selected={picked === v.id}
                  isCurrent={currentCenterId === v.id}
                  onSelect={() => setPicked(v.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-[#1f1f1f] flex-wrap">
          {error
            ? <span className="text-xs text-red-400">{error}</span>
            : <span className="text-xs text-[#666]">
                {picked == null
                  ? (currentCenterId == null ? 'Nothing selected' : 'No change')
                  : picked === currentCenterId
                    ? 'Same as current centre'
                    : 'New centre selected'}
              </span>
          }
          <div className="flex items-center gap-2">
            {currentCenterId != null && (
              <button
                type="button"
                onClick={() => save(null)}
                disabled={saving}
                className="px-3 py-1.5 text-sm text-red-400 border border-red-500/20 rounded-md hover:bg-red-500/10 transition disabled:opacity-50"
                title="Remove the niche centre"
              >
                Clear centre
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-[#888] hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => save(picked)}
              disabled={saving || picked == null || picked === currentCenterId}
              className="px-4 py-1.5 text-sm font-semibold bg-amber-400 text-black rounded-md hover:bg-amber-300 transition disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Set centre'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Single video row — radio-style single selection
 * ──────────────────────────────────────────────────────────────── */

function VideoOptionRow({
  v, selected, isCurrent, onSelect,
}: {
  v: VideoOption;
  selected: boolean;
  isCurrent: boolean;
  onSelect: () => void;
}) {
  const thumb = getThumb(v.url, v.thumbnail);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition border-b border-[#141414] last:border-b-0 ${
        selected ? 'bg-amber-500/5' : 'hover:bg-white/[0.02]'
      }`}
    >
      {/* Radio */}
      <div className={`w-5 h-5 rounded-full flex items-center justify-center border transition flex-shrink-0 ${
        selected ? 'border-amber-400 bg-amber-400/10' : 'border-[#3a3a3a]'
      }`}>
        {selected && <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />}
      </div>
      {/* Thumb */}
      <div className="relative w-16 h-9 rounded bg-[#1a1a1a] overflow-hidden flex-shrink-0">
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />
        )}
        {isCurrent && (
          <div className="absolute top-0 left-0 right-0 bg-amber-400 text-black text-[8px] font-bold text-center py-px">
            CURRENT
          </div>
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
