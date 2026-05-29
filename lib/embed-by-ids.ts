/**
 * Targeted embedding helper — generates and persists embeddings for an
 * explicit list of niche_spy_videos.id values and a chosen target
 * (title_v2 / thumbnail_v2 / combined_v2 / title_v1).
 *
 * Built for the admin "process embedding request" flow — a custom-niche
 * owner files an embedding_requests row with a specific video_ids set,
 * the admin clicks Process, this helper does the work, marks the rows
 * embedded, and the request flips to 'done'.
 *
 * Reuses everything load-bearing from app/api/niche-spy/embeddings:
 *   - batchEmbedInputs / batchEmbedGrouped for the actual Gemini calls
 *     (key rotation + 429/403 handling + proxy via batch — all owned by
 *     lib/embeddings.ts)
 *   - probeThumbnail / markThumbnailDead for thumbnail prefetching with
 *     terminal-vs-transient classification
 *   - upsertVector for the matching vector-DB row
 *   - Same persistence pattern (UPDATE … SET ${col} = $1::real[], stamp = NOW())
 *
 * Differs in scope: no job-row, no priority ordering, no indefinite
 * mode, no concurrency knob — single-threaded over an explicit id list.
 * Per-batch retries (3 × exponential 2s backoff) match the existing
 * route, since Gemini transient failures are the same shape.
 */

import { getPool } from './db';
import {
  TARGET_CONFIG,
  type EmbeddingTarget,
  type EmbedInput,
} from './embeddings';
// Direct-fetch Gemini path — see lib/embed-direct.ts for why we
// stopped using the proxied batchEmbedInputs / batchEmbedGrouped from
// lib/embeddings.ts (proxy collapse rate made the success ratio
// ~1.5%, leaving requests stuck at 0/N for tens of minutes).
import { batchEmbedInputsDirect, batchEmbedGroupedDirect } from './embed-direct';
import { upsertVector } from './vector-db';
import { probeThumbnail, markThumbnailDead, thumbnailUrlFor } from './thumbnail-validate';

const BATCH_SIZE = 5;
// 8 retries to escape clustered per-project minute quotas. Each retry
// picks a fresh random key; even with high project clustering in the
// pool, ~3 fresh picks usually find a non-cooled project bucket. The
// 250ms × attempt backoff gives the previous key's cooloff DB update
// a moment to land so the next pick doesn't re-roll it.
const PER_BATCH_RETRIES = 8;
const RETRY_BACKOFF_MS  = 250;

export interface TargetedEmbedResult {
  total: number;          // total ids requested
  processed: number;      // successfully embedded + persisted
  alreadyEmbedded: number;// ids that already had the target embedding (skipped)
  thumbDropped: number;   // ids dropped because thumbnail wasn't fetchable
  errors: number;         // ids that failed after all retries
  batches: number;
  lastError: string | null;
}

interface VidRow {
  id: number;
  title: string | null;
  keyword: string | null;
  thumbnail: string | null;
  url: string | null;
}

/**
 * Embed each video in `videoIds` for `target` and persist. Returns
 * counters so the caller can summarise the run. Never throws — failure
 * modes are surfaced via the `errors` count + `lastError` string.
 *
 * `onProgress` (optional) is called after every batch with the running
 * counters so the caller can persist live progress (the admin
 * "Processing 24/62" UI uses this to update the embedding_requests row).
 * Failures inside onProgress are swallowed — progress reporting must
 * never tank the embed job.
 */
export async function embedSpecificVideos(
  videoIds: number[],
  target: EmbeddingTarget,
  onProgress?: (partial: TargetedEmbedResult) => void | Promise<void>,
): Promise<TargetedEmbedResult> {
  const result: TargetedEmbedResult = {
    total: videoIds.length,
    processed: 0,
    alreadyEmbedded: 0,
    thumbDropped: 0,
    errors: 0,
    batches: 0,
    lastError: null,
  };
  if (videoIds.length === 0) return result;
  const cfg = TARGET_CONFIG[target];
  const pool = await getPool();

  // Pull all the rows up front. Drop any that already have the target
  // embedding (caller's video_ids might be stale — the request was
  // filed earlier, embeddings might have been backfilled since).
  const rowsRes = await pool.query<VidRow & { already_embedded: boolean }>(
    `SELECT id, title, keyword, thumbnail, url,
            ${cfg.column} IS NOT NULL AS already_embedded
       FROM niche_spy_videos
      WHERE id = ANY($1::int[])`,
    [videoIds],
  );
  const toEmbed: VidRow[] = [];
  for (const r of rowsRes.rows) {
    if (r.already_embedded) {
      result.alreadyEmbedded++;
      continue;
    }
    // Same content gates the public route enforces — without these the
    // batch input would be malformed.
    if (target === 'title_v2' || target === 'title_v1') {
      if (!r.title || r.title.trim() === '') { result.errors++; continue; }
    }
    if (target === 'thumbnail_v2' || target === 'combined_v2') {
      if (!(r.thumbnail || r.url)) { result.thumbDropped++; continue; }
    }
    if (target === 'combined_v2') {
      if (!r.title || r.title.trim() === '') { result.errors++; continue; }
    }
    toEmbed.push({ id: r.id, title: r.title, keyword: r.keyword, thumbnail: r.thumbnail, url: r.url });
  }

  if (toEmbed.length === 0) return result;

  // Chunk into BATCH_SIZE-sized groups; Gemini accepts up to 100 per
  // call but 5 keeps the per-batch latency low and gives the retry
  // window finer granularity.
  for (let off = 0; off < toEmbed.length; off += BATCH_SIZE) {
    result.batches++;
    const chunk = toEmbed.slice(off, off + BATCH_SIZE);

    // Build inputs for this chunk — three shapes by target, same as the
    // public route's worker. Thumbnail probe drops irrecoverable images
    // (404 / 410 / sub-1KB placeholder) and marks the row dead so we
    // don't keep retrying them on the next request.
    let inputs: EmbedInput[] = [];
    let groups: EmbedInput[][] = [];
    const items: VidRow[] = [];

    if (target === 'thumbnail_v2') {
      const probes = await Promise.all(chunk.map(async v => {
        const picked = thumbnailUrlFor({ thumbnail: v.thumbnail, url: v.url }).url;
        if (!picked) return { v, input: null as EmbedInput | null };
        const p = await probeThumbnail(picked);
        if (!p.ok) {
          if (p.terminal) markThumbnailDead(v.id, p.reason ?? 'terminal').catch(() => {});
          return { v, input: null };
        }
        return {
          v,
          input: { type: 'image' as const, mimeType: p.mime ?? 'image/jpeg', data: p.body!.toString('base64') },
        };
      }));
      for (const r of probes) {
        if (r.input) { items.push(r.v); inputs.push(r.input); }
        else result.thumbDropped++;
      }
    } else if (target === 'combined_v2') {
      const probes = await Promise.all(chunk.map(async v => {
        const picked = thumbnailUrlFor({ thumbnail: v.thumbnail, url: v.url }).url;
        if (!picked) return { v, group: null as EmbedInput[] | null };
        const p = await probeThumbnail(picked);
        if (!p.ok) {
          if (p.terminal) markThumbnailDead(v.id, p.reason ?? 'terminal').catch(() => {});
          return { v, group: null };
        }
        const group: EmbedInput[] = [
          { type: 'text', text: v.title || '' },
          { type: 'image', mimeType: p.mime ?? 'image/jpeg', data: p.body!.toString('base64') },
        ];
        return { v, group };
      }));
      for (const r of probes) {
        if (r.group) { items.push(r.v); groups.push(r.group); }
        else result.thumbDropped++;
      }
    } else {
      // text-only (title_v1 / title_v2)
      for (const v of chunk) {
        items.push(v);
        inputs.push({ type: 'text', text: v.title || '' });
      }
    }

    const expected = target === 'combined_v2' ? groups.length : inputs.length;
    if (expected === 0) continue;

    // Per-batch retry — Gemini's transient 429/network blips usually
    // recover within 1-2 retries since batchEmbedInputs rotates keys
    // internally. After PER_BATCH_RETRIES we record the failure on
    // every row in the chunk and move on.
    let success = false;
    let lastErr: string | null = null;
    for (let attempt = 0; attempt < PER_BATCH_RETRIES && !success; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS * attempt));
      try {
        const embeddings = target === 'combined_v2'
          ? await batchEmbedGroupedDirect(groups, cfg.model)
          : await batchEmbedInputsDirect(inputs, cfg.model);
        // Defensive: Google sometimes returns short / zero-length lists
        // on content it can't process — treat as transient.
        if (embeddings.length < expected) {
          throw new Error(`short response: got ${embeddings.length}/${expected} embeddings`);
        }
        const badIdx = embeddings.findIndex(e => !e || e.length === 0);
        if (badIdx !== -1) throw new Error(`empty embedding at index ${badIdx}`);

        // Persist per-item: main DB column + vector-DB row. We don't
        // throw on a per-row persist failure — log and move on so one
        // bad UPDATE doesn't poison the rest of the chunk.
        for (let i = 0; i < items.length; i++) {
          const emb = embeddings[i];
          if (!emb || emb.length === 0) { result.errors++; continue; }
          const arrayLiteral = `{${emb.join(',')}}`;
          try {
            await pool.query(
              `UPDATE niche_spy_videos
                  SET ${cfg.column} = $1::real[], ${cfg.stampColumn} = NOW()
                WHERE id = $2`,
              [arrayLiteral, items[i].id],
            );
            await upsertVector(
              items[i].id,
              items[i].keyword || '',
              items[i].title || '',
              emb,
              target,
            ).catch(e => console.warn(`[embed-by-ids] upsertVector id=${items[i].id} failed:`, (e as Error).message));
            result.processed++;
          } catch (persistErr) {
            result.errors++;
            console.warn(`[embed-by-ids] persist id=${items[i].id} failed:`, (persistErr as Error).message);
          }
        }
        success = true;
      } catch (err) {
        lastErr = (err as Error).message?.slice(0, 240) || 'unknown';
        console.warn(`[embed-by-ids] batch ${result.batches} attempt ${attempt + 1}/${PER_BATCH_RETRIES} failed:`, lastErr);
      }
    }
    if (!success) {
      result.errors += items.length;
      result.lastError = lastErr;
    }
    // Surface progress to the caller (typically a DB write that the
    // admin UI polls). Errors swallowed — a slow progress UPDATE
    // mustn't slow the embed loop, and certainly mustn't fail it.
    if (onProgress) {
      try { await onProgress({ ...result }); } catch { /* never throw from progress */ }
    }
  }

  return result;
}
