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

import { getPool } from './db';
import { pickRandomActiveYtPair } from './yt-keys';
import { ytFetchViaProxy } from './yt-proxy-fetch';
import { batchEmbedGrouped, type EmbedInput } from './embeddings';

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
  matched: boolean;
  rank: number;
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
  candidates: SeedCandidate[];     // every candidate we processed, in submitted order
  matches: SeedCandidate[];        // filtered subset (above threshold OR top-K)
  threshold: number | null;
  topK: number | null;
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

/** Hit YT Data API videos.list for ≤50 ids in one call. */
async function fetchYtVideoMeta(ytIds: string[]): Promise<Map<string, YtVideoSnippet>> {
  const map = new Map<string, YtVideoSnippet>();
  if (ytIds.length === 0) return map;
  const pair = await pickRandomActiveYtPair();
  if (!pair) return map;
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ytIds.join(',')}&key=${pair.key}`;
  const res = await ytFetchViaProxy(url, pair);
  if (!res.ok) return map;
  const data = res.data as YtVideosListResponse;
  for (const item of data.items ?? []) {
    if (item.id) map.set(item.id, item);
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
  //    We key on the URL match — niche_spy_videos.url is the canonical
  //    "https://youtu.be/<id>" form for inserted rows.
  const existRes = await pool.query<{ id: number; url: string; title: string | null; thumbnail: string | null; has_v2: boolean }>(
    `SELECT id, url, title, thumbnail,
            (combined_embedding_v2 IS NOT NULL) AS has_v2
       FROM niche_spy_videos
      WHERE url = ANY($1::text[])
         OR url ~ ANY($2::text[])`,
    [
      validIds.map(id => `https://youtu.be/${id}`),
      validIds.map(id => `[?&]v=${id}\\b|/${id}\\b`),
    ],
  );
  const byYtId = new Map<string, { id: number; title: string | null; thumbnail: string | null; has_v2: boolean }>();
  for (const row of existRes.rows) {
    const yid = extractYtVideoId(row.url);
    if (yid) byYtId.set(yid, { id: row.id, title: row.title, thumbnail: row.thumbnail, has_v2: row.has_v2 });
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
      byYtId.set(ytId, { id: ins.rows[0].id, title, thumbnail: thumb, has_v2: false });
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
  // needed. Retry each chunk up to 3 times with a fresh pair on failure
  // (batchEmbedGrouped picks the pair internally — we just retry).
  const CHUNK = 100;
  const EMBED_RETRIES = 5;
  const { vectorPool } = await import('./vector-db');

  for (let off = 0; off < valid.length; off += CHUNK) {
    const slice = valid.slice(off, off + CHUNK);
    let vectors: number[][] | null = null;
    let lastErr = '';
    for (let attempt = 1; attempt <= EMBED_RETRIES; attempt++) {
      try {
        vectors = await batchEmbedGrouped(slice.map(s => s.group), modelName);
        break;
      } catch (err) {
        lastErr = (err as Error).message?.slice(0, 200) || 'unknown';
        console.warn(`[video-seed] embed chunk attempt ${attempt}/${EMBED_RETRIES} failed:`, lastErr);
        // Small linear backoff between retries so the project-ban DB
        // UPDATE (fire-and-forget on banKey, awaited on banProject) has
        // a moment to settle, and we don't burn through 5 retries in 6s
        // hitting the same per-minute quota window.
        if (attempt < EMBED_RETRIES) {
          await new Promise(r => setTimeout(r, 500 * attempt));
        }
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
        await vectorPool.query(
          `INSERT INTO niche_video_vectors_combined_v2 (video_id, keyword, embedding)
           VALUES ($1, $2, $3::vector)
           ON CONFLICT (video_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [r.videoId, 'video-seed', embStr],
        );
        await pool.query(
          `UPDATE niche_spy_videos SET combined_embedding_v2 = $1::vector, combined_embedded_v2_at = NOW()
           WHERE id = $2`,
          [embStr, r.videoId],
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

  const topK = opts.topK ?? null;
  const threshold = opts.minSimilarity ?? null;
  if (topK == null && threshold == null) {
    // Default: top 20 if neither specified
    opts.topK = 20;
  }

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

  // ── Step 4: build per-candidate result, rank, decide matched.
  const candidates: SeedCandidate[] = candidateRows.map((c, i) => {
    if (!c.row) {
      return {
        videoId: null, ytId: extractYtVideoId(c.url) ?? '',
        url: c.url, title: null, thumbnail: null,
        similarity: null, matched: false, rank: i + 1,
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
      matched: false,   // populated below
      rank: i + 1,
      error,
    };
  });

  // Sort by similarity descending (nulls last) to rank, then mark matched.
  const ranked = [...candidates].sort((a, b) => {
    if (a.similarity == null && b.similarity == null) return 0;
    if (a.similarity == null) return 1;
    if (b.similarity == null) return -1;
    return b.similarity - a.similarity;
  });
  if (topK != null) {
    for (let i = 0; i < ranked.length && i < topK; i++) {
      if (ranked[i].similarity != null) ranked[i].matched = true;
    }
  }
  if (threshold != null) {
    for (const r of ranked) {
      if (r.similarity != null && r.similarity >= threshold) r.matched = true;
    }
  }
  // Reflect matched back into the original-order array.
  const matchedSet = new Set(ranked.filter(r => r.matched).map(r => r.url));
  for (const c of candidates) if (matchedSet.has(c.url)) c.matched = true;
  // Re-assign rank based on sorted order so the UI can show rank #1 = best match.
  ranked.forEach((r, idx) => {
    const orig = candidates.find(c => c.url === r.url);
    if (orig) orig.rank = idx + 1;
  });

  // ── Step 5: persist to niche_seed_expansions for the live admin feed.
  const t3 = Date.now();
  if (candidates.length > 0) {
    const rows: string[] = [];
    const args: (number | string | boolean | null)[] = [];
    let p = 1;
    for (const c of candidates) {
      rows.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      args.push(
        seedRow.videoId, seedRow.url,
        c.videoId, c.url, c.title, c.thumbnail,
        c.similarity, c.matched, threshold,
        c.rank, opts.taskId ?? null, opts.keyword ?? null,
        c.error ?? null,
      );
    }
    await pool.query(
      `INSERT INTO niche_seed_expansions
         (seed_video_id, seed_url, candidate_video_id, candidate_url, candidate_title, candidate_thumbnail,
          similarity, matched, threshold, rank_in_batch, task_id, keyword, error_message)
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
    matches: candidates.filter(c => c.matched),
    threshold,
    topK,
    taskId: opts.taskId ?? null,
    keyword: opts.keyword ?? null,
    timings: { metadataMs, embeddingMs, similarityMs, persistMs },
  };
}
