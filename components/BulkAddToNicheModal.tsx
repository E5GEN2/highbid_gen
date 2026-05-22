'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useFavourites } from './FavouritesProvider';

/**
 * Bulk-add modal — drops N selected videos into a single custom
 * niche in one shot. Used by surfaces with a selection toolbar
 * (similarity results, semantic search, etc.).
 *
 * Pick from existing niches OR spin up a new one inline:
 *
 *   ┌──────────────────────────────┐
 *   │ Add 42 videos to a niche  ×  │
 *   ├──────────────────────────────┤
 *   │ Existing niches              │
 *   │ ○ Faceless YouTube Niches    │
 *   │ ○ Tech reviews               │
 *   │ ── or ─────────────────────  │
 *   │ ◉ Create new niche           │
 *   │ [name input]                 │
 *   │ [description optional]       │
 *   ├──────────────────────────────┤
 *   │       [Cancel] [Add 42 here] │
 *   └──────────────────────────────┘
 *
 * Both flows end with one POST to
 *   /api/niche-spy/custom-niches/[id]/videos
 * which is idempotent (ON CONFLICT DO NOTHING) so re-running with
 * overlapping ids is safe.
 */

type Pick = number | 'new' | null;

export function BulkAddToNicheModal({
  open, onClose, videoIds, onAdded,
}: {
  open: boolean;
  onClose: () => void;
  /** Selected videos. Server-side cap is 500 — the toolbar should
   *  enforce or chunk before calling if larger sets become a thing. */
  videoIds: number[];
  /** Fires after a successful add. Passes the niche id we wrote
   *  to so the caller can navigate or show a "go to niche" CTA. */
  onAdded: (nicheId: number, added: number) => void;
}) {
  const { customNiches, refreshCustomNiches, createCustomNiche } = useFavourites();

  const [picked, setPicked] = useState<Pick>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open so reopening doesn't carry stale state.
  useEffect(() => {
    if (!open) return;
    setPicked(customNiches.length > 0 ? null : 'new');
    setNewName('');
    setNewDesc('');
    setSaving(false);
    setError(null);
  }, [open, customNiches.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, saving, onClose]);

  const sorted = useMemo(
    () => [...customNiches].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [customNiches],
  );

  const canSave =
    !saving &&
    videoIds.length > 0 &&
    (
      (typeof picked === 'number') ||
      (picked === 'new' && newName.trim().length > 0)
    );

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      let targetId: number | null = null;
      if (picked === 'new') {
        const created = await createCustomNiche(newName.trim(), newDesc.trim() || undefined);
        if (!created) {
          setError('Could not create the niche. Try a different name?');
          setSaving(false);
          return;
        }
        targetId = created.id;
      } else if (typeof picked === 'number') {
        targetId = picked;
      }
      if (targetId == null) { setSaving(false); return; }

      const r = await fetch(`/api/niche-spy/custom-niches/${targetId}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoIds }),
      });
      const d = await r.json() as { added?: number; error?: string };
      if (!r.ok) {
        setError(d.error || `HTTP ${r.status}`);
        setSaving(false);
        return;
      }
      // Refresh the niche list so counts + updated_at ordering
      // reflect the new state next time the user navigates.
      refreshCustomNiches();
      onAdded(targetId, d.added ?? videoIds.length);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const niche = typeof picked === 'number' ? sorted.find(n => n.id === picked) : null;
  const targetLabel = picked === 'new'
    ? (newName.trim() || 'new niche')
    : niche?.name || 'a niche';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/70 backdrop-blur-sm px-4 py-8 overflow-y-auto"
      onClick={() => { if (!saving) onClose(); }}
    >
      <div
        className="w-full max-w-md bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#1f1f1f]">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">
              Add {videoIds.length} {videoIds.length === 1 ? 'video' : 'videos'} to a niche
            </h2>
            <p className="text-xs text-[#888] mt-0.5">
              Pick one of your custom niches, or spin up a new one.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-[#888] hover:text-white disabled:opacity-30 text-2xl leading-none px-2"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
          {/* Existing niches */}
          {sorted.length > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#666] font-semibold mb-2">
                Existing niches
              </div>
              <div className="space-y-1.5">
                {sorted.map(n => (
                  <RadioRow
                    key={n.id}
                    selected={picked === n.id}
                    onClick={() => setPicked(n.id)}
                    label={n.name}
                    sublabel={
                      n.videoCount === 0
                        ? 'empty'
                        : `${n.videoCount} ${n.videoCount === 1 ? 'video' : 'videos'}`
                    }
                  />
                ))}
              </div>

              <div className="my-4 flex items-center gap-3">
                <div className="flex-1 h-px bg-[#1f1f1f]" />
                <span className="text-[10px] uppercase tracking-[0.12em] text-[#666] font-semibold">or</span>
                <div className="flex-1 h-px bg-[#1f1f1f]" />
              </div>
            </>
          )}

          {/* Create new */}
          <RadioRow
            selected={picked === 'new'}
            onClick={() => setPicked('new')}
            label="Create a new niche"
            sublabel={
              picked === 'new'
                ? null
                : 'Give it a name and add the selection in one click'
            }
          />
          {picked === 'new' && (
            <div className="mt-3 p-3 rounded-lg bg-[#0f0f0f] border border-[#1f1f1f] space-y-2.5">
              <input
                type="text"
                placeholder="Niche name (e.g. Office burnout shorts)"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                maxLength={80}
                autoFocus
                className="w-full px-3 py-2 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-white placeholder-[#555] focus:outline-none focus:border-amber-400/50"
              />
              <input
                type="text"
                placeholder="Description (optional)"
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                maxLength={280}
                className="w-full px-3 py-2 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-white placeholder-[#555] focus:outline-none focus:border-amber-400/50"
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-[#1f1f1f]">
          {error
            ? <span className="text-xs text-red-400 line-clamp-1">{error}</span>
            : <span className="text-xs text-[#666] truncate">
                {videoIds.length > 0
                  ? `Adding to ${targetLabel}`
                  : 'Nothing selected'}
              </span>
          }
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-sm text-[#888] hover:text-white disabled:opacity-30"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="px-4 py-1.5 text-sm font-semibold bg-amber-400 text-black rounded-md hover:bg-amber-300 transition disabled:opacity-50"
            >
              {saving
                ? 'Adding…'
                : picked === 'new'
                  ? `Create & add ${videoIds.length}`
                  : `Add ${videoIds.length}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Radio row — single selection. Big hit-target.
 * ──────────────────────────────────────────────────────────────── */

function RadioRow({
  selected, onClick, label, sublabel,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  sublabel?: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition text-left ${
        selected
          ? 'bg-amber-500/[0.06] border-amber-500/30'
          : 'bg-transparent border-[#1f1f1f] hover:bg-white/[0.02] hover:border-white/[0.08]'
      }`}
    >
      <div className={`w-5 h-5 rounded-full flex items-center justify-center border transition flex-shrink-0 ${
        selected ? 'border-amber-400 bg-amber-400/15' : 'border-[#3a3a3a]'
      }`}>
        {selected && <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-white truncate">{label}</div>
        {sublabel && <div className="text-[11px] text-[#666] truncate mt-0.5">{sublabel}</div>}
      </div>
    </button>
  );
}
