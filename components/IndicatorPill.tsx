'use client';

import React from 'react';
import { fmtYT } from '@/lib/format';

/**
 * Shared compact opportunity pill used on niche + sub-niche cards.
 *
 * Each card renders 4 of these (OPP / TOP / NEW / CEIL). When not enough data
 * (<10 high-score videos), render the dashed empty state via <IndicatorPillsEmpty />.
 *
 * Tooltips anchor top-aligned so they don't overflow card edges.
 */

type Band = 'green' | 'yellow' | 'red' | 'empty';

export interface OpportunityStats {
  sample: number;
  nos: number;
  nosDisplay: number;
  topLeftPct: number;
  newcomerRate: number;
  lowSubCeiling: number;
}

export function IndicatorPillsRow({ opportunity }: { opportunity: OpportunityStats | null }) {
  if (!opportunity) return <IndicatorPillsEmpty />;
  const { nos, nosDisplay, topLeftPct, newcomerRate, lowSubCeiling, sample } = opportunity;
  return (
    <div className="grid grid-cols-4 gap-1.5 mt-3 pt-3 border-t border-[#1f1f1f]">
      <IndicatorPill
        label="OPP"
        value={`${nosDisplay}`}
        band={nos >= 1.3 ? 'green' : nos >= 1.0 ? 'yellow' : 'red'}
        tooltip={
          <>
            <div className="font-semibold text-white mb-1">Opportunity Score</div>
            <div>Median of <code className="text-amber-400">log(views)/log(subs)</code> across high-score videos. Higher = small creators get pushed.</div>
            <div className="mt-1.5 text-[#888]">Raw NOS: {nos.toFixed(2)} · {sample} videos</div>
            <div className="mt-2 space-y-0.5">
              <div><span className="text-green-400">≥ 70</span> Low barrier, high reward</div>
              <div><span className="text-yellow-400">40–70</span> Normal — views scale with subs</div>
              <div><span className="text-red-400">&lt; 40</span> Saturated — big channels win</div>
            </div>
          </>
        }
      />
      <IndicatorPill
        label="TOP"
        value={`${topLeftPct}%`}
        band={topLeftPct >= 30 ? 'green' : topLeftPct >= 10 ? 'yellow' : 'red'}
        tooltip={
          <>
            <div className="font-semibold text-white mb-1">Top-Left Density</div>
            <div>% of videos with above-median views AND below-median subs — the goldmine quadrant of the scatter.</div>
            <div className="mt-2 space-y-0.5">
              <div><span className="text-green-400">≥ 30%</span> Lots of underdog wins</div>
              <div><span className="text-yellow-400">10–30%</span> Healthy mix</div>
              <div><span className="text-red-400">&lt; 10%</span> Views tightly coupled to subs</div>
            </div>
          </>
        }
      />
      <IndicatorPill
        label="NEW"
        value={`${newcomerRate}%`}
        band={newcomerRate >= 80 ? 'green' : newcomerRate >= 50 ? 'yellow' : 'red'}
        tooltip={
          <>
            <div className="font-semibold text-white mb-1">Newcomer Success</div>
            <div>Median views of channels &lt;6 months old, divided by the overall median.</div>
            <div className="mt-2 space-y-0.5">
              <div><span className="text-green-400">≥ 80%</span> Age doesn&apos;t matter</div>
              <div><span className="text-yellow-400">50–80%</span> Small established-channel bonus</div>
              <div><span className="text-red-400">&lt; 50%</span> Tough for new entrants</div>
            </div>
          </>
        }
      />
      <IndicatorPill
        label="CEIL"
        value={fmtYT(lowSubCeiling)}
        band={lowSubCeiling >= 500000 ? 'green' : lowSubCeiling >= 100000 ? 'yellow' : 'red'}
        tooltip={
          <>
            <div className="font-semibold text-white mb-1">Low-Sub Ceiling</div>
            <div>p90 of views among videos from channels with &lt;10K subs.</div>
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

export function IndicatorPillsEmpty() {
  return (
    <div className="grid grid-cols-4 gap-1.5 mt-3 pt-3 border-t border-[#1f1f1f]">
      {(['OPP', 'TOP', 'NEW', 'CEIL'] as const).map(label => (
        <IndicatorPill
          key={label}
          label={label}
          value="—"
          band="empty"
          tooltip={
            <>
              <div className="font-semibold text-white mb-1">Not enough data yet</div>
              <div>Opportunity indicators need at least 10 high-score videos (score ≥ 80). Keep collecting and they&apos;ll populate automatically.</div>
            </>
          }
        />
      ))}
    </div>
  );
}

export function IndicatorPill({
  label, value, band, tooltip,
}: {
  label: string;
  value: string;
  band: Band;
  tooltip: React.ReactNode;
}) {
  const colors = {
    green:  'text-green-400 bg-green-500/10 border-green-500/20',
    yellow: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    red:    'text-red-400 bg-red-500/10 border-red-500/20',
    empty:  'text-[#555] bg-[#1a1a1a]/40 border-[#1f1f1f] border-dashed',
  };
  return (
    <div
      className="relative group/pill"
      onClick={(e) => { e.stopPropagation(); }}
    >
      <div className={`flex flex-col items-center justify-center rounded-md border px-1.5 py-1 cursor-help ${colors[band]}`}>
        <div className="text-[8px] uppercase tracking-wider opacity-70">{label}</div>
        <div className="text-xs font-bold leading-tight">{value}</div>
      </div>
      <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 p-3 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-[11px] text-[#ccc] leading-relaxed shadow-xl opacity-0 group-hover/pill:opacity-100 transition-opacity z-50 text-left">
        {tooltip}
      </div>
    </div>
  );
}
