'use client';

import React from 'react';

/**
 * Renders a channel age chip using first_upload_at when available
 * (the "real active age") with a fallback to creation age. If the channel
 * was dormant for >1 year between creation and first upload, appends a
 * ⚠ warning indicating aged/purchased channel. Hover reveals both dates.
 */

export interface ChannelAgeProps {
  createdAt?: string | Date | null;    // channel_created_at
  firstUploadAt?: string | Date | null; // first_upload_at (from niche_spy_channels)
  /** The earliest video date we've ever scraped for this channel. Used as a
   *  lower bound for first_upload_at when the Phase 3 walk skipped the channel
   *  (videoCount > 200). Results in a much more accurate "active age" on
   *  big channels than falling back to creation age. */
  earliestVideoAt?: string | Date | null;
  dormancyDays?: number | null;         // precomputed dormancy (first_upload - created)
  /** threshold for flagging as aged — default 365 days */
  agedThresholdDays?: number;
}

function formatAge(days: number): string {
  if (days < 30) return `${days}d old`;
  if (days < 365) return `${Math.floor(days / 30)}mo old`;
  return `${(days / 365).toFixed(1)}yr old`;
}

export function ChannelAgeChip({ createdAt, firstUploadAt, earliestVideoAt, dormancyDays, agedThresholdDays = 365 }: ChannelAgeProps) {
  const created = createdAt ? new Date(createdAt) : null;
  const firstUp = firstUploadAt ? new Date(firstUploadAt) : null;
  const earliest = earliestVideoAt ? new Date(earliestVideoAt) : null;

  // Nothing to show if we don't have any date
  if (!created && !firstUp && !earliest) return null;

  // Preference order for "active age":
  //   1. first_upload_at — precise (from Phase 3 uploads walk)
  //   2. earliest_video_at — conservative lower bound (from our scraped data)
  //   3. channel_created_at — last resort (may be misleading — rebrand dates etc.)
  // earliestVideoAt wins over created even if we only have that two,
  // because "I have a 2024 video from this channel" beats "channel was
  // reported created 2 weeks ago".
  const referenceDate = firstUp || earliest || created!;
  const inferredFromEarliest = !firstUp && !!earliest;
  const ageDays = Math.floor((Date.now() - referenceDate.getTime()) / 86_400_000);

  // Derive dormancy if not passed in (and we have both dates)
  let dormancy = dormancyDays ?? null;
  if (dormancy === null && created && firstUp) {
    dormancy = Math.floor((firstUp.getTime() - created.getTime()) / 86_400_000);
  }
  const isAged = (dormancy ?? 0) > agedThresholdDays;

  const ageStr = formatAge(ageDays);
  const color = ageDays < 30 ? 'text-orange-400' : 'text-[#666]';

  // When we inferred active age from earliestVideoAt (not first_upload_at),
  // annotate subtly so the user knows it's a "≥ N" estimate.
  if (!isAged && inferredFromEarliest) {
    return (
      <span className="relative group/age inline-flex items-center gap-1">
        <span className={color}>📅 ≥{ageStr}</span>
        <span className="pointer-events-none absolute left-0 top-full mt-1 w-60 p-2.5 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-[11px] text-[#ccc] leading-relaxed shadow-xl opacity-0 group-hover/age:opacity-100 transition-opacity z-50">
          Lower bound: we&apos;ve tracked a video from this channel {ageStr} ago. True first-upload hasn&apos;t been detected yet (channel is too large for a full walk).
        </span>
      </span>
    );
  }

  if (!isAged) {
    // Ordinary chip — just the active age, no extra badge
    return <span className={color}>📅 {ageStr}</span>;
  }

  // Aged channel — active age + ⚠ with tooltip explaining the creation gap
  const creationAgeDays = created ? Math.floor((Date.now() - created.getTime()) / 86_400_000) : null;
  const dormancyHuman = dormancy != null
    ? (dormancy > 365 ? `${(dormancy / 365).toFixed(1)}yr` : `${Math.round(dormancy / 30)}mo`)
    : 'unknown';

  return (
    <span className="relative group/age inline-flex items-center gap-1">
      <span className={color}>📅 {ageStr}</span>
      <span className="text-amber-400 cursor-help" title="Aged channel — see hover">⚠</span>
      <span className="pointer-events-none absolute left-0 top-full mt-1 w-64 p-2.5 bg-[#0a0a0a] border border-amber-500/40 rounded-lg text-[11px] text-[#ccc] leading-relaxed shadow-xl opacity-0 group-hover/age:opacity-100 transition-opacity z-50">
        <div className="font-semibold text-amber-300 mb-1">Aged / reactivated channel</div>
        <div>Active for <span className="text-white">{ageStr}</span> (first upload)</div>
        {creationAgeDays != null && (
          <div>Created <span className="text-white">{formatAge(creationAgeDays)}</span></div>
        )}
        <div className="mt-1 text-[#888]">Dormant for {dormancyHuman} between creation and first upload.</div>
      </span>
    </span>
  );
}
