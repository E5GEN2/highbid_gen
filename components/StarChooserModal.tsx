'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useFavourites } from './FavouritesProvider';

/**
 * Modal popped open by any video star button. Lets the user choose
 * where the video goes: Favourites (the global starred list) and/or
 * any custom niche (user-curated collection). Pre-checks both based
 * on current memberships.
 *
 * Layout:
 *   ┌──────────────────────┐
 *   │ Save this video   ×  │
 *   ├──────────────────────┤
 *   │ ⭐ Favourites    [✓] │
 *   │ ─────────────────────│
 *   │ My niches            │
 *   │ ☑ Productivity hacks │
 *   │ ☐ Cooking experiments│
 *   │ ─────────────────────│
 *   │ + New niche…         │
 *   ├──────────────────────┤
 *   │       [Cancel] [Save]│
 *   └──────────────────────┘
 *
 * Save flow:
 *   1. Toggle Favourites (POST/DELETE /api/niche-spy/favourites) if
 *      the checkbox state differs from the current ids set.
 *   2. Replace custom-niche memberships in one call to
 *      /api/niche-spy/custom-niches/membership.
 *   3. Optimistic updates inside the provider; modal closes after
 *      both calls return.
 */
export function StarChooserModal() {
  const {
    activeChooserVideoId, closeStarChooser,
    isStarred, toggleStar,
    customNiches, refreshCustomNiches, createCustomNiche,
  } = useFavourites();

  // null when closed; once opened we lazy-load membership.
  const [pickedFav, setPickedFav] = useState<boolean>(false);
  const [pickedNiches, setPickedNiches] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [error, setError] = useState<string | null>(null);

  const videoId = activeChooserVideoId;

  // Reset + fetch memberships every time the modal opens for a new
  // video. We trust the provider's ids set for Favourites state but
  // hit the membership endpoint for the per-video custom-niche list.
  useEffect(() => {
    if (videoId == null) return;
    setError(null);
    setShowCreate(false);
    setNewName('');
    setNewDesc('');
    setPickedFav(isStarred(videoId));
    setPickedNiches(new Set());
    setLoading(true);
    fetch(`/api/niche-spy/custom-niches/membership?videoId=${videoId}`)
      .then(r => r.json())
      .then(d => setPickedNiches(new Set<number>(d.customNicheIds || [])))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [videoId, isStarred]);

  // ESC closes — common popup affordance.
  useEffect(() => {
    if (videoId == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeStarChooser(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [videoId, closeStarChooser]);

  const handleToggleNiche = (nicheId: number) => {
    setPickedNiches(prev => {
      const next = new Set(prev);
      if (next.has(nicheId)) next.delete(nicheId); else next.add(nicheId);
      return next;
    });
  };

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) { setError('Give the niche a name'); return; }
    setError(null);
    const niche = await createCustomNiche(name, newDesc.trim() || undefined);
    if (!niche) { setError('Could not create the niche. Try again?'); return; }
    // Auto-select the newly created niche so the user can save
    // without an extra click.
    setPickedNiches(prev => new Set(prev).add(niche.id));
    setNewName(''); setNewDesc('');
    setShowCreate(false);
  }, [newName, newDesc, createCustomNiche]);

  const handleSave = async () => {
    if (videoId == null) return;
    setSaving(true);
    setError(null);
    try {
      // 1. Favourites: only fire a write if state changed.
      const wasFav = isStarred(videoId);
      if (pickedFav !== wasFav) {
        await toggleStar(videoId);
      }
      // 2. Custom niche memberships: send the full new set.
      await fetch('/api/niche-spy/custom-niches/membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, customNicheIds: [...pickedNiches] }),
      });
      // Refresh niche counts so My Niches reflects new totals.
      refreshCustomNiches();
      closeStarChooser();
    } catch {
      setError('Save failed. Try again?');
    } finally {
      setSaving(false);
    }
  };

  if (videoId == null) return null;

  const savedSomewhere = pickedFav || pickedNiches.size > 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4 py-8"
      onClick={closeStarChooser}
    >
      <div
        className="w-full max-w-md bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#1f1f1f]">
          <div>
            <h2 className="text-base font-semibold text-white">Save this video</h2>
            <p className="text-xs text-[#888] mt-0.5">
              Pick where it should live. You can be in multiple lists at once.
            </p>
          </div>
          <button
            type="button"
            onClick={closeStarChooser}
            className="text-[#888] hover:text-white text-2xl leading-none px-2"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
          {/* Favourites toggle row. Always at the top — fastest path
              for users who don't curate into niches yet. */}
          <Row
            checked={pickedFav}
            onClick={() => setPickedFav(v => !v)}
            label="Favourites"
            sublabel="The global starred list"
            accent="amber"
          />

          <div className="my-4 flex items-center gap-3">
            <div className="flex-1 h-px bg-[#1f1f1f]" />
            <span className="text-[10px] uppercase tracking-[0.12em] text-[#666] font-semibold">
              My niches
            </span>
            <div className="flex-1 h-px bg-[#1f1f1f]" />
          </div>

          {loading && (
            <div className="text-center py-6 text-xs text-[#666]">Loading memberships…</div>
          )}
          {!loading && customNiches.length === 0 && !showCreate && (
            <div className="text-center py-6 text-sm text-[#888]">
              No custom niches yet.<br />
              <button
                type="button"
                className="text-amber-400 hover:text-amber-300 mt-2"
                onClick={() => setShowCreate(true)}
              >
                + Create your first niche
              </button>
            </div>
          )}
          {!loading && customNiches.length > 0 && (
            <div className="space-y-1.5">
              {customNiches.map(n => (
                <Row
                  key={n.id}
                  checked={pickedNiches.has(n.id)}
                  onClick={() => handleToggleNiche(n.id)}
                  label={n.name}
                  sublabel={
                    n.videoCount === 0
                      ? 'empty'
                      : `${n.videoCount} ${n.videoCount === 1 ? 'video' : 'videos'}`
                  }
                  accent="emerald"
                />
              ))}
            </div>
          )}

          {/* Create-new flow — collapsed by default to keep the modal
              short. Expands inline. */}
          {!showCreate && customNiches.length > 0 && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="mt-3 w-full text-xs text-amber-400 hover:text-amber-300 py-2 border border-dashed border-amber-400/30 rounded-lg hover:bg-amber-400/5 transition"
            >
              + Create a new niche
            </button>
          )}
          {showCreate && (
            <div className="mt-4 p-3 rounded-lg bg-[#0f0f0f] border border-[#1f1f1f] space-y-2.5">
              <input
                type="text"
                placeholder="Niche name (e.g. Office burnout shorts)"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                maxLength={80}
                className="w-full px-3 py-2 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-white placeholder-[#555] focus:outline-none focus:border-amber-400/50"
                autoFocus
              />
              <input
                type="text"
                placeholder="Description (optional)"
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                maxLength={280}
                className="w-full px-3 py-2 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-white placeholder-[#555] focus:outline-none focus:border-amber-400/50"
              />
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleCreate}
                  className="px-3 py-1.5 text-xs font-semibold bg-amber-400 text-black rounded-md hover:bg-amber-300 transition"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCreate(false); setNewName(''); setNewDesc(''); }}
                  className="px-3 py-1.5 text-xs text-[#888] hover:text-white"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-[#1f1f1f]">
          {error
            ? <span className="text-xs text-red-400">{error}</span>
            : <span className="text-xs text-[#666]">{savedSomewhere ? 'Will save' : 'Will remove from all lists'}</span>
          }
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeStarChooser}
              className="px-3 py-1.5 text-sm text-[#888] hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-sm font-semibold bg-amber-400 text-black rounded-md hover:bg-amber-300 transition disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Row — single check item, used for both Favourites and each
 *  custom niche.
 * ──────────────────────────────────────────────────────────────── */
function Row({
  checked, onClick, label, sublabel, accent,
}: {
  checked: boolean; onClick: () => void;
  label: string; sublabel?: string;
  accent: 'amber' | 'emerald';
}) {
  const accentBg = accent === 'amber' ? 'bg-amber-400 border-amber-400' : 'bg-emerald-500 border-emerald-500';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition text-left ${
        checked
          ? 'bg-white/[0.04] border-white/[0.12]'
          : 'bg-transparent border-[#1f1f1f] hover:bg-white/[0.02] hover:border-white/[0.08]'
      }`}
    >
      <div className={`w-5 h-5 rounded-md flex items-center justify-center border transition flex-shrink-0 ${
        checked ? accentBg : 'bg-transparent border-[#3a3a3a]'
      }`}>
        {checked && (
          <svg className="w-3.5 h-3.5 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-white truncate">{label}</div>
        {sublabel && <div className="text-[11px] text-[#666] truncate mt-0.5">{sublabel}</div>}
      </div>
    </button>
  );
}
