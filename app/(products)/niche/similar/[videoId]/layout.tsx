'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { SimilarProvider, useSimilar } from '@/components/SimilarProvider';
import Link from 'next/link';

/**
 * Layout for /niche/similar/[videoId]/* — wraps the page in SimilarProvider
 * and renders the shared header (source title + back button + min-match).
 * The tabs themselves are rendered in the product sidebar for consistency
 * with the keyword niche pages.
 */
export default function SimilarLayout({ children }: { children: React.ReactNode }) {
  const { videoId: raw } = useParams<{ videoId: string }>();
  const videoId = parseInt(raw);
  if (!videoId) return <div className="px-8 py-8 text-red-400">Invalid video id</div>;

  return (
    <SimilarProvider videoId={videoId}>
      <SimilarHeader />
      {children}
    </SimilarProvider>
  );
}

/* ── Sticky header with source title, back button, and min-match selector ── */

function SimilarHeader() {
  const { source, all, filtered, minSimilarity, setMinSimilarity, loading } = useSimilar();

  const backHref = source?.keyword
    ? `/niche/niches/${encodeURIComponent(source.keyword)}/videos`
    : '/niche/niches';
  const backLabel = source?.keyword ? `Back to "${source.keyword}"` : 'Back to niches';

  return (
    <div className="px-8 pt-6 pb-2 max-w-7xl mx-auto">
      {/* Back link */}
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 text-xs text-[#888] hover:text-white transition mb-3"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        {backLabel}
      </Link>

      {/* Title row */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Semantic cluster</div>
          <h1 className="text-lg font-bold text-white leading-tight mb-1">
            {loading ? (
              <span className="inline-block h-5 w-80 bg-[#1f1f1f] rounded animate-pulse" />
            ) : source ? (
              <>Similar to: <span className="text-purple-400">{source.title}</span></>
            ) : (
              <span className="text-[#888]">Video not found</span>
            )}
          </h1>
          {!loading && all.length > 0 && (
            <div className="text-xs text-[#888]">
              {filtered.length} of {all.length} match the similarity threshold
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-[#888]">Min match:</label>
          <select
            value={minSimilarity}
            onChange={e => setMinSimilarity(parseFloat(e.target.value))}
            disabled={loading}
            className="bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded px-2 py-1 focus:outline-none focus:border-amber-500 disabled:opacity-50"
          >
            <option value={0}>All</option>
            <option value={0.5}>50%+</option>
            <option value={0.6}>60%+</option>
            <option value={0.7}>70%+</option>
            <option value={0.8}>80%+</option>
            <option value={0.9}>90%+</option>
            <option value={0.95}>95%+</option>
          </select>
        </div>
      </div>
    </div>
  );
}
