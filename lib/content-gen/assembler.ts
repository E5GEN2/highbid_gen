/**
 * Listicle-draft assembly for the content-gen pipeline.
 *
 * Takes the channels surfaced by discoverChannels() and packages them
 * into "drafts" — each draft = one suggested listicle video.
 *
 * Two modes:
 *   - MIXED  → distinct effective niches across the whole pool.
 *              effective niche = L2 if the channel's top video has one,
 *              else L1. Money Groot's reference video is in this format.
 *              We produce up to 5 mixed rotations with different
 *              framings (top picks / hidden gems / fresh breakouts /
 *              high virality / most novel) — each rotation EXCLUDES the
 *              channels picked by earlier rotations, so the user gets
 *              actually different lists, not the same channels shuffled.
 *   - THEMED → all items share one L1 parent, distinct L2 sub-niches
 *              inside. One card per L1 that has ≥N L2 sub-niches with
 *              viable channels.
 */

import type { DiscoveryCandidate } from './discovery';

export interface ListicleDraftItem {
  candidate: DiscoveryCandidate;
  niche_label: string | null;
  niche_level: 1 | 2;
  niche_cluster_id: number;
}

export interface ListicleDraft {
  id: string;
  title: string;
  framing: string;
  mode: 'mixed' | 'themed';
  parent_l1_label?: string | null;
  parent_l1_cluster_id?: number | null;
  items: ListicleDraftItem[];
  scale_mix: { small: number; mid: number; big: number };
}

/**
 * Effective niche: L2 if available, else L1. The unit treated as
 * distinct in mixed mode.
 */
export function effectiveNiche(c: DiscoveryCandidate): { id: number; label: string | null; level: 1 | 2 } | null {
  if (c.showcase_clusters.l2) {
    return {
      id:    c.showcase_clusters.l2.cluster_id,
      label: c.showcase_clusters.l2.cluster_label,
      level: 2,
    };
  }
  if (c.showcase_clusters.l1) {
    return {
      id:    c.showcase_clusters.l1.cluster_id,
      label: c.showcase_clusters.l1.cluster_label,
      level: 1,
    };
  }
  return null;
}

function scaleMix(items: ListicleDraftItem[]): ListicleDraft['scale_mix'] {
  return {
    small: items.filter(i => i.candidate.subscriber_count <  100_000).length,
    mid:   items.filter(i => i.candidate.subscriber_count >= 100_000 && i.candidate.subscriber_count < 1_000_000).length,
    big:   items.filter(i => i.candidate.subscriber_count >= 1_000_000).length,
  };
}

function pickDistinct(
  pool: DiscoveryCandidate[],
  n: number,
  excludeChannelIds: Set<string>,
  excludeNicheIds: Set<number> = new Set(),
): ListicleDraftItem[] {
  const seenNiches = new Set<number>(excludeNicheIds);
  const items: ListicleDraftItem[] = [];
  for (const c of pool) {
    if (excludeChannelIds.has(c.channel_id)) continue;
    const en = effectiveNiche(c);
    if (!en) continue;
    if (seenNiches.has(en.id)) continue;
    seenNiches.add(en.id);
    items.push({
      candidate:        c,
      niche_label:      en.label,
      niche_level:      en.level,
      niche_cluster_id: en.id,
    });
    if (items.length === n) break;
  }
  return items;
}

interface RotationSpec {
  id: string;
  title: (n: number) => string;
  framing: string;
  sorter: (a: DiscoveryCandidate, b: DiscoveryCandidate) => number;
  filter?: (c: DiscoveryCandidate) => boolean;
}

const MIXED_ROTATIONS: RotationSpec[] = [
  {
    id: 'top-picks',
    title: (n) => `Top ${n} Faceless YouTube Niches`,
    framing: 'Highest composite score · one channel per distinct niche',
    sorter: (a, b) => b.composite_score - a.composite_score,
  },
  {
    id: 'high-virality',
    title: (n) => `Top ${n} Faceless Channels Going Viral`,
    framing: 'Sorted by views-to-subs ratio · channels the algorithm is pushing hardest',
    sorter: (a, b) => b.views_to_subs_ratio - a.views_to_subs_ratio,
  },
  {
    id: 'fresh-breakouts',
    title: (n) => `Top ${n} Brand-New Faceless Channels Blowing Up`,
    framing: 'Channels under 6 months old · the early-discovery edge over manual researchers',
    filter: (c) => c.channel_age_days <= 180,
    sorter: (a, b) => a.channel_age_days - b.channel_age_days || b.composite_score - a.composite_score,
  },
  {
    id: 'hidden-gems',
    title: (n) => `Top ${n} Hidden Faceless Niches`,
    framing: 'Smaller channels (<100K subs) · catch them before they blow up',
    filter: (c) => c.subscriber_count < 100_000,
    sorter: (a, b) => b.composite_score - a.composite_score,
  },
  {
    id: 'most-novel',
    title: (n) => `Top ${n} Most Unique Faceless Niches`,
    framing: 'Sorted by embedding novelty · channels in geometrically-isolated topic space',
    sorter: (a, b) => (b.novelty_score ?? 0) - (a.novelty_score ?? 0),
  },
];

/**
 * Mixed-mode drafts with cross-rotation deduplication. Each rotation
 * skips channels already picked by earlier ones, so the lists are
 * actually distinct instead of "same top channels in different orders".
 */
export function assembleMixedDrafts(
  candidates: DiscoveryCandidate[],
  n: number,
  rotations: RotationSpec[] = MIXED_ROTATIONS,
): ListicleDraft[] {
  if (candidates.length === 0) return [];
  const usedChannelIds = new Set<string>();
  const drafts: ListicleDraft[] = [];

  for (const rot of rotations) {
    const pool = (rot.filter ? candidates.filter(rot.filter) : candidates).slice().sort(rot.sorter);
    const items = pickDistinct(pool, n, usedChannelIds);
    // Allow shorter drafts when pool depletes — caller can decide if it
    // wants to skip too-small ones. Minimum 5 to be meaningful.
    if (items.length < 5) continue;
    for (const it of items) usedChannelIds.add(it.candidate.channel_id);
    drafts.push({
      id:      `mixed-${rot.id}`,
      title:   rot.title(items.length),
      framing: rot.framing,
      mode:    'mixed',
      items,
      scale_mix: scaleMix(items),
    });
  }
  return drafts;
}

/**
 * Themed-mode drafts: one per L1 with ≥N distinct L2 sub-niches that
 * each have at least one viable channel.
 */
export function assembleThemedDrafts(
  candidates: DiscoveryCandidate[],
  n: number,
  l1Labels: Map<number, string | null>,
): ListicleDraft[] {
  const byL1 = new Map<number, DiscoveryCandidate[]>();
  for (const c of candidates) {
    const l1 = c.showcase_clusters.l1;
    if (!l1) continue;
    if (!byL1.has(l1.cluster_id)) byL1.set(l1.cluster_id, []);
    byL1.get(l1.cluster_id)!.push(c);
  }

  const drafts: ListicleDraft[] = [];
  for (const [l1Id, pool] of byL1.entries()) {
    const byL2 = new Map<number, DiscoveryCandidate[]>();
    const l2Labels = new Map<number, string | null>();
    for (const c of pool) {
      const l2 = c.showcase_clusters.l2;
      if (!l2) continue;
      if (!byL2.has(l2.cluster_id)) byL2.set(l2.cluster_id, []);
      byL2.get(l2.cluster_id)!.push(c);
      l2Labels.set(l2.cluster_id, l2.cluster_label);
    }
    if (byL2.size < Math.min(n, 5)) continue;

    const items: ListicleDraftItem[] = Array.from(byL2.entries())
      .map(([l2Id, cs]) => ({
        l2Id,
        candidate: cs.slice().sort((a, b) => b.composite_score - a.composite_score)[0],
        label:     l2Labels.get(l2Id) ?? null,
      }))
      .sort((a, b) => b.candidate.composite_score - a.candidate.composite_score)
      .slice(0, n)
      .map(({ l2Id, label, candidate }) => ({
        candidate,
        niche_label:      label,
        niche_level:      2 as const,
        niche_cluster_id: l2Id,
      }));

    const l1Label = l1Labels.get(l1Id) ?? null;
    drafts.push({
      id:                  `themed-l1-${l1Id}`,
      title:               l1Label
        ? `Top ${items.length} ${l1Label} channels`
        : `Top ${items.length} channels in L1 cluster #${l1Id}`,
      framing:             `Specialty listicle · all under L1 ${l1Label || `cluster ${l1Id}`}`,
      mode:                'themed',
      parent_l1_label:     l1Label,
      parent_l1_cluster_id: l1Id,
      items,
      scale_mix:           scaleMix(items),
    });
  }

  drafts.sort((a, b) => {
    const sumA = a.items.reduce((s, x) => s + x.candidate.composite_score, 0);
    const sumB = b.items.reduce((s, x) => s + x.candidate.composite_score, 0);
    return sumB - sumA;
  });
  return drafts;
}

/**
 * Quick overlap audit across a set of drafts — how many channels appear
 * in multiple drafts, how big the unique pool is, etc. Used by the
 * overwatch endpoint to verify cross-rotation dedup is actually working.
 */
export function auditDrafts(drafts: ListicleDraft[]): {
  total_drafts: number;
  total_items: number;
  distinct_channels: number;
  distinct_niches: number;
  duplicate_channel_ids: string[];
  draft_summaries: Array<{
    id: string;
    title: string;
    mode: 'mixed' | 'themed';
    item_count: number;
    distinct_niches: number;
    scale_mix: { small: number; mid: number; big: number };
    channel_ids: string[];
  }>;
} {
  const channelCounter = new Map<string, number>();
  const allNiches = new Set<number>();
  const draftSummaries: ReturnType<typeof auditDrafts>['draft_summaries'] = [];

  for (const d of drafts) {
    const niches = new Set<number>();
    for (const it of d.items) {
      channelCounter.set(it.candidate.channel_id, (channelCounter.get(it.candidate.channel_id) ?? 0) + 1);
      niches.add(it.niche_cluster_id);
      allNiches.add(it.niche_cluster_id);
    }
    draftSummaries.push({
      id:             d.id,
      title:          d.title,
      mode:           d.mode,
      item_count:     d.items.length,
      distinct_niches: niches.size,
      scale_mix:      d.scale_mix,
      channel_ids:    d.items.map(i => i.candidate.channel_id),
    });
  }

  const duplicates = Array.from(channelCounter.entries())
    .filter(([, c]) => c > 1)
    .map(([id]) => id);
  return {
    total_drafts:          drafts.length,
    total_items:           drafts.reduce((s, d) => s + d.items.length, 0),
    distinct_channels:     channelCounter.size,
    distinct_niches:       allNiches.size,
    duplicate_channel_ids: duplicates,
    draft_summaries:       draftSummaries,
  };
}
