'use client';

import React, { useMemo } from 'react';

/**
 * Opportunity Indicators — NOS, Top-Left Density, Newcomer Success, Low-Sub Ceiling
 * computed client-side from a set of video-level dots.
 *
 * The same 4-card layout is used on /niche/niches/[keyword]/insights and on
 * /niche/similar/[videoId], so it lives here as a shared component.
 */

export interface IndicatorDot {
  s: number;                 // subscriber count
  v: number;                 // view count
  a: number | null;          // channel age (days) — null if unknown
}

/* ── Stats helpers ─────────────────────────────────────────────── */

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

export function computeIndicators(dots: IndicatorDot[]) {
  if (dots.length === 0) {
    return { nos: 0, nosDisplay: 0, nosBand: 'n/a' as const, topLeftPct: 0, newcomerRate: 0, lowSubCeiling: 0, sampleSize: 0 };
  }

  // 1. NOS — median(log(views) / log(max(subs, 10)))
  // Floor subs at 10 to avoid blow-up for tiny channels.
  const ratios = dots
    .filter(d => d.v > 0 && d.s > 0)
    .map(d => Math.log10(d.v) / Math.log10(Math.max(d.s, 10)));
  const nos = median(ratios);
  // Normalize to 0-100 scale: NOS 0.5 → 0, 2.5 → 100
  const nosDisplay = Math.round(Math.max(0, Math.min(100, ((nos - 0.5) / 2.0) * 100)));
  const nosBand: 'high' | 'mid' | 'low' = nos >= 1.3 ? 'high' : nos >= 1.0 ? 'mid' : 'low';

  // 2. Top-Left density — % of videos with views > median AND subs < median
  const medViews = median(dots.map(d => d.v));
  const medSubs = median(dots.map(d => d.s));
  const topLeftCount = dots.filter(d => d.v > medViews && d.s < medSubs).length;
  const topLeftPct = Math.round((topLeftCount / dots.length) * 100);

  // 3. Newcomer success rate — median(views of channels <180d) / median(views of all)
  const newDots = dots.filter(d => d.a !== null && d.a < 180 && d.v > 0);
  const newMedViews = median(newDots.map(d => d.v));
  const newcomerRate = medViews > 0 ? Math.round((newMedViews / medViews) * 100) : 0;

  // 4. Low-Sub Ceiling — p90 views for channels under 10K subs
  const smallChannels = dots.filter(d => d.s > 0 && d.s < 10000 && d.v > 0);
  const lowSubCeiling = percentile(smallChannels.map(d => d.v), 90);

  return { nos, nosDisplay, nosBand, topLeftPct, newcomerRate, lowSubCeiling, sampleSize: dots.length };
}

/* ── Tooltip + card ────────────────────────────────────────────── */

function InfoIcon({ tooltip, align = 'center' }: { tooltip: React.ReactNode; align?: 'left' | 'center' | 'right' }) {
  const alignClass = align === 'left'
    ? 'left-0'
    : align === 'right'
      ? 'right-0'
      : 'left-1/2 -translate-x-1/2';
  return (
    <span className="relative inline-flex items-center group">
      <span className="w-4 h-4 rounded-full bg-[#1f1f1f] hover:bg-[#2a2a2a] text-[#888] hover:text-white text-[10px] flex items-center justify-center cursor-help transition">
        i
      </span>
      <span className={`pointer-events-none absolute ${alignClass} top-full mt-2 w-72 p-3 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-[11px] text-[#ccc] leading-relaxed shadow-xl opacity-0 group-hover:opacity-100 transition-opacity z-50`}>
        {tooltip}
      </span>
    </span>
  );
}

function IndicatorCard({
  label, value, sub, tooltip, accent, tooltipAlign = 'center',
}: {
  label: string;
  value: string;
  sub: string;
  tooltip: React.ReactNode;
  accent: 'green' | 'yellow' | 'red' | 'neutral';
  tooltipAlign?: 'left' | 'center' | 'right';
}) {
  const accentColors = {
    green: 'text-green-400',
    yellow: 'text-yellow-400',
    red: 'text-red-400',
    neutral: 'text-white',
  };
  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] text-[#888] uppercase tracking-wider">{label}</div>
        <InfoIcon tooltip={tooltip} align={tooltipAlign} />
      </div>
      <div className={`text-2xl font-bold ${accentColors[accent]}`}>{value}</div>
      <div className="text-[10px] text-[#666] mt-1">{sub}</div>
    </div>
  );
}

/* ── Main component ────────────────────────────────────────────── */

export function OpportunityIndicators({ dots }: { dots: IndicatorDot[] }) {
  const { nos, nosDisplay, nosBand, topLeftPct, newcomerRate, lowSubCeiling, sampleSize } = useMemo(
    () => computeIndicators(dots),
    [dots]
  );

  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}K` : `${Math.round(n)}`;

  const nosAccent = nosBand === 'high' ? 'green' : nosBand === 'mid' ? 'yellow' : 'red';
  const topLeftAccent = topLeftPct >= 30 ? 'green' : topLeftPct >= 10 ? 'yellow' : 'red';
  const newcomerAccent = newcomerRate >= 80 ? 'green' : newcomerRate >= 50 ? 'yellow' : 'red';
  const ceilingAccent = lowSubCeiling >= 500000 ? 'green' : lowSubCeiling >= 100000 ? 'yellow' : 'red';

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <IndicatorCard
        label="Opportunity Score"
        value={`${nosDisplay}`}
        sub={`raw NOS: ${nos.toFixed(2)} · ${sampleSize} videos`}
        accent={nosAccent}
        tooltipAlign="left"
        tooltip={
          <>
            <div className="font-semibold text-white mb-1">How hard is it to get views without many subs?</div>
            <div>For each video we compute <code className="text-amber-400">log(views) / log(subs)</code> and take the median. Higher = views outpace subs, meaning the algorithm pushes content from small creators.</div>
            <div className="mt-2 space-y-0.5">
              <div><span className="text-green-400">≥ 70</span> Green light — low barrier, high reward</div>
              <div><span className="text-yellow-400">40–70</span> Normal — views scale with subs</div>
              <div><span className="text-red-400">&lt; 40</span> Saturated — big channels dominate</div>
            </div>
          </>
        }
      />
      <IndicatorCard
        label="Top-Left Density"
        value={`${topLeftPct}%`}
        sub="videos punching above weight"
        accent={topLeftAccent}
        tooltipAlign="right"
        tooltip={
          <>
            <div className="font-semibold text-white mb-1">% of videos in the &quot;high views, low subs&quot; zone</div>
            <div>Counts videos with above-median views AND below-median subs — the top-left quadrant of the scatter.</div>
            <div className="mt-2 space-y-0.5">
              <div><span className="text-green-400">≥ 30%</span> Lots of underdog wins</div>
              <div><span className="text-yellow-400">10–30%</span> Healthy mix</div>
              <div><span className="text-red-400">&lt; 10%</span> Views and subs tightly coupled</div>
            </div>
          </>
        }
      />
      <IndicatorCard
        label="Newcomer Success"
        value={`${newcomerRate}%`}
        sub="new vs niche median views"
        accent={newcomerAccent}
        tooltipAlign="left"
        tooltip={
          <>
            <div className="font-semibold text-white mb-1">Will the algorithm give new channels a chance?</div>
            <div>Median views of channels under 6 months old, divided by the overall median. 100% means newcomers land in the same ballpark as veterans.</div>
            <div className="mt-2 space-y-0.5">
              <div><span className="text-green-400">≥ 80%</span> Algorithm doesn&apos;t care about age</div>
              <div><span className="text-yellow-400">50–80%</span> Established channels get a small bonus</div>
              <div><span className="text-red-400">&lt; 50%</span> Tough for new entrants</div>
            </div>
          </>
        }
      />
      <IndicatorCard
        label="Low-Sub Ceiling"
        value={fmt(lowSubCeiling)}
        sub="p90 views at <10K subs"
        accent={ceilingAccent}
        tooltipAlign="right"
        tooltip={
          <>
            <div className="font-semibold text-white mb-1">What&apos;s achievable before you have an audience?</div>
            <div>Top 10% of view counts among videos from channels with under 10K subscribers.</div>
            <div className="mt-2 space-y-0.5">
              <div><span className="text-green-400">≥ 500K</span> Videos can explode with a tiny channel</div>
              <div><span className="text-yellow-400">100K–500K</span> Solid upside per video</div>
              <div><span className="text-red-400">&lt; 100K</span> Slow, linear growth</div>
            </div>
          </>
        }
      />
    </div>
  );
}

export function OpportunityIndicatorsSkeleton() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[0, 1, 2, 3].map(i => (
        <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3 animate-pulse">
          <div className="h-2.5 w-24 bg-[#1f1f1f] rounded mb-3" />
          <div className="h-7 w-16 bg-[#1f1f1f] rounded mb-2" />
          <div className="h-2 w-32 bg-[#1f1f1f] rounded" />
        </div>
      ))}
    </div>
  );
}
