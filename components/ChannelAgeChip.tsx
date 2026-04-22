'use client';

import React from 'react';

/**
 * Renders a channel age chip using first_upload_at when available
 * (the "real active age") with a fallback to creation age. If the channel
 * was dormant for >1 year between creation and first upload, appends a
 * ⚠ warning indicating aged/purchased channel. Hover reveals both dates.
 */

export interface ChannelAgeProps {
  createdAt?: string | Date | null;     // channel_created_at
  firstUploadAt?: string | Date | null; // first_upload_at (from niche_spy_channels)
  dormancyDays?: number | null;         // precomputed dormancy (first_upload - created)
  /** threshold for flagging as aged — default 365 days */
  agedThresholdDays?: number;
  /**
   * Which side of the chip the tooltip should anchor from. Default 'left'
   * (tooltip grows to the right of the chip). Pass 'right' when the chip
   * sits inside a narrow right-side panel — otherwise the 224-256px-wide
   * tooltip will be clipped by the panel's right edge or any ancestor with
   * overflow:hidden.
   */
  tooltipAlign?: 'left' | 'right';
}

function formatAge(days: number): string {
  if (days < 30) return `${days}d old`;
  if (days < 365) return `${Math.floor(days / 30)}mo old`;
  return `${(days / 365).toFixed(1)}yr old`;
}

/** Duration-only formatter — no "old" suffix, for use inside tooltip sentences
 *  like "Created X ago" where "old" would read awkwardly. */
function formatDuration(days: number): string {
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}yr`;
}

export function ChannelAgeChip({ createdAt, firstUploadAt, dormancyDays, agedThresholdDays = 365, tooltipAlign = 'left' }: ChannelAgeProps) {
  // Tailwind class switch for anchoring the tooltip. 'left-0' grows right,
  // 'right-0' grows left. Same width+content, only position differs.
  const tooltipAnchor = tooltipAlign === 'right' ? 'right-0' : 'left-0';
  const created = createdAt ? new Date(createdAt) : null;
  const firstUp = firstUploadAt ? new Date(firstUploadAt) : null;

  // Nothing to show if we don't have any date
  if (!created && !firstUp) return null;

  // Preference order for "active age":
  //   1. first_upload_at — precise (from Phase 3 uploads walk)
  //   2. channel_created_at — YouTube's official date
  // When Phase 3 is skipped (channel too large), we just show the creation
  // date. Clean and predictable; the ⚠ flag still surfaces aged channels
  // whenever both dates are present and diverge.
  const referenceDate = firstUp || created!;
  const ageDays = Math.floor((Date.now() - referenceDate.getTime()) / 86_400_000);

  // Derive dormancy if not passed in (and we have both dates)
  let dormancy = dormancyDays ?? null;
  if (dormancy === null && created && firstUp) {
    dormancy = Math.floor((firstUp.getTime() - created.getTime()) / 86_400_000);
  }
  const isAged = (dormancy ?? 0) > agedThresholdDays;

  const ageStr = formatAge(ageDays);
  const color = ageDays < 30 ? 'text-orange-400' : 'text-[#666]';
  const creationAgeDaysIfBoth = firstUp && created
    ? Math.floor((Date.now() - created.getTime()) / 86_400_000)
    : null;

  // YouTube's Data API sometimes returns a channel.snippet.publishedAt that's
  // NEWER than the channel's own earliest upload (seen on reactivated /
  // migrated / handle-changed channels). That's temporally impossible — a
  // channel can't exist after its first video. When we detect this, treat the
  // creation date as unreliable and hide it from the tooltip rather than
  // rendering nonsense like "Created 1mo ago / Active for 5.3yr".
  //
  // Tolerance: first_upload walker sometimes clips a few days off via paging
  // cursors, so allow a 30-day slack before flagging as inverted.
  const creationReliable =
    creationAgeDaysIfBoth == null
      ? false
      : creationAgeDaysIfBoth >= ageDays - 30;

  if (!isAged) {
    // Ordinary chip. If we have both first_upload AND creation dates AND they
    // agree, show a hover tooltip revealing the creation date alongside the
    // active age. If the creation date is garbage (newer than first upload),
    // fall through to the bare chip — no misleading tooltip.
    if (creationAgeDaysIfBoth != null && creationReliable) {
      return (
        <span className="relative group/age inline-flex items-center">
          <span className={`${color} cursor-help`}>📅 {ageStr}</span>
          <span className={`pointer-events-none absolute ${tooltipAnchor} top-full mt-1 w-56 p-2.5 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-[11px] text-[#ccc] leading-relaxed shadow-xl opacity-0 group-hover/age:opacity-100 transition-opacity z-50`}>
            <div>Active for <span className="text-white">{ageStr}</span> (first upload)</div>
            <div>Created <span className="text-white">{formatDuration(creationAgeDaysIfBoth)} ago</span></div>
          </span>
        </span>
      );
    }
    return <span className={color}>📅 {ageStr}</span>;
  }

  // Aged channel — active age + ⚠ with tooltip explaining the creation gap.
  // Only render the "Created" / "Dormant" lines when creation is reliable; an
  // inverted (created-after-first-upload) pair should never get the aged flag
  // in the first place, but guard here too.
  const creationAgeDays = created ? Math.floor((Date.now() - created.getTime()) / 86_400_000) : null;
  const dormancyHuman = dormancy != null
    ? (dormancy > 365 ? `${(dormancy / 365).toFixed(1)}yr` : `${Math.round(dormancy / 30)}mo`)
    : 'unknown';

  return (
    <span className="relative group/age inline-flex items-center gap-1">
      <span className={color}>📅 {ageStr}</span>
      <span className="text-amber-400 cursor-help" title="Aged channel — see hover">⚠</span>
      <span className={`pointer-events-none absolute ${tooltipAnchor} top-full mt-1 w-64 p-2.5 bg-[#0a0a0a] border border-amber-500/40 rounded-lg text-[11px] text-[#ccc] leading-relaxed shadow-xl opacity-0 group-hover/age:opacity-100 transition-opacity z-50`}>
        <div className="font-semibold text-amber-300 mb-1">Aged / reactivated channel</div>
        <div>Active for <span className="text-white">{ageStr}</span> (first upload)</div>
        {creationAgeDays != null && creationReliable && (
          <div>Created <span className="text-white">{formatDuration(creationAgeDays)} ago</span></div>
        )}
        {creationReliable && (
          <div className="mt-1 text-[#888]">Dormant for {dormancyHuman} between creation and first upload.</div>
        )}
      </span>
    </span>
  );
}
