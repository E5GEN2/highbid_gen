/**
 * Bulk pre-mark sweep for dead thumbnails on the embedding queue.
 *
 * The runtime worker marks rows on first-failure (self-healing) but the
 * wall-time cost of discovering dead rows organically is high — every
 * dead row costs the worker a full thread-slot until the failed probe
 * comes back. With a score-DESC ordering, the front of the queue is
 * 100% dead (verified by the diagnostic endpoint on 2026-05-14), so the
 * job is essentially stalled until those rows are marked.
 *
 * This sweep walks the unembedded combined_v2 / thumbnail_v2 queue in
 * score-DESC order (matching the worker's pull order), probes each
 * thumbnail in parallel, and marks the dead ones. After it completes
 * the embedding job can chew through the alive remainder cleanly.
 *
 * Mirror of lib/ai-studio-key-validate.ts in shape (fire-and-forget,
 * module-scope state, ringbuffer events). Single-flight by design —
 * one sweep at a time across the system.
 */

import { getPool } from './db';
import { probeThumbnail, markThumbnailDead, thumbnailUrlFor } from './thumbnail-validate';

export interface SweepEvent {
  videoId: number;
  pickedUrl: string | null;
  pickedSource: 'db_thumbnail' | 'youtube_id_from_url' | 'none';
  ok: boolean;
  terminal: boolean;
  status: number | null;
  bytes: number | null;
  reason: string | null;
  action: 'kept' | 'marked_dead' | 'no_url' | 'skipped';
  detectedAt: string;
}

export interface SweepProgress {
  total: number;
  processed: number;
  alive: number;
  marked: number;
  noUrl: number;
  transientFailures: number;
  events: SweepEvent[]; // newest-first, ring cap 500
  running: boolean;
  jobKey: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

let state: SweepProgress = {
  total: 0, processed: 0, alive: 0, marked: 0, noUrl: 0, transientFailures: 0,
  events: [], running: false, jobKey: null,
  startedAt: null, finishedAt: null, lastError: null,
};
let inFlight = false;

export function getSweepState(): SweepProgress {
  return state;
}

export type SweepTarget = 'combined_v2' | 'thumbnail_v2';

export interface RunSweepOpts {
  target?: SweepTarget;
  /** Limit to top-N rows (default 0 = whole queue). Useful for incremental
   *  drains — sweep top 2000, kick the embedding job, repeat as needed. */
  limit?: number;
  /** Worker pool size. img.youtube.com is generous; 20-30 in parallel is
   *  safe and gets a 5k-row sweep done in ~3-4 min. */
  concurrency?: number;
  /** Dry run: classify but skip the marking step. Useful for validating
   *  the terminal-detector against fresh data before nuking rows. */
  dryRun?: boolean;
}

export function startSweep(opts: RunSweepOpts = {}): { started: boolean; jobKey?: string } {
  if (inFlight) return { started: false, jobKey: state.jobKey ?? undefined };
  const jobKey = `thumbsweep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  inFlight = true;
  state = {
    total: 0, processed: 0, alive: 0, marked: 0, noUrl: 0, transientFailures: 0,
    events: [], running: true, jobKey,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
  };
  (async () => {
    try { await runSweep(opts); }
    catch (err) {
      state.lastError = (err as Error).message?.slice(0, 500) || 'unknown';
      console.error('[thumb-sweep] failed:', err);
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      inFlight = false;
    }
  })();
  return { started: true, jobKey };
}

async function runSweep(opts: RunSweepOpts): Promise<void> {
  const pool = await getPool();
  const target = opts.target ?? 'combined_v2';
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 20, 50));
  const dryRun = !!opts.dryRun;

  // Same WHERE clause shape the embedding worker uses for this target.
  // ORDER BY score DESC matches the worker so we drain its frontline
  // dead rows first.
  const conditions: string[] = [];
  if (target === 'combined_v2') {
    conditions.push(`combined_embedded_v2_at IS NULL`);
    conditions.push(`title IS NOT NULL AND title != ''`);
    conditions.push(`((thumbnail IS NOT NULL AND thumbnail != '') OR (url IS NOT NULL AND url != ''))`);
  } else {
    conditions.push(`thumbnail_embedded_v2_at IS NULL`);
    conditions.push(`((thumbnail IS NOT NULL AND thumbnail != '') OR (url IS NOT NULL AND url != ''))`);
  }
  // Always skip rows already marked dead — re-marking is a no-op but
  // there's no point probing them again either.
  conditions.push(`thumbnail_dead_at IS NULL`);

  const limitClause = (opts.limit && opts.limit > 0) ? `LIMIT ${opts.limit}` : '';
  const rows = await pool.query<{ id: number; thumbnail: string | null; url: string | null }>(
    `SELECT id, thumbnail, url FROM niche_spy_videos
       WHERE ${conditions.join(' AND ')}
       ORDER BY score DESC NULLS LAST
       ${limitClause}`,
  );
  state.total = rows.rows.length;
  if (rows.rows.length === 0) return;

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.rows.length) return;
      const row = rows.rows[i];
      const picked = thumbnailUrlFor(row);
      const evt: SweepEvent = {
        videoId: row.id,
        pickedUrl: picked.url,
        pickedSource: picked.source,
        ok: false,
        terminal: false,
        status: null,
        bytes: null,
        reason: null,
        action: 'skipped',
        detectedAt: new Date().toISOString(),
      };
      try {
        if (!picked.url) {
          evt.action = 'no_url';
          evt.reason = 'no thumbnail url derivable';
          state.noUrl++;
          if (!dryRun) {
            await markThumbnailDead(row.id, 'no thumbnail url');
            evt.action = 'marked_dead';
            state.marked++;
          }
        } else {
          const probe = await probeThumbnail(picked.url, { omitBody: true });
          evt.ok = probe.ok;
          evt.terminal = probe.terminal;
          evt.status = probe.status;
          evt.bytes = probe.bytes;
          evt.reason = probe.reason;
          if (probe.ok) {
            evt.action = 'kept';
            state.alive++;
          } else if (probe.terminal) {
            if (dryRun) {
              evt.action = 'skipped';
              evt.reason = `[dry-run] would mark: ${probe.reason}`;
            } else {
              const flipped = await markThumbnailDead(row.id, probe.reason ?? 'terminal');
              evt.action = flipped ? 'marked_dead' : 'skipped';
              if (flipped) state.marked++;
            }
          } else {
            // Transient (timeout, DNS, 5xx) — leave row alone; worker
            // can retry later.
            evt.action = 'skipped';
            state.transientFailures++;
          }
        }
      } catch (err) {
        evt.reason = (err as Error).message?.slice(0, 200) || 'unknown';
        state.transientFailures++;
      }
      state.events.unshift(evt);
      if (state.events.length > 500) state.events.length = 500;
      state.processed++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.rows.length) }, () => worker()));
}
