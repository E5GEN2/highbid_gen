'use client';

import React from 'react';

/**
 * Distribution bar chart — renders a 6/7-bucket histogram with the same visual
 * style used on the keyword Insights page. Buckets can be provided either
 * pre-aggregated (from the /api/niche-spy/distribution endpoint) or computed
 * client-side from a raw values array via makeSubsBuckets / makeViewsBuckets.
 */

export interface DistBucket { label: string; count: number; color: string; }

/* ── Bucket factories ──────────────────────────────────────────── */

const SUBS_BOUNDARIES: Array<{ label: string; test: (n: number) => boolean; color: string }> = [
  { label: '0',        test: n => n <= 0,                color: '#555'    },
  { label: '1-1K',     test: n => n > 0 && n < 1000,     color: '#888'    },
  { label: '1K-10K',   test: n => n >= 1000 && n < 10000, color: '#3b82f6' },
  { label: '10K-100K', test: n => n >= 10000 && n < 100000, color: '#8b5cf6' },
  { label: '100K-1M',  test: n => n >= 100000 && n < 1_000_000, color: '#f59e0b' },
  { label: '1M+',      test: n => n >= 1_000_000,        color: '#ef4444' },
];

const VIEWS_BOUNDARIES: Array<{ label: string; test: (n: number) => boolean; color: string }> = [
  { label: '0-100',     test: n => n < 100,                      color: '#555'    },
  { label: '100-1K',    test: n => n >= 100 && n < 1000,         color: '#888'    },
  { label: '1K-10K',    test: n => n >= 1000 && n < 10_000,      color: '#3b82f6' },
  { label: '10K-100K',  test: n => n >= 10_000 && n < 100_000,   color: '#8b5cf6' },
  { label: '100K-1M',   test: n => n >= 100_000 && n < 1_000_000, color: '#f59e0b' },
  { label: '1M-10M',    test: n => n >= 1_000_000 && n < 10_000_000, color: '#ef4444' },
  { label: '10M+',      test: n => n >= 10_000_000,              color: '#ec4899' },
];

function bucketize(values: number[], boundaries: typeof SUBS_BOUNDARIES): DistBucket[] {
  return boundaries.map(b => ({
    label: b.label,
    count: values.filter(b.test).length,
    color: b.color,
  }));
}

export function makeSubsBuckets(subs: number[]): DistBucket[] {
  return bucketize(subs, SUBS_BOUNDARIES);
}

export function makeViewsBuckets(views: number[]): DistBucket[] {
  return bucketize(views, VIEWS_BOUNDARIES);
}

/* ── Chart ─────────────────────────────────────────────────────── */

export function DistBars({
  title, unit, buckets,
}: {
  title: string;
  unit: string;
  buckets: DistBucket[];
}) {
  const maxCount = Math.max(...buckets.map(b => b.count));
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const barMaxH = 80;

  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-5 py-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-white">{title}</h3>
          <p className="text-[10px] text-[#666]">{total.toLocaleString()} {unit}</p>
        </div>
      </div>

      <div className="flex items-end gap-1">
        {buckets.map((b, i) => {
          const barH = maxCount > 0 ? Math.max((b.count / maxCount) * barMaxH, b.count > 0 ? 4 : 0) : 0;
          const sharePct = total > 0 ? Math.round((b.count / total) * 100) : 0;
          return (
            <div key={i} className="flex-1 flex flex-col items-center min-w-0">
              <div className="text-[10px] font-bold text-white mb-0.5">
                {b.count > 0 ? b.count.toLocaleString() : ''}
              </div>
              <div className="text-[9px] text-[#666] mb-1">
                {b.count > 0 ? `${sharePct}%` : ''}
              </div>
              <div className="w-full px-0.5" style={{ height: barMaxH }}>
                <div className="w-full h-full flex items-end">
                  <div
                    className="w-full rounded-t-sm"
                    style={{ height: barH, backgroundColor: b.color, opacity: 0.85 }}
                  />
                </div>
              </div>
              <div className="text-[9px] text-[#666] text-center mt-1 truncate w-full">{b.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DistBarsSkeleton({ title }: { title: string }) {
  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-5 py-4 animate-pulse">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-white">{title}</h3>
          <div className="h-3 w-24 bg-[#1f1f1f] rounded mt-1" />
        </div>
      </div>
      <div className="flex items-end gap-1" style={{ height: 130 }}>
        {[35, 55, 80, 65, 40, 20].map((h, i) => (
          <div key={i} className="flex-1 flex items-end">
            <div className="w-full rounded-t-sm bg-[#1f1f1f]" style={{ height: `${h}%` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-2">
        {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="h-2 w-8 bg-[#1f1f1f] rounded" />)}
      </div>
    </div>
  );
}
