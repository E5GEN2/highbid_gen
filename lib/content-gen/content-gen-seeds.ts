/**
 * Content-Gen priority seeds — the bridge from the Content Gen draft cards to
 * the niche-spy scheduler.
 *
 * Each channel shown in a draft card is researched (deeper) by running a
 * niche-spy crawl seeded from its TOP VIDEO. These seeds take PRIORITY over the
 * novelty blue-ocean seeds (the scheduler drains them exclusively first).
 *
 *   - getContentGenSeedChannels() enumerates the distinct channels across the
 *     current mixed drafts (the visible cards), each → its top video seed.
 *   - getUnspiedContentGenSeeds() filters to the ones not yet in the ledger.
 *   - getDraftSpyStatuses() computes the per-group "fully spied" badge.
 *
 * "Used" channels (consumed into a produced video) are already excluded by
 * discoverChannels(), so a used group disappears and a fresh one replaces it.
 */

import { getPool } from '../db';
import { discoverChannels } from './discovery';
import { assembleMixedDrafts, type ListicleDraft } from './assembler';

export interface ContentGenSeed {
  channel_id: string;
  channel_name: string;
  top_video_id: number;
  top_video_url: string;
  top_video_title: string | null;
  draft_id: string;
  draft_title: string;
}

const N_PER_DRAFT = 10;
const TOPK = 300;

/**
 * Distinct channels across the current mixed drafts → their top-video seeds.
 * First draft a channel appears in wins the attribution (drafts dedup channels
 * across rotations anyway, so this is mostly cosmetic).
 */
export async function getContentGenSeedChannels(
  n = N_PER_DRAFT, topK = TOPK,
): Promise<{ drafts: ListicleDraft[]; seeds: ContentGenSeed[] }> {
  const candidates = await discoverChannels({ topK });
  const drafts = assembleMixedDrafts(candidates, n);
  const seen = new Set<string>();
  const seeds: ContentGenSeed[] = [];
  for (const d of drafts) {
    for (const it of d.items) {
      const c = it.candidate;
      if (seen.has(c.channel_id)) continue;
      if (!c.top_video_url || !c.top_video_id) continue;
      seen.add(c.channel_id);
      seeds.push({
        channel_id: c.channel_id,
        channel_name: c.channel_name,
        top_video_id: c.top_video_id,
        top_video_url: c.top_video_url,
        top_video_title: c.top_video_title,
        draft_id: d.id,
        draft_title: d.title,
      });
    }
  }
  return { drafts, seeds };
}

/** Map top_video_id → ledger status ('pending'|'crawling'|'done'|'failed'). */
export async function getSpyStatusByVideoId(videoIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = videoIds.filter(Boolean);
  if (ids.length === 0) return out;
  const pool = await getPool();
  const r = await pool.query<{ seed_video_id: number; status: string }>(
    `SELECT seed_video_id, status FROM niche_discovery_seeds WHERE seed_video_id = ANY($1::int[])`,
    [ids],
  );
  for (const row of r.rows) out.set(Number(row.seed_video_id), row.status);
  return out;
}

/**
 * Un-spied content-gen seeds: top video not yet in the ledger (or last attempt
 * failed → retry). These are what the scheduler dispatches, priority-first.
 */
export async function getUnspiedContentGenSeeds(n = N_PER_DRAFT, topK = TOPK): Promise<ContentGenSeed[]> {
  const { seeds } = await getContentGenSeedChannels(n, topK);
  const status = await getSpyStatusByVideoId(seeds.map(s => s.top_video_id));
  return seeds.filter(s => {
    const st = status.get(s.top_video_id);
    return !st || st === 'failed';
  });
}

export type SpyState = 'done' | 'crawling' | 'pending' | 'none';

export interface DraftSpyStatus {
  draft_id: string;
  total: number;
  spied: number;        // done
  in_progress: number;  // crawling | pending
  not_started: number;
  fully_spied: boolean;
  per_channel: Record<string, SpyState>; // channel_id → state
}

function normState(st: string | undefined): SpyState {
  if (st === 'done') return 'done';
  if (st === 'crawling') return 'crawling';
  if (st === 'pending') return 'pending';
  return 'none';
}

/** Per-draft spy completion for the GUI badges. */
export async function getDraftSpyStatuses(drafts: ListicleDraft[]): Promise<Record<string, DraftSpyStatus>> {
  const allVideoIds = drafts.flatMap(d => d.items.map(i => i.candidate.top_video_id)).filter(Boolean);
  const status = await getSpyStatusByVideoId(allVideoIds);
  const out: Record<string, DraftSpyStatus> = {};
  for (const d of drafts) {
    let spied = 0, inprog = 0, none = 0;
    const per: Record<string, SpyState> = {};
    for (const it of d.items) {
      const s = normState(status.get(it.candidate.top_video_id));
      per[it.candidate.channel_id] = s;
      if (s === 'done') spied++;
      else if (s === 'crawling' || s === 'pending') inprog++;
      else none++;
    }
    out[d.id] = {
      draft_id: d.id,
      total: d.items.length,
      spied,
      in_progress: inprog,
      not_started: none,
      fully_spied: d.items.length > 0 && spied === d.items.length,
      per_channel: per,
    };
  }
  return out;
}

/** Mark a draft's channels as "used" (consumed into a produced video). */
export async function markGroupUsed(
  draftId: string, draftTitle: string, channelIds: string[], note?: string,
): Promise<number> {
  const ids = [...new Set(channelIds.filter(Boolean))];
  if (ids.length === 0) return 0;
  const pool = await getPool();
  let written = 0;
  for (const channelId of ids) {
    await pool.query(
      `INSERT INTO content_gen_used_channels (channel_id, draft_id, draft_title, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (channel_id) DO NOTHING`,
      [channelId, draftId, draftTitle, note ?? null],
    ).catch(() => {});
    written++;
  }
  return written;
}
