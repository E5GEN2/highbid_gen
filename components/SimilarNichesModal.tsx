'use client';

import React, { useEffect, useState } from 'react';
import { NicheClusterCard, type ClusterCardData } from './NicheClusterCard';

/**
 * Popup that lists clusters semantically similar to the source cluster,
 * mixed across L1 + L2. Opened from a "SIMILAR" icon-button on a
 * NicheClusterCard; backed by /api/niche-spy/clusters/[id]/similar
 * which runs cosine kNN over niche_tree_cluster_vectors.
 *
 * Reuses NicheClusterCard for the result rows so the popup items look
 * identical to the underlying page. Each result shows a "% match" pill
 * because the similarity field is populated on every row.
 */

interface SimilarApiResponse {
  sourceClusterId: number;
  k: number;
  similar: ClusterCardData[];
  reason?: string;
}

export function SimilarNichesModal({
  sourceClusterId,
  sourceLabel,
  onClose,
}: {
  sourceClusterId: number | null;
  /** Optional label to show in the modal header — gives the user
   *  context for which cluster the "similar" list is anchored to. */
  sourceLabel?: string | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ClusterCardData[]>([]);

  useEffect(() => {
    if (sourceClusterId == null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResults([]);
    (async () => {
      try {
        const r = await fetch(`/api/niche-spy/clusters/${sourceClusterId}/similar?k=12`);
        const d = await r.json() as SimilarApiResponse;
        if (cancelled) return;
        if (!r.ok) {
          setError((d as { error?: string }).error || `HTTP ${r.status}`);
          return;
        }
        setResults(d.similar || []);
        if (d.reason && (d.similar || []).length === 0) setError(d.reason);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceClusterId]);

  // ESC closes — common popup affordance.
  useEffect(() => {
    if (sourceClusterId == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sourceClusterId, onClose]);

  if (sourceClusterId == null) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm px-4 py-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#1f1f1f]">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">Similar niches</h2>
            <p className="text-xs text-[#888] mt-0.5 truncate">
              Cosine similarity over cluster signatures · mixed L1 + L2
              {sourceLabel && <> · source: <span className="text-[#bbb]">{sourceLabel}</span></>}
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

        <div className="p-4">
          {loading && (
            <div className="text-center py-12 text-sm text-[#666]">Loading similar niches…</div>
          )}
          {error && !loading && (
            <div className="text-center py-12 text-sm text-red-400">{error}</div>
          )}
          {!loading && !error && results.length === 0 && (
            <div className="text-center py-12 text-sm text-[#666]">No similar niches found.</div>
          )}
          {!loading && results.length > 0 && (
            <div className="space-y-3">
              {results.map(c => (
                <NicheClusterCard key={c.id} cluster={c} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
