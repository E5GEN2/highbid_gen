import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { ytFetchViaProxy } from '@/lib/yt-proxy-fetch';
import { getRandomProxy } from '@/lib/xgodo-proxy';
import type { YtKeyProxyPair } from '@/lib/yt-keys';

/**
 * POST /api/admin/tools/yt-keys-health/probe
 *
 * Single-key diagnostic probe. Routes through the same xgodo proxy
 * stack as the sweep (and production enrichment) and returns the
 * raw outcome, the YT API response body, and the proxy device that
 * was used. Doesn't update the DB by default — set { write: true }
 * to mirror the sweep's classification action.
 *
 * Body:
 *   {
 *     keyId?:   number;   // pick by xgodo_api_keys.id
 *     key?:     string;   // ...or by raw key string. One of these required.
 *     videoId?: string;   // override the test video (default: dQw4w9WgXcQ)
 *     tries?:   number;   // run N probes back-to-back (default 1) — useful
 *                         //   for spotting flaky proxies vs hard-broken keys.
 *     write?:   boolean;  // when true + outcome is terminal (quota/suspended),
 *                         //   apply the same DB updates a sweep would.
 *   }
 *
 * Auth: admin Bearer token.
 *
 * Returns: { ok, key: {id,preview,status,banned_until,...}, tries: [...] }
 * Each try carries outcome, httpStatus, reason, errorMessage, proxyUsed,
 * elapsedMs.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const DEFAULT_TEST_VIDEO = 'dQw4w9WgXcQ';

type Outcome = 'working' | 'quotaExceeded' | 'suspended' | 'other' | 'network';

async function probeOnce(key: string, videoId: string) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${key}`;
  const proxy = await getRandomProxy();
  const pair: YtKeyProxyPair = {
    key,
    proxyUrl: proxy?.url ?? '',
    proxyDeviceId: proxy?.deviceId?.substring(0, 8) ?? 'no-proxy',
    banned: false,
    banExpiry: 0,
  };
  const t0 = Date.now();
  const res = await ytFetchViaProxy(url, pair.proxyUrl ? pair : undefined);
  const elapsedMs = Date.now() - t0;
  const httpStatus = res.status || null;
  const proxyUsed = res.proxyUsed;

  let outcome: Outcome;
  let reason: string | undefined;
  let errorMessage: string | undefined;
  let snippet: { title?: string; channelTitle?: string } | null = null;

  if (res.status === 0 || res.data == null) {
    outcome = 'network';
    errorMessage = res.error?.slice(0, 300);
  } else {
    const data = res.data as {
      items?: Array<{ snippet?: { title?: string; channelTitle?: string } }>;
      error?: { errors?: { reason?: string }[]; message?: string };
    };
    if (data.error) {
      reason = data.error.errors?.[0]?.reason ?? 'unknown';
      errorMessage = data.error.message;
      outcome = reason === 'quotaExceeded' ? 'quotaExceeded'
              : reason === 'forbidden'     ? 'suspended'
              :                              'other';
    } else if (Array.isArray(data.items) && data.items.length > 0) {
      outcome = 'working';
      snippet = data.items[0]?.snippet ?? null;
    } else {
      outcome = 'other';
      errorMessage = 'response had no items + no error';
    }
  }

  return { outcome, httpStatus, reason, errorMessage, proxyUsed, elapsedMs, snippet };
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as {
    keyId?: number; key?: string; videoId?: string; tries?: number; write?: boolean;
  };

  const tries = Math.max(1, Math.min(body.tries ?? 1, 5));
  const videoId = (body.videoId || DEFAULT_TEST_VIDEO).trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: 'videoId must be 11 YT chars' }, { status: 400 });
  }

  const pool = await getPool();

  // Resolve the key. Either keyId or key (string). Pull the full
  // row so the response surfaces current DB state alongside the
  // probe outcomes — useful for "did the sweep just ban this?"
  let keyRow: {
    id: number; key: string; status: string;
    banned_until: string | null; invalidated_at: string | null;
    last_used_at: string | null;
  } | undefined;

  if (body.keyId != null && Number.isFinite(body.keyId)) {
    const r = await pool.query(
      `SELECT id, key, status, banned_until, invalidated_at, last_used_at
         FROM xgodo_api_keys WHERE id = $1 AND service='youtube_data'`,
      [body.keyId],
    );
    keyRow = r.rows[0];
  } else if (typeof body.key === 'string' && body.key.length > 10) {
    const r = await pool.query(
      `SELECT id, key, status, banned_until, invalidated_at, last_used_at
         FROM xgodo_api_keys WHERE key = $1 AND service='youtube_data'`,
      [body.key],
    );
    keyRow = r.rows[0];
  } else {
    return NextResponse.json({ error: 'keyId (number) or key (string) required' }, { status: 400 });
  }
  if (!keyRow) return NextResponse.json({ error: 'key not found' }, { status: 404 });

  // Run N probes sequentially. Each gets its own random proxy so
  // re-tries decouple from a single flaky route — same pattern the
  // sweep uses across many keys, here applied to one key N times.
  const results: Array<Awaited<ReturnType<typeof probeOnce>>> = [];
  for (let i = 0; i < tries; i++) {
    results.push(await probeOnce(keyRow.key, videoId));
  }

  // Optional DB write — only when explicitly requested AND all
  // tries agree on a terminal outcome. We DON'T flip status='active'
  // here even if all tries work; that's left to the sweep so a
  // single lucky probe can't unban a broken key prematurely.
  let dbUpdate: { applied: boolean; status?: string } = { applied: false };
  if (body.write) {
    const allQuota   = results.every(r => r.outcome === 'quotaExceeded');
    const allSusp    = results.every(r => r.outcome === 'suspended');
    if (allQuota) {
      await pool.query(
        `UPDATE xgodo_api_keys
            SET status='banned', banned_until = NOW() + INTERVAL '12 hours'
          WHERE id = $1`,
        [keyRow.id],
      );
      dbUpdate = { applied: true, status: 'banned' };
    } else if (allSusp) {
      await pool.query(
        `UPDATE xgodo_api_keys
            SET status='invalid', invalidated_at = NOW()
          WHERE id = $1`,
        [keyRow.id],
      );
      dbUpdate = { applied: true, status: 'invalid' };
    }
  }

  // Refresh the row so the response reflects post-write state.
  const refreshed = await pool.query(
    `SELECT status, banned_until, invalidated_at FROM xgodo_api_keys WHERE id = $1`,
    [keyRow.id],
  );
  const after = refreshed.rows[0] ?? {};

  return NextResponse.json({
    ok: true,
    key: {
      id: keyRow.id,
      preview: `${keyRow.key.slice(0, 12)}…`,
      statusBefore: keyRow.status,
      bannedUntilBefore: keyRow.banned_until,
      invalidatedAtBefore: keyRow.invalidated_at,
      statusAfter: after.status,
      bannedUntilAfter: after.banned_until,
      invalidatedAtAfter: after.invalidated_at,
    },
    videoId,
    tries: results.map((r, i) => ({ attempt: i + 1, ...r })),
    consensus: results.length > 1
      ? (() => {
          const counts = new Map<Outcome, number>();
          for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
          return [...counts.entries()]
            .map(([outcome, count]) => ({ outcome, count }))
            .sort((a, b) => b.count - a.count);
        })()
      : undefined,
    dbUpdate,
  });
}
