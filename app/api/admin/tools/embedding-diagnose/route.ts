import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * GET /api/admin/tools/embedding-diagnose?limit=50&target=combined_v2
 *
 * Sample the embedding job's actual work queue and inspect each step.
 * Pulls N unembedded videos with the same SELECT the live worker uses,
 * runs thumbnailUrlFor + fetchImageBase64 on each, and returns:
 *
 *   - per-row breakdown: id, thumb/url presence, picked url, HTTP status,
 *                        latency, byte size, failure reason
 *   - aggregate breakdown: bucketed counts by failure category
 *
 * Use this when the embedding job's error counter spikes and you want to
 * know whether it's keys, proxies, thumbnails, or something else. The
 * "1805 errors / 0 processed" pattern on combined_v2 turned out to be
 * thumbnail-fetch failures, not API failures — this endpoint surfaces
 * exactly which step is failing.
 */

type Target = 'combined_v2' | 'thumbnail_v2';

interface Sample {
  id: number;
  hasDbThumbnail: boolean;
  hasUrl: boolean;
  picked_url: string | null;
  picked_source: 'db_thumbnail' | 'youtube_id_from_url' | 'none';
  fetch_ok: boolean;
  fetch_status: number | null;
  fetch_ms: number;
  fetch_bytes: number | null;
  fetch_mime: string | null;
  failure_reason: string | null;
}

function thumbnailUrlFor(row: { thumbnail: string | null; url: string | null }): {
  url: string | null;
  source: Sample['picked_source'];
} {
  if (row.thumbnail && row.thumbnail.trim().length > 0) {
    return { url: row.thumbnail, source: 'db_thumbnail' };
  }
  const m = row.url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (m) return { url: `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`, source: 'youtube_id_from_url' };
  return { url: null, source: 'none' };
}

async function probeThumbnail(url: string): Promise<{
  ok: boolean;
  status: number | null;
  ms: number;
  bytes: number | null;
  mime: string | null;
  reason: string | null;
}> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    const ms = Date.now() - t0;
    const mime = res.headers.get('content-type')?.split(';')[0].trim() ?? null;
    if (!res.ok) {
      return { ok: false, status: res.status, ms, bytes: null, mime, reason: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // YouTube returns a 120-byte "no thumbnail" placeholder JPG for missing
    // videos with HTTP 200. Treat sub-1KB responses as effectively no image.
    if (buf.length < 1024) {
      return { ok: false, status: res.status, ms, bytes: buf.length, mime, reason: `too-small (${buf.length}B placeholder)` };
    }
    return { ok: true, status: res.status, ms, bytes: buf.length, mime, reason: null };
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = (err as Error).message?.slice(0, 200) || 'unknown';
    let reason = msg;
    if (msg.includes('timeout') || msg.includes('aborted')) reason = `timeout (${ms}ms)`;
    else if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) reason = 'DNS failure';
    else if (msg.includes('ECONNREFUSED')) reason = 'connection refused';
    else if (msg.includes('certificate') || msg.includes('CERT')) reason = 'TLS error';
    return { ok: false, status: null, ms, bytes: null, mime: null, reason };
  }
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const target = ((sp.get('target') || 'combined_v2') as Target);
  const limit = Math.min(parseInt(sp.get('limit') || '50') || 50, 500);
  const concurrency = Math.min(parseInt(sp.get('concurrency') || '10') || 10, 30);
  // `worker` = mimic the live embedding job's score-based ordering
  // (highest-score-first). `newest` = ORDER BY id DESC (default before).
  // `random` = TABLESAMPLE-ish sample. Use 'worker' to reproduce what the
  // job is actually chewing through.
  const order = (sp.get('order') || 'newest').toLowerCase();

  const pool = await getPool();

  // Exact same SELECT the live worker uses for combined_v2 — so the
  // sample is representative of the actual work queue.
  const conditions: string[] = [];
  if (target === 'combined_v2') {
    conditions.push(`combined_embedded_v2_at IS NULL`);
    conditions.push(`title IS NOT NULL AND title != ''`);
    conditions.push(`((thumbnail IS NOT NULL AND thumbnail != '') OR (url IS NOT NULL AND url != ''))`);
  } else if (target === 'thumbnail_v2') {
    conditions.push(`thumbnail_embedded_v2_at IS NULL`);
    conditions.push(`((thumbnail IS NOT NULL AND thumbnail != '') OR (url IS NOT NULL AND url != ''))`);
  }

  let orderClause: string;
  if (order === 'worker') {
    // Match the live worker's ORDER BY (score-based) so we sample the
    // exact rows it's currently trying. High-score rows tend to be
    // older content where YouTube has revoked thumbnails for deleted /
    // privated / age-restricted videos — that's where failures cluster.
    orderClause = 'score DESC NULLS LAST';
  } else if (order === 'random') {
    orderClause = 'random()';
  } else {
    orderClause = 'id DESC';
  }
  const sampleRes = await pool.query<{ id: number; thumbnail: string | null; url: string | null }>(
    `SELECT id, thumbnail, url FROM niche_spy_videos
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderClause}
      LIMIT $1`,
    [limit],
  );

  // Concurrent fetches, capped at `concurrency`. Each row is its own
  // probe; we accumulate per-row results.
  let cursor = 0;
  const samples: Sample[] = new Array(sampleRes.rows.length);
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= sampleRes.rows.length) return;
      const row = sampleRes.rows[i];
      const picked = thumbnailUrlFor(row);
      if (!picked.url) {
        samples[i] = {
          id: row.id,
          hasDbThumbnail: !!(row.thumbnail && row.thumbnail.trim()),
          hasUrl: !!(row.url && row.url.trim()),
          picked_url: null,
          picked_source: 'none',
          fetch_ok: false,
          fetch_status: null,
          fetch_ms: 0,
          fetch_bytes: null,
          fetch_mime: null,
          failure_reason: 'no thumbnail url derivable',
        };
        continue;
      }
      const probe = await probeThumbnail(picked.url);
      samples[i] = {
        id: row.id,
        hasDbThumbnail: !!(row.thumbnail && row.thumbnail.trim()),
        hasUrl: !!(row.url && row.url.trim()),
        picked_url: picked.url,
        picked_source: picked.source,
        fetch_ok: probe.ok,
        fetch_status: probe.status,
        fetch_ms: probe.ms,
        fetch_bytes: probe.bytes,
        fetch_mime: probe.mime,
        failure_reason: probe.reason,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sampleRes.rows.length) }, () => worker()));

  // Bucket the failures so the operator gets a quick summary without
  // having to eyeball N rows. Categories are heuristic but tight enough
  // for triage.
  const buckets: Record<string, number> = {};
  for (const s of samples) {
    let key: string;
    if (s.fetch_ok) key = 'ok';
    else if (s.failure_reason?.startsWith('HTTP 4')) key = `${s.failure_reason}`;
    else if (s.failure_reason?.startsWith('HTTP 5')) key = `${s.failure_reason}`;
    else if (s.failure_reason?.startsWith('too-small')) key = 'too-small (placeholder)';
    else if (s.failure_reason?.startsWith('timeout')) key = 'timeout';
    else if (s.failure_reason === 'DNS failure') key = 'DNS failure';
    else if (s.failure_reason === 'no thumbnail url derivable') key = 'no thumbnail url';
    else key = `other: ${s.failure_reason?.slice(0, 50) ?? '?'}`;
    buckets[key] = (buckets[key] ?? 0) + 1;
  }

  const okCount = samples.filter(s => s.fetch_ok).length;
  return NextResponse.json({
    target,
    order,
    sample_size: samples.length,
    ok: okCount,
    failed: samples.length - okCount,
    success_pct: samples.length > 0 ? Math.round((okCount / samples.length) * 10000) / 100 : 0,
    failure_buckets: buckets,
    samples,
  });
}
