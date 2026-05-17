'use client';

import React, { useEffect, useState } from 'react';
import { NicheClusterCard, type ClusterCardData } from './NicheClusterCard';

/**
 * Popup that lists clusters semantically similar to the source cluster,
 * mixed across L1 + L2. Opened from a "Similar" pill on a
 * NicheClusterCard; backed by /api/niche-spy/clusters/[id]/similar
 * which runs cosine kNN over niche_tree_cluster_vectors.
 *
 * Reuses NicheClusterCard for the result rows so the popup items look
 * identical to the underlying page. The source card is rendered at the
 * top of the popup (above the results) so the user can compare what
 * they searched against vs the matches. Each result shows a "% match"
 * pill because the similarity field is populated on every row.
 *
 * Modal width matches the page container (`max-w-7xl`) so cards inside
 * the popup render at the same size as cards on /niche/niches.
 */

interface SimilarApiResponse {
  sourceClusterId: number;
  k: number;
  similar: ClusterCardData[];
  reason?: string;
}

export function SimilarNichesModal({
  sourceCluster,
  onClose,
}: {
  /** Full source cluster (or null when closed). Renders as the first
   *  card in the popup, then results are fetched by sourceCluster.id. */
  sourceCluster: ClusterCardData | null;
  onClose: () => void;
}) {
  const sourceClusterId = sourceCluster?.id ?? null;
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

  if (sourceCluster == null) return null;

  // Strip the similarity field from the source card so the "% match"
  // pill doesn't show on it (the source is the anchor, not a match).
  const sourceForCard: ClusterCardData = { ...sourceCluster, similarity: undefined };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm px-4 py-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-7xl bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#1f1f1f] sticky top-0 bg-[#0a0a0a] z-10">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">Similar niches</h2>
            <p className="text-xs text-[#888] mt-0.5 truncate">
              Cosine similarity over cluster signatures · mixed L1 + L2
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
          {/* Source niche — what the kNN is anchored to. Rendered with
              the same card component so the visual comparison is
              apples-to-apples with the result rows below. We don't
              pass onFindSimilar here because clicking it would just
              re-open the same popup. */}
          <div className="mb-4">
            <div className="text-[11px] text-[#666] uppercase tracking-wider mb-2 px-1">
              Source niche
            </div>
            <NicheClusterCard cluster={sourceForCard} />
          </div>

          {/* Results section header — clearly separates source from
              matches so the eye can scan the list without confusion. */}
          <div className="text-[11px] text-[#666] uppercase tracking-wider mb-2 px-1 mt-6">
            Similar matches
          </div>

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
