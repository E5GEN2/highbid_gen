/**
 * Thumbnail liveness probe shared by the embedding worker
 * (lib/embeddings.ts callers) and the bulk pre-mark sweep
 * (lib/thumbnail-sweep.ts).
 *
 * The thumbnail_v2 / combined_v2 embedding targets BOTH need a fetchable
 * image. Many high-score / older niche_spy_videos rows point at YouTube
 * videos that have since been deleted, privated, age-restricted, or
 * region-blocked — img.youtube.com returns 404 (or a ~120-byte placeholder
 * JPG with HTTP 200) for those. The worker used to retry those rows on
 * every batch forever, eating thread time + proxy slots and inflating
 * the job's error counter (~1900 errors / 0 processed seen on
 * 2026-05-14).
 *
 * Fix:
 *   1. Probe each thumbnail URL up-front (or on first failure at runtime).
 *   2. On a terminal verdict, set niche_spy_videos.thumbnail_dead_at = NOW().
 *   3. SELECTs for the v2 / combined_v2 jobs add
 *      `AND thumbnail_dead_at IS NULL` so dead rows are skipped forever.
 *
 * Self-healing: any dead row the bulk sweep misses gets marked organically
 * by the worker on its first fetch attempt.
 */

import { getPool } from './db';

/** Result of a single thumbnail probe. */
export interface ProbeResult {
  ok: boolean;
  status: number | null;
  bytes: number | null;
  mime: string | null;
  /** Raw image bytes when ok=true — lets the embedding worker reuse this
   *  fetch for the actual API call instead of doing a second round trip.
   *  Unset (undefined) for failures and for callers that pass
   *  `omitBody: true`. */
  body?: Buffer;
  /** Terminal = mark the row as thumbnail_dead. Transient = leave alone
   *  (retry will likely succeed). */
  terminal: boolean;
  reason: string | null;
  latencyMs: number;
}

/** Derive a fetchable thumbnail URL from a niche_spy_videos row. */
export function thumbnailUrlFor(row: { thumbnail: string | null; url: string | null }): {
  url: string | null;
  source: 'db_thumbnail' | 'youtube_id_from_url' | 'none';
} {
  if (row.thumbnail && row.thumbnail.trim().length > 0) {
    return { url: row.thumbnail.trim(), source: 'db_thumbnail' };
  }
  const m = row.url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (m) return { url: `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`, source: 'youtube_id_from_url' };
  return { url: null, source: 'none' };
}

/** Probe one thumbnail URL. Classifies the result into terminal (the
 *  video / thumbnail is permanently gone) vs transient (timeout, 5xx,
 *  DNS — could retry). When `omitBody` is true we still read+verify
 *  the response size but discard the buffer to keep memory tight on
 *  bulk sweeps that don't need the image. */
export async function probeThumbnail(url: string, opts: { timeoutMs?: number; omitBody?: boolean } = {}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const omitBody = !!opts.omitBody;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    const ms = Date.now() - t0;
    const mime = res.headers.get('content-type')?.split(';')[0].trim() ?? null;

    // 404 / 410 / 451 are definitive: video deleted, withdrawn legally,
    // or removed by Google. Never coming back, mark dead.
    if ([404, 410, 451].includes(res.status)) {
      return { ok: false, status: res.status, bytes: null, mime, terminal: true,
        reason: `HTTP ${res.status}`, latencyMs: ms };
    }
    // Other non-2xx: 403/429/5xx — could be transient (geo, rate limit,
    // CDN hiccup). Don't mark dead.
    if (!res.ok) {
      return { ok: false, status: res.status, bytes: null, mime, terminal: false,
        reason: `HTTP ${res.status}`, latencyMs: ms };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // img.youtube.com returns a tiny grey "no thumbnail" placeholder
    // (~120-300B JPG) with HTTP 200 for deleted videos that still have
    // a valid-shaped URL. Treat sub-1KB images as effectively dead.
    if (buf.length < 1024) {
      return { ok: false, status: res.status, bytes: buf.length, mime, terminal: true,
        reason: `placeholder (${buf.length}B)`, latencyMs: ms };
    }
    return {
      ok: true,
      status: res.status,
      bytes: buf.length,
      mime,
      body: omitBody ? undefined : buf,
      terminal: false,
      reason: null,
      latencyMs: ms,
    };
  } catch (err) {
    const ms = Date.now() - t0;
    const raw = (err as Error).message ?? 'unknown';
    let reason = raw.slice(0, 200);
    if (raw.includes('timeout') || raw.includes('aborted'))      reason = `timeout (${ms}ms)`;
    else if (raw.includes('ENOTFOUND') || raw.includes('getaddrinfo')) reason = 'DNS failure';
    else if (raw.includes('ECONNREFUSED'))                       reason = 'connection refused';
    else if (raw.includes('certificate') || raw.includes('CERT')) reason = 'TLS error';
    // All network errors are transient — never mark dead based on
    // network alone (a flaky Railway DNS lookup must not nuke 4k rows).
    return { ok: false, status: null, bytes: null, mime: null, terminal: false,
      reason, latencyMs: ms };
  }
}

/** Mark one row as having a permanently-dead thumbnail. Idempotent —
 *  re-marking the same row is a no-op via the WHERE clause. Returns
 *  true if a row was actually flipped (vs already marked). */
export async function markThumbnailDead(videoId: number, reason: string): Promise<boolean> {
  try {
    const pool = await getPool();
    const r = await pool.query(
      `UPDATE niche_spy_videos
          SET thumbnail_dead_at = NOW()
        WHERE id = $1 AND thumbnail_dead_at IS NULL`,
      [videoId],
    );
    const flipped = (r.rowCount ?? 0) > 0;
    if (flipped) {
      console.log(`[thumb-dead] marked video_id=${videoId} reason=${reason}`);
    }
    return flipped;
  } catch (err) {
    console.error('[thumb-dead] mark failed:', (err as Error).message);
    return false;
  }
}
