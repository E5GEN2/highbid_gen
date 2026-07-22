/**
 * Video-seed niche expansion.
 *
 * xgodo agents POST a seed video URL plus a batch of candidate URLs
 * (typically scraped from the seed's YouTube "suggested videos" panel).
 * We:
 *   1. Resolve each URL → niche_spy_videos row (fetch metadata via YT
 *      Data API if not already in our DB).
 *   2. Embed the seed and any candidates that don't yet have a
 *      combined_v2 vector (multimodal: title text + thumbnail image).
 *   3. Cosine-compare each candidate against the seed in the combined_v2
 *      pgvector space.
 *   4. Persist (seed, candidate, similarity, matched, rank) into
 *      niche_seed_expansions for the admin live feed + the audit trail.
 *
 * The combined_v2 cosine path replaces the per-keyword Gemini chat
 * scoring loop: ~95% cheaper per video, ~100× faster, geometrically
 * coherent with the cluster pipeline.
 */

import { fetchViaProxy } from './proxy-dispatcher';
import { getPool } from './db';
import { pickRandomActiveYtPair, banYtKey, invalidateYtKey } from './yt-keys';
import { ytFetchViaProxy } from './yt-proxy-fetch';
import { getRandomProxy } from './xgodo-proxy';
import type { EmbedInput } from './embeddings';

// ─────────────────────────────────────────────────────────────────────
// Gemini embedding helper, IP-rotated via xgodo proxies.
//
// We can't go direct from Railway at scale — Gemini will eventually
// rate-limit (and at worst, ban) the single egress IP. So embeddings
// go through a fresh random xgodo proxy per attempt, rotating egress
// IP. The proxy pool has a real dead rate (~67% dead-on-connect per
// recent probe via /api/admin/tools/vid-gen/diag), so we ALSO rotate
// the proxy on every retry — most failures are "this proxy is down
// right now", not "this key is bad", so a different proxy on the next
// try is more likely to succeed than reusing the same one.
//
// Key-pool hygiene runs alongside: 403 PERMISSION_DENIED → invalidate
// the key (it's terminally banned). 429 → 90s banned_until cooloff so
// the next picker call skips that key while its per-minute window
// refills.
// ─────────────────────────────────────────────────────────────────────

interface AiKeyRow { id: number; key: string; }

async function pickHealthyAiKey(): Promise<AiKeyRow | null> {
  const pool = await getPool();
  const r = await pool.query<AiKeyRow>(
    `SELECT id, key
       FROM xgodo_api_keys
      WHERE service = 'google_ai_studio'
        AND status = 'active'
        AND (banned_until IS NULL OR banned_until < NOW())
      ORDER BY RANDOM()
      LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

function invalidateAiKey(keyId: number, reason: string): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys SET status = 'invalid', invalidated_at = NOW()
          WHERE id = $1 AND status = 'active'`,
        [keyId],
      );
      console.log(`[video-seed] Invalidated key id=${keyId} (${reason})`);
    } catch { /* fire-and-forget */ }
  })();
}

function cooloffAiKey(keyId: number, seconds: number = 90): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys SET banned_until = NOW() + ($1 || ' seconds')::interval
          WHERE id = $2`,
        [String(seconds), keyId],
      );
    } catch { /* fire-and-forget */ }
  })();
}

// ── Global embed-concurrency limiter ─────────────────────────────────────
// Google rate-limits embeddings per key/project. Firing many concurrent
// batchEmbedContents (parallel /expand calls + novelty-recompute workers)
// overruns the aggregate quota → 429s cascade, and each 429 cools its key for
// 90s, so a burst drains the whole pickable pool → `no_active_ai` starvation.
// Capping *concurrency* paces the request rate so keys aren't mass-cooled.
// RULE: pace, don't saturate (see reference_gemini_throttle_resilience).
// Env-tunable; ~4 keeps throughput healthy while staying under the quota.
const EMBED_MAX_CONCURRENCY = Math.max(1, parseInt(process.env.HB_EMBED_CONCURRENCY || '4', 10));
let embedSlots = EMBED_MAX_CONCURRENCY;
const embedQueue: Array<() => void> = [];
async function acquireEmbedSlot(): Promise<void> {
  if (embedSlots > 0) { embedSlots--; return; }
  return new Promise<void>(resolve => embedQueue.push(resolve));
}
function releaseEmbedSlot(): void {
  const next = embedQueue.shift();
  if (next) next();        // hand the slot straight to the next waiter
  else embedSlots++;       // no waiter — return it to the pool
}

/** One Gemini batchEmbedContents call, routed through a specific
 *  (key, proxy) pair. Proxy is required — we never go direct so we
 *  don't pile load against Railway's single egress IP. Throws on any
 *  failure so the chunk loop can swap to a fresh pair. Serialized behind
 *  the global embed limiter so concurrent callers can't saturate the pool. */
async function batchEmbedGroupedViaProxy(
  groups: EmbedInput[][],
  modelName: string,
  apiKey: string,
  keyId: number,
  proxyUrl: string,
): Promise<number[][]> {
  if (groups.length === 0) return [];

  const requests = groups.map(group => ({
    model: `models/${modelName}`,
    content: {
      parts: group.map(p => p.type === 'image'
        ? { inlineData: { mimeType: p.mimeType, data: p.data } }
        : { text: p.text }),
    },
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:batchEmbedContents?key=${apiKey}`;
  // 20s per-attempt timeout. A healthy proxy + Gemini call completes
  // in ~3s; anything taking longer is either a slow proxy or a stalled
  // upstream and we'd rather rotate than wait. Cap matters because
  // batchEmbedGroupedDirect's inner loop runs up to 6 of these.
  // fetchViaProxy handles both HTTP (undici) and SOCKS5 (https.request)
  // transports — see lib/proxy-dispatcher.ts. 20s timeout keeps the
  // outer per-call retry loop snappy.
  // Serialize the actual Google request behind the global limiter (release as
  // soon as the response is in — the rate-limited leg is the HTTP call itself).
  await acquireEmbedSlot();
  const res = await (async () => {
    try {
      return await fetchViaProxy(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
        timeoutMs: 20_000,
      }, proxyUrl);
    } finally {
      releaseEmbedSlot();
    }
  })();

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 403 && /PERMISSION_DENIED|has been (denied|suspended)/i.test(errBody)) {
      invalidateAiKey(keyId, `gemini_403: ${errBody.slice(0, 80)}`);
    } else if (res.status === 401) {
      // 401 UNAUTHENTICATED = the key itself is dead (deleted/disabled
      // service account, revoked key) — never transient. Without this the
      // key stays 'active' and the random picker re-burns it forever.
      invalidateAiKey(keyId, `gemini_401: ${errBody.slice(0, 80)}`);
    } else if (res.status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(errBody)) {
      // 400 with a key-specific message is a revoked/expired key; plain
      // INVALID_ARGUMENT 400s (request-shape issues) are left alone.
      invalidateAiKey(keyId, `gemini_400: ${errBody.slice(0, 80)}`);
    } else if (res.status === 429) {
      cooloffAiKey(keyId, 90);
    }
    throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json() as {
    embeddings?: Array<{ values?: number[] }>;
    error?: { code?: number; message?: string };
  };
  if (data.error) {
    throw new Error(`Gemini error ${data.error.code}: ${(data.error.message || '').slice(0, 200)}`);
  }
  if (!data.embeddings) throw new Error('Gemini response had no embeddings');
  return data.embeddings.map(e => e.values ?? []);
}

/** Chunk-level driver: tries the embedding call through a fresh
 *  (key, proxy) pair until one succeeds or maxAttempts is exhausted.
 *  Rotates both dimensions every attempt — most failures here are
 *  "this proxy is down right now" rather than "this key is bad", so
 *  retrying with the same proxy isn't useful. */
async function batchEmbedGroupedDirect(
  groups: EmbedInput[][],
  modelName: string,
  maxAttempts: number = 6,
): Promise<number[][]> {
  if (groups.length === 0) return [];
  let lastErr = 'no_attempts';
  let rateLimited = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const keyRow = await pickHealthyAiKey();
    if (!keyRow) { lastErr = 'no_active_ai_keys'; break; }
    const proxy = await getRandomProxy().catch(() => null);
    if (!proxy?.url) {
      // Proxy dealer empty or errored — wait briefly and let next
      // attempt re-pick. Bail entirely if this keeps happening.
      lastErr = 'no_proxy_available';
      continue;
    }
    try {
      return await batchEmbedGroupedViaProxy(groups, modelName, keyRow.key, keyRow.id, proxy.url);
    } catch (err) {
      lastErr = (err as Error).message?.slice(0, 200) || 'unknown';
      // A 429 is a pool-wide quota throttle, NOT a bad key — retrying with a
      // fresh key just spreads the 90s cooloff across the pool and drains it.
      // Cap 429 retries and back off (jittered) so a rate-limit blip can't burn
      // through every pickable key. Non-429 errors (dead proxy/key) keep the
      // full fast rotation.
      if (/HTTP 429/.test(lastErr)) {
        if (++rateLimited >= 2) break;
        await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 600)));
      }
    }
  }
  throw new Error(lastErr);
}

interface YtVideoSnippet {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    channelId?: string;
    channelTitle?: string;
    thumbnails?: {
      maxres?: { url?: string };
      high?: { url?: string };
      medium?: { url?: string };
      default?: { url?: string };
    };
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}
interface YtVideosListResponse { items?: YtVideoSnippet[] }

export interface SeedCandidate {
  videoId: number | null;          // niche_spy_videos.id (may be null on failure)
  ytId: string;                    // YT 11-char video id
  url: string;
  title: string | null;
  thumbnail: string | null;
  similarity: number | null;       // cosine in combined_v2 vs seed; null on failure
  rank: number;                    // rank by similarity descending (1 = best)
  wasNew: boolean | null;          // true if THIS call discovered the candidate; false if we already had it; null on resolve failure
  error?: string;
}

export interface SeedExpandResult {
  seed: {
    videoId: number;
    ytId: string;
    url: string;
    title: string | null;
    thumbnail: string | null;
    embeddingCached: boolean;      // true if a vector already existed; false if we attempted to generate one this call
    embedError?: string;           // populated only when generation was attempted AND failed
  };
  candidates: SeedCandidate[];     // every candidate we processed, ranked by similarity descending
  taskId: string | null;
  keyword: string | null;
  /** ms timings for ops, useful for the admin debug panel. */
  timings: {
    metadataMs: number;
    embeddingMs: number;
    similarityMs: number;
    persistMs: number;
  };
}

/** Extract the 11-char YT video id from a URL. Returns null on no match. */
export function extractYtVideoId(url: string): string | null {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/))([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function bestThumbnail(snip: YtVideoSnippet['snippet']): string | null {
  return (
    snip?.thumbnails?.maxres?.url ??
    snip?.thumbnails?.high?.url ??
    snip?.thumbnails?.medium?.url ??
    snip?.thumbnails?.default?.url ??
    null
  );
}

/** Fetch the source bytes for a thumbnail URL and return as base64. */
async function fetchThumbBase64(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const mimeType = res.headers.get('content-type')?.split(';')[0].trim() || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    return { mimeType, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

/**
 * Hit YT Data API videos.list for ≤50 ids in one call, with key rotation.
 *
 * The pool's "active" status only excludes keys we've already learned
 * are bad. A fresh `pickRandomActiveYtPair` lands on a truly-healthy
 * key roughly 1-in-4 times in steady state — the rest are either
 * quota-exhausted (recoverable next midnight PT) or CONSUMER_SUSPENDED
 * (terminal) and just hadn't been re-probed yet. A single-attempt call
 * fails most of the time, which is why the admin Video Seed feed used
 * to be ~75% `yt-key metadata fetch failed` rows.
 *
 * Strategy:
 *   - Try up to MAX_ATTEMPTS distinct keys per call.
 *   - On quotaExceeded → banYtKey() (5-min cooloff + DB persist) and
 *     rotate. The next health sweep flips it to a 12h ban with the
 *     full quota window.
 *   - On forbidden/CONSUMER_SUSPENDED → invalidateYtKey() and rotate.
 *     Terminal, won't recover without GCP-side action.
 *   - On network/proxy failure (status 0) → don't punish the key, just
 *     rotate. Failure is likely the proxy, not the key.
 *   - On any other YT error → rotate without DB action; rare.
 *
 * Each retry gets a fresh (key, proxy) pair from
 * pickRandomActiveYtPair, so a flaky proxy can't take the whole batch
 * down either.
 */
async function fetchYtVideoMeta(ytIds: string[]): Promise<Map<string, YtVideoSnippet>> {
  const map = new Map<string, YtVideoSnippet>();
  if (ytIds.length === 0) return map;

  const MAX_ATTEMPTS = 6;
  const tried = new Set<string>();      // key prefixes we've already used
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const pair = await pickRandomActiveYtPair();
    if (!pair) {
      lastError = 'no active YT key available';
      break;
    }
    // Skip if we've already burned this key in this batch. With
    // ~2700 active keys, repeats in 6 picks are rare but possible.
    if (tried.has(pair.key)) continue;
    tried.add(pair.key);

    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ytIds.join(',')}&key=${pair.key}`;
    const res = await ytFetchViaProxy(url, pair);

    if (res.ok && res.data) {
      const data = res.data as YtVideosListResponse;
      for (const item of data.items ?? []) {
        if (item.id) map.set(item.id, item);
      }
      return map;
    }

    // Classify the failure so we can recycle the pool as we go.
    const errData = (res.data as { error?: { errors?: { reason?: string }[]; message?: string } } | null)?.error;
    const reason = errData?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded') {
      banYtKey(pair.key);
      lastError = 'quotaExceeded';
    } else if (reason === 'forbidden') {
      // CONSUMER_SUSPENDED — terminal. Fire-and-forget the DB invalidation
      // so this attempt's latency isn't gated on the UPDATE round trip.
      void invalidateYtKey(pair.key, 'forbidden').catch(() => { /* logged elsewhere */ });
      lastError = 'forbidden';
    } else if (res.status === 0) {
      // Network/proxy failure. Don't punish the key — most likely
      // a flaky SOCKS5 hop or a curl timeout.
      lastError = res.error?.slice(0, 80) ?? 'network';
    } else {
      lastError = reason ?? `http ${res.status}`;
    }
  }

  // All attempts exhausted — return whatever (likely empty) we have.
  // Caller logs `metadata fetch failed`; the more granular reason
  // already landed in xgodo_api_keys for the next pool sweep to act on.
  if (lastError) {
    console.warn(`[video-seed] fetchYtVideoMeta gave up after ${MAX_ATTEMPTS} attempts; last=${lastError}; tried=${tried.size}`);
  }
  return map;
}

interface ResolvedVideo {
  videoId: number;                 // niche_spy_videos.id
  ytId: string;
  url: string;
  title: string | null;
  thumbnail: string | null;
  hadCombinedV2: boolean;          // whether the row already had a vector
  wasNew: boolean;                 // true if this resolve created the niche_spy_videos row
}

/**
 * Resolve a batch of YT URLs into niche_spy_videos rows, fetching
 * metadata and inserting new rows for any we haven't seen. Returns one
 * entry per URL in submission order; entries with no extractable YT id
 * or failed lookups are null.
 */
async function resolveBatch(
  urls: string[],
  keyword: string | null,
): Promise<Array<ResolvedVideo | null>> {
  const pool = await getPool();
  const ytIds = urls.map(u => extractYtVideoId(u));
  const validIds = ytIds.filter((x): x is string => !!x);
  if (validIds.length === 0) return urls.map(() => null);

  // 1) Check which ones we already have in niche_spy_videos.
  //    niche_spy_videos.url is ALWAYS the canonical "https://youtu.be/<id>"
  //    form on insert (verified: 2.46M/2.46M rows canonical, 0 legacy forms),
  //    so an equality match on url hits the UNIQUE idx_niche_spy_url index.
  //    A prior `OR url ~ ANY($2)` regex fallback for legacy non-canonical
  //    URLs defeated that index — the OR forced a full 2.46M-row seq scan on
  //    every resolve (108 concurrent, ~155s each, exhausting the DB pool).
  //    Dropped: it matched nothing the equality branch didn't already catch.
  const existRes = await pool.query<{ id: number; url: string; title: string | null; thumbnail: string | null; has_v2: boolean }>(
    `SELECT id, url, title, thumbnail,
            (combined_embedding_v2 IS NOT NULL) AS has_v2
       FROM niche_spy_videos
      WHERE url = ANY($1::text[])`,
    [validIds.map(id => `https://youtu.be/${id}`)],
  );
  // wasNew tracks whether this resolve is the one that created the
  // niche_spy_videos row: false for anything found in step 1, true for
  // any row we INSERT in step 2. The admin Video Seed feed surfaces
  // this so the operator can spot fresh discoveries from already-known
  // candidates at a glance.
  const byYtId = new Map<string, { id: number; title: string | null; thumbnail: string | null; has_v2: boolean; wasNew: boolean }>();
  for (const row of existRes.rows) {
    const yid = extractYtVideoId(row.url);
    if (yid) byYtId.set(yid, { id: row.id, title: row.title, thumbnail: row.thumbnail, has_v2: row.has_v2, wasNew: false });
  }

  // 2) Any YT ids we DON'T have rows for — fetch metadata via YT Data API
  //    and insert. videos.list takes up to 50 ids per call.
  const missingYtIds = validIds.filter(id => !byYtId.has(id));
  if (missingYtIds.length > 0) {
    const meta = await fetchYtVideoMeta(missingYtIds);
    for (const ytId of missingYtIds) {
      const snip = meta.get(ytId);
      if (!snip) continue;       // YT returned nothing — leave unresolved
      const title = snip.snippet?.title ?? null;
      const thumb = bestThumbnail(snip.snippet);
      const channelId = snip.snippet?.channelId ?? null;
      const channelName = snip.snippet?.channelTitle ?? null;
      const viewCount = parseInt(snip.statistics?.viewCount || '0') || 0;
      const likeCount = parseInt(snip.statistics?.likeCount || '0') || 0;
      const commentCount = parseInt(snip.statistics?.commentCount || '0') || 0;
      const postedAt = snip.snippet?.publishedAt ?? null;

      // Insert (or upsert on URL collision). keyword=<task niche tag>
      // so the operator can filter the DB by which seed-task brought a
      // given video in.
      const ins = await pool.query<{ id: number }>(
        `INSERT INTO niche_spy_videos
           (url, title, thumbnail, channel_id, channel_name,
            view_count, like_count, comment_count, posted_at,
            keyword, task_id, enriched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'video-seed', NOW())
         ON CONFLICT (url) DO UPDATE SET
           title = COALESCE(EXCLUDED.title, niche_spy_videos.title),
           thumbnail = COALESCE(EXCLUDED.thumbnail, niche_spy_videos.thumbnail),
           channel_id = COALESCE(EXCLUDED.channel_id, niche_spy_videos.channel_id),
           channel_name = COALESCE(EXCLUDED.channel_name, niche_spy_videos.channel_name),
           view_count = GREATEST(EXCLUDED.view_count, COALESCE(niche_spy_videos.view_count, 0)),
           like_count = GREATEST(EXCLUDED.like_count, COALESCE(niche_spy_videos.like_count, 0)),
           comment_count = GREATEST(EXCLUDED.comment_count, COALESCE(niche_spy_videos.comment_count, 0)),
           posted_at = COALESCE(EXCLUDED.posted_at, niche_spy_videos.posted_at)
         RETURNING id`,
        [
          `https://youtu.be/${ytId}`, title, thumb, channelId, channelName,
          viewCount, likeCount, commentCount, postedAt,
          keyword ?? 'video-seed',
        ],
      );
      byYtId.set(ytId, { id: ins.rows[0].id, title, thumbnail: thumb, has_v2: false, wasNew: true });
    }
  }

  // 3) Build the output in input-URL order.
  return urls.map((url, i) => {
    const yid = ytIds[i];
    if (!yid) return null;
    const row = byYtId.get(yid);
    if (!row) return null;
    return {
      videoId: row.id,
      ytId: yid,
      url,
      title: row.title,
      thumbnail: row.thumbnail,
      hadCombinedV2: row.has_v2,
      wasNew: row.wasNew,
    };
  });
}

/** Per-video outcome of the ensureCombinedV2 pipeline — surfaces in
 *  the API response so the operator can see exactly which step failed. */
export type EmbedOutcome =
  | { ok: true; cached: boolean }
  | { ok: false; reason: 'thumb_fetch_failed' | 'embed_api_failed' | 'persist_failed' | 'missing_title_or_thumb'; detail?: string };

/**
 * Embed any of the given rows that don't already have combined_v2
 * vectors. Writes to niche_video_vectors_combined_v2 and stamps
 * niche_spy_videos.combined_embedded_v2_at on success.
 *
 * Returns one outcome per videoId so the caller can surface the exact
 * failure mode (thumbnail unreachable, Gemini API down, persist crash).
 *
 * Embed-chunk retries: each Gemini call tries up to 3 fresh (key, proxy)
 * pairs before giving up on the whole chunk. Mirrors the resilient
 * pattern in /api/admin/tools/vid-gen/generate — a single bad key or
 * proxy shouldn't tank an entire seed expansion.
 */
async function ensureCombinedV2(
  rows: ResolvedVideo[],
  modelName = 'gemini-embedding-2-preview',
): Promise<Map<number, EmbedOutcome>> {
  const pool = await getPool();
  const outcomes = new Map<number, EmbedOutcome>();

  for (const r of rows) {
    if (r.hadCombinedV2) {
      outcomes.set(r.videoId, { ok: true, cached: true });
    } else if (!r.title || !r.thumbnail) {
      outcomes.set(r.videoId, { ok: false, reason: 'missing_title_or_thumb' });
    }
  }

  const needsEmbed = rows.filter(r => !r.hadCombinedV2 && r.title && r.thumbnail);
  if (needsEmbed.length === 0) return outcomes;

  // Step A: fetch thumbnail bytes in parallel; record thumb-fetch
  // failures so the caller can distinguish "YT IP block" from "Gemini
  // failed". 12s timeout per thumb is already in fetchThumbBase64.
  const groupsRaw = await Promise.all(
    needsEmbed.map(async r => {
      const img = await fetchThumbBase64(r.thumbnail!);
      if (!img) {
        outcomes.set(r.videoId, { ok: false, reason: 'thumb_fetch_failed' });
        return null;
      }
      return {
        row: r,
        group: [
          { type: 'text', text: (r.title || '').slice(0, 1000) },
          { type: 'image', mimeType: img.mimeType, data: img.data },
        ] as EmbedInput[],
      };
    }),
  );
  const valid = groupsRaw.filter((x): x is { row: ResolvedVideo; group: EmbedInput[] } => !!x);
  if (valid.length === 0) return outcomes;

  // Step B: Gemini batchEmbedGrouped takes up to 100 groups; chunk if
  // needed. batchEmbedGroupedDirect already rotates (key, proxy) pairs
  // internally up to 6 times per call, so one outer attempt with a
  // single retry is enough — the inner loop handles the common case
  // of dead proxies and banned keys.
  const CHUNK = 100;
  const EMBED_RETRIES = 2;
  const { vectorPool } = await import('./vector-db');

  for (let off = 0; off < valid.length; off += CHUNK) {
    const slice = valid.slice(off, off + CHUNK);
    let vectors: number[][] | null = null;
    let lastErr = '';
    for (let attempt = 1; attempt <= EMBED_RETRIES; attempt++) {
      try {
        vectors = await batchEmbedGroupedDirect(slice.map(s => s.group), modelName);
        break;
      } catch (err) {
        lastErr = (err as Error).message?.slice(0, 200) || 'unknown';
        console.warn(`[video-seed] embed chunk outer attempt ${attempt}/${EMBED_RETRIES} failed:`, lastErr);
      }
    }
    if (!vectors) {
      // All retries exhausted — mark every row in this chunk as failed.
      for (const s of slice) {
        outcomes.set(s.row.videoId, { ok: false, reason: 'embed_api_failed', detail: lastErr });
      }
      continue;
    }

    // Step C: persist. Vector DB + main DB. Per-row try/catch so one
    // bad insert doesn't lose the rest of the chunk.
    for (let i = 0; i < slice.length && i < vectors.length; i++) {
      const r = slice[i].row;
      const vec = vectors[i];
      const embStr = '[' + vec.join(',') + ']';
      try {
        // Vector DB: pgvector-backed, takes the bracket-string format.
        await vectorPool.query(
          `INSERT INTO niche_video_vectors_combined_v2 (video_id, keyword, embedding)
           VALUES ($1, $2, $3::vector)
           ON CONFLICT (video_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [r.videoId, 'video-seed', embStr],
        );
        // Main DB: column is REAL[] (no pgvector installed here). Pass
        // the raw JS number[] — node-postgres serialises to a PG array.
        // The previous `$1::vector` cast was a copy-paste bug that
        // failed silently on every write since pgvector isn't on this DB.
        await pool.query(
          `UPDATE niche_spy_videos SET combined_embedding_v2 = $1, combined_embedded_v2_at = NOW()
           WHERE id = $2`,
          [vec, r.videoId],
        );
        outcomes.set(r.videoId, { ok: true, cached: false });
      } catch (err) {
        const detail = (err as Error).message?.slice(0, 200);
        console.warn(`[video-seed] persist for video ${r.videoId} failed:`, detail);
        outcomes.set(r.videoId, { ok: false, reason: 'persist_failed', detail });
      }
    }
  }
  return outcomes;
}

export interface ExpandOpts {
  seedUrl: string;
  candidateUrls: string[];
  topK?: number;
  minSimilarity?: number;
  taskId?: string;
  keyword?: string;       // optional niche tag for grouping (e.g. "AI YT automation")
}

/**
 * Resolve seed + candidates, embed missing, cosine-compare,
 * rank, persist to niche_seed_expansions, and return.
 *
 * Always scores against the SEED. No drift across recursive xgodo
 * exploration — the caller should always pass the original seed URL.
 */
export async function expandFromSeed(opts: ExpandOpts): Promise<SeedExpandResult> {
  const pool = await getPool();
  const seedYt = extractYtVideoId(opts.seedUrl);
  if (!seedYt) throw new Error(`Invalid seed URL: cannot extract YT id from ${opts.seedUrl}`);
  if (opts.candidateUrls.length === 0) throw new Error('candidateUrls is empty');
  if (opts.candidateUrls.length > 200) throw new Error('candidateUrls capped at 200 per request');

  // Note: topK / minSimilarity inputs are now ignored. Caller wants
  // raw cosine scores on every candidate — no server-side match/no-match
  // verdict, which was unreliable anyway because reasonable thresholds
  // varied wildly by niche. The candidates array is still ranked by
  // similarity descending for convenience.

  // ── Step 1: resolve seed + candidates in one combined batch so the
  //    YT Data API call covers everything (1 quota unit for up to 50 ids).
  const t0 = Date.now();
  const allUrls = [opts.seedUrl, ...opts.candidateUrls];
  const resolved = await resolveBatch(allUrls, opts.keyword ?? null);
  const seedRow = resolved[0];
  if (!seedRow) throw new Error(`Could not resolve seed video metadata for ${opts.seedUrl}`);
  const candidateRows: Array<{ row: ResolvedVideo | null; url: string }> = opts.candidateUrls.map((url, i) => ({
    row: resolved[i + 1],
    url,
  }));
  const metadataMs = Date.now() - t0;

  // ── Step 2: embed missing combined_v2 vectors.
  const t1 = Date.now();
  const allRows = [seedRow, ...candidateRows.map(c => c.row).filter((r): r is ResolvedVideo => !!r)];
  const outcomes = await ensureCombinedV2(allRows);
  // Back-compat: previous code used a Set<number> of successful ids.
  // Build one from the new outcomes map.
  const embedded = new Set<number>(
    [...outcomes.entries()].filter(([, o]) => o.ok).map(([id]) => id),
  );
  const embeddingMs = Date.now() - t1;

  // ── Step 3: cosine similarity for each candidate vs the seed.
  //    Use halfvec to leverage the IVFFLAT index. <#> is negative inner
  //    product but for normalized vectors that's the same ranking as
  //    cosine. Easier to use <=> (cosine distance) and convert to
  //    similarity = 1 - distance.
  const t2 = Date.now();
  const candidateVideoIds = candidateRows
    .map(c => c.row?.videoId)
    .filter((id): id is number => id != null && embedded.has(id));

  let similarityMap = new Map<number, number>();
  if (candidateVideoIds.length > 0 && embedded.has(seedRow.videoId)) {
    const { vectorPool } = await import('./vector-db');
    const simRes = await vectorPool.query<{ video_id: number; sim: number }>(
      `WITH seed AS (
         SELECT embedding::halfvec(3072) AS emb
           FROM niche_video_vectors_combined_v2
          WHERE video_id = $1
       )
       SELECT v.video_id,
              1.0 - ((v.embedding::halfvec(3072)) <=> seed.emb) AS sim
         FROM niche_video_vectors_combined_v2 v, seed
        WHERE v.video_id = ANY($2::int[])`,
      [seedRow.videoId, candidateVideoIds],
    );
    similarityMap = new Map(simRes.rows.map(r => [r.video_id, parseFloat(String(r.sim))]));
  }
  const similarityMs = Date.now() - t2;

  // ── Step 4: build per-candidate result + rank by similarity desc.
  const built: SeedCandidate[] = candidateRows.map((c) => {
    if (!c.row) {
      return {
        videoId: null, ytId: extractYtVideoId(c.url) ?? '',
        url: c.url, title: null, thumbnail: null,
        similarity: null, rank: 0,
        wasNew: null,                // resolve failed — we don't know
        error: 'metadata fetch failed',
      };
    }
    const sim = similarityMap.get(c.row.videoId) ?? null;
    // Pull the precise failure reason from outcomes so the API caller
    // can tell "Gemini failed" from "YT blocked the thumbnail fetch".
    let error: string | undefined;
    if (sim == null) {
      const outcome = outcomes.get(c.row.videoId);
      if (outcome && outcome.ok === false) {
        const reason = outcome.reason;
        const detail = outcome.detail;
        error = detail ? `${reason}: ${detail}` : reason;
      } else {
        error = 'no embedding';
      }
    }
    return {
      videoId: c.row.videoId, ytId: c.row.ytId,
      url: c.url, title: c.row.title, thumbnail: c.row.thumbnail,
      similarity: sim,
      rank: 0,                       // assigned below
      wasNew: c.row.wasNew,
      error,
    };
  });

  // Rank: similarity descending, nulls last. Rank #1 = best score.
  const candidates = [...built].sort((a, b) => {
    if (a.similarity == null && b.similarity == null) return 0;
    if (a.similarity == null) return 1;
    if (b.similarity == null) return -1;
    return b.similarity - a.similarity;
  });
  candidates.forEach((c, i) => { c.rank = i + 1; });

  // ── Step 5: persist to niche_seed_expansions for the live admin feed.
  // matched / threshold columns kept in the schema for back-compat but
  // we no longer compute them — passing NULL on the threshold column
  // and FALSE on matched (the column is NOT NULL in the schema).
  const t3 = Date.now();
  if (candidates.length > 0) {
    const rows: string[] = [];
    const args: (number | string | boolean | null)[] = [];
    let p = 1;
    for (const c of candidates) {
      rows.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      args.push(
        seedRow.videoId, seedRow.url,
        c.videoId, c.url, c.title, c.thumbnail,
        c.similarity, false /* matched — deprecated, always false */, null /* threshold */,
        c.rank, opts.taskId ?? null, opts.keyword ?? null,
        c.error ?? null,
        c.wasNew,
      );
    }
    await pool.query(
      `INSERT INTO niche_seed_expansions
         (seed_video_id, seed_url, candidate_video_id, candidate_url, candidate_title, candidate_thumbnail,
          similarity, matched, threshold, rank_in_batch, task_id, keyword, error_message, candidate_was_new)
       VALUES ${rows.join(', ')}`,
      args,
    );
  }
  const persistMs = Date.now() - t3;

  const seedOutcome = outcomes.get(seedRow.videoId);
  let seedEmbedError: string | undefined;
  if (seedOutcome && seedOutcome.ok === false) {
    const reason = seedOutcome.reason;
    const detail = seedOutcome.detail;
    seedEmbedError = detail ? `${reason}: ${detail}` : reason;
  }
  return {
    seed: {
      videoId: seedRow.videoId,
      ytId: seedRow.ytId,
      url: seedRow.url,
      title: seedRow.title,
      thumbnail: seedRow.thumbnail,
      embeddingCached: seedRow.hadCombinedV2,
      embedError: seedEmbedError,
    },
    candidates,
    taskId: opts.taskId ?? null,
    keyword: opts.keyword ?? null,
    timings: { metadataMs, embeddingMs, similarityMs, persistMs },
  };
}
