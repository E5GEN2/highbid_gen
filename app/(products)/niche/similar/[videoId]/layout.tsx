'use client';

import React, { useMemo } from 'react';
import { useParams } from 'next/navigation';
import { SimilarProvider, useSimilar } from '@/components/SimilarProvider';
import { computeIndicators } from '@/components/OpportunityIndicators';
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

  // Live opportunity indicators — score-filtered to 80+ to match Insights tab.
  // Recomputes on every minSimilarity change so the user sees the numbers shift live.
  const scored = useMemo(() => filtered.filter(v => (v.score || 0) >= 80), [filtered]);
  const indicators = useMemo(() => {
    const dots = scored.map(v => ({
      s: v.subscriberCount || 0,
      v: v.viewCount || 0,
      a: v.channelCreatedAt
        ? Math.floor((Date.now() - new Date(v.channelCreatedAt).getTime()) / 86400000)
        : null,
    }));
    return { ...computeIndicators(dots), scoredCount: scored.length };
  }, [scored]);

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

      {/* Title row + min-match */}
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
              {filtered.length} of {all.length} match · {indicators.scoredCount} at score ≥ 80
            </div>
          )}
        </div>

        {/* Right column: min-match on top, live indicator pills below */}
        <div className="flex flex-col items-end gap-2">
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

          {/* Live opportunity pills — only show once we've got enough data */}
          {!loading && (
            <HeaderIndicatorPills
              disabled={indicators.scoredCount < 10}
              nos={indicators.nos}
              nosDisplay={indicators.nosDisplay}
              topLeftPct={indicators.topLeftPct}
              newcomerRate={indicators.newcomerRate}
              lowSubCeiling={indicators.lowSubCeiling}
              sampleSize={indicators.scoredCount}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Compact pill row for the header ─────────────────────────────
   Each pill: label + value, colored by band, hover tooltip explains
   the metric. "disabled" state is used when sample < 10.
   ───────────────────────────────────────────────────────────────── */

function HeaderIndicatorPills({
  disabled, nos, nosDisplay, topLeftPct, newcomerRate, lowSubCeiling, sampleSize,
}: {
  disabled: boolean;
  nos: number;
  nosDisplay: number;
  topLeftPct: number;
  newcomerRate: number;
  lowSubCeiling: number;
  sampleSize: number;
}) {
  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}K` : `${Math.round(n)}`;

  const pills: Array<{ label: string; value: string; band: 'green' | 'yellow' | 'red' | 'empty'; tooltip: React.ReactNode; align: 'left' | 'right' }> = [
    {
      label: 'OPP',
      value: disabled ? '—' : `${nosDisplay}`,
      band: disabled ? 'empty' : nos >= 1.3 ? 'green' : nos >= 1.0 ? 'yellow' : 'red',
      align: 'right',
      tooltip: disabled ? (
        <HeaderTooltipEmpty sample={sampleSize} />
      ) : (
        <>
          <div className="font-semibold text-white mb-1">Opportunity Score</div>
          <div>Median <code className="text-amber-400">log(views)/log(subs)</code> across score ≥ 80 videos. Higher = small creators get pushed.</div>
          <div className="mt-1.5 text-[#888]">Raw NOS: {nos.toFixed(2)} · {sampleSize} videos</div>
        </>
      ),
    },
    {
      label: 'TOP',
      value: disabled ? '—' : `${topLeftPct}%`,
      band: disabled ? 'empty' : topLeftPct >= 30 ? 'green' : topLeftPct >= 10 ? 'yellow' : 'red',
      align: 'right',
      tooltip: disabled ? (
        <HeaderTooltipEmpty sample={sampleSize} />
      ) : (
        <>
          <div className="font-semibold text-white mb-1">Top-Left Density</div>
          <div>% of videos with above-median views AND below-median subs.</div>
        </>
      ),
    },
    {
      label: 'NEW',
      value: disabled ? '—' : `${newcomerRate}%`,
      band: disabled ? 'empty' : newcomerRate >= 80 ? 'green' : newcomerRate >= 50 ? 'yellow' : 'red',
      align: 'right',
      tooltip: disabled ? (
        <HeaderTooltipEmpty sample={sampleSize} />
      ) : (
        <>
          <div className="font-semibold text-white mb-1">Newcomer Success</div>
          <div>Median views of channels &lt;6mo old, as % of overall median.</div>
        </>
      ),
    },
    {
      label: 'CEIL',
      value: disabled ? '—' : fmt(lowSubCeiling),
      band: disabled ? 'empty' : lowSubCeiling >= 500000 ? 'green' : lowSubCeiling >= 100000 ? 'yellow' : 'red',
      align: 'right',
      tooltip: disabled ? (
        <HeaderTooltipEmpty sample={sampleSize} />
      ) : (
        <>
          <div className="font-semibold text-white mb-1">Low-Sub Ceiling</div>
          <div>p90 views among channels with &lt;10K subs.</div>
        </>
      ),
    },
  ];

  return (
    <div className="flex items-center gap-1.5">
      {pills.map(p => (
        <HeaderPill key={p.label} label={p.label} value={p.value} band={p.band} tooltip={p.tooltip} />
      ))}
    </div>
  );
}

function HeaderTooltipEmpty({ sample }: { sample: number }) {
  return (
    <>
      <div className="font-semibold text-white mb-1">Not enough data</div>
      <div>Need at least 10 high-score videos to compute. Current: {sample}. Lower the min match to widen the pool.</div>
    </>
  );
}

function HeaderPill({
  label, value, band, tooltip,
}: {
  label: string;
  value: string;
  band: 'green' | 'yellow' | 'red' | 'empty';
  tooltip: React.ReactNode;
}) {
  const colors = {
    green:  'text-green-400 bg-green-500/10 border-green-500/20',
    yellow: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    red:    'text-red-400 bg-red-500/10 border-red-500/20',
    empty:  'text-[#555] bg-[#1a1a1a]/40 border-[#1f1f1f] border-dashed',
  };
  return (
    <div className="relative group/pill">
      <div className={`flex flex-col items-center justify-center rounded-md border px-2 py-1 min-w-[54px] cursor-help ${colors[band]}`}>
        <div className="text-[8px] uppercase tracking-wider opacity-70 leading-none">{label}</div>
        <div className="text-xs font-bold leading-tight mt-0.5">{value}</div>
      </div>
      {/* Anchor tooltip to the right so it never overflows past the page edge */}
      <div className="pointer-events-none absolute right-0 top-full mt-2 w-64 p-3 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-[11px] text-[#ccc] leading-relaxed shadow-xl opacity-0 group-hover/pill:opacity-100 transition-opacity z-50 text-left">
        {tooltip}
      </div>
    </div>
  );
}
