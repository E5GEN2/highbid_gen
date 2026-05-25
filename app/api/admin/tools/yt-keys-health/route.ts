import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { ytFetchViaProxy } from '@/lib/yt-proxy-fetch';
import { getRandomProxy } from '@/lib/xgodo-proxy';
import type { YtKeyProxyPair } from '@/lib/yt-keys';

/**
 * POST /api/admin/tools/yt-keys-health
 *
 * Probes a sample of `xgodo_api_keys` (service='youtube_data') against
 * a guaranteed-fetchable test video and classifies each key. Updates
 * the DB so subsequent picks from `pickRandomActiveYtPair` stop
 * landing on dead keys:
 *
 *   working            →  status='active'   + banned_until=NULL
 *                         (clears any expired ban, in case the key
 *                          recovered after a quota reset).
 *   quotaExceeded      →  status='banned'   + banned_until=NOW()+12h
 *                         (Google quotas reset at midnight Pacific;
 *                          12h is safely longer than the worst-case
 *                          wait and self-heals on the next probe.)
 *   CONSUMER_SUSPENDED →  status='invalid'  + invalidated_at=NOW()
 *                         (permanent; key won't recover without
 *                          manual GCP-side action.)
 *   network/other      →  no DB change. Don't punish flaky probes.
 *
 * Sample = active OR (banned AND banned_until < NOW). The second
 * clause lets banned-but-recovered keys get re-checked.
 *
 * Body:
 *   {
 *     limit?:       number;   // default 500 keys per call. Repeated
 *                             // calls cover the rest of the pool.
 *     concurrency?: number;   // default 20 in-flight probes. Each
 *                             // probe spawns a Python subprocess via
 *                             // ytFetchViaProxy so 20 keeps the
 *                             // server's memory + fd budget sane.
 *     dryRun?:      boolean;  // probe + classify only, no DB writes.
 *   }
 *
 * Probes go through the SAME proxy stack the enrichment pipeline
 * uses (ytFetchViaProxy → Python+curl via xgodo proxy). Each probe
 * pairs the candidate key with a freshly-picked random proxy so a
 * single flaky proxy can't take out a whole sample. Mirrors the
 * production call path's reliability profile.
 *
 * Auth: admin Bearer token. Synchronous — returns when done. Use
 * limit + repeated calls to chew through a 4k-key pool without
 * blowing the maxDuration ceiling.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

const TEST_VIDEO_ID = 'dQw4w9WgXcQ'; // Public, geo-unrestricted, never going anywhere.

type Outcome = 'working' | 'quotaExceeded' | 'suspended' | 'other' | 'network';

interface ProbeResult {
  keyId: number;
  keyPreview: string;
  outcome: Outcome;
  httpStatus: number | null;
  reason?: string;     // YT error reason if any
  errorMessage?: string;
  proxyUsed?: string;  // which proxy device routed this probe
}

/**
 * Probe one key by routing the request through the same xgodo
 * proxy stack the enrichment pipeline uses (lib/yt-proxy-fetch.ts).
 * Each probe pairs the candidate key with a freshly-picked random
 * proxy so a single flaky proxy can't take down a batch — same
 * decoupling pickRandomActiveYtPair does for the real call path.
 *
 * Outcome mapping from YtFetchResult:
 *   status === 0     → network (subprocess/proxy failure)
 *   YT error reason  → quotaExceeded / suspended / other
 *   ok + items[]     → working
 *   ok + no items    → other
 */
async function probeOne(key: string): Promise<{ outcome: Outcome; httpStatus: number | null; reason?: string; errorMessage?: string; proxyUsed?: string }> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${TEST_VIDEO_ID}&key=${key}`;

  // Build a one-off pair: this specific key + a fresh random proxy.
  // The proxy can be null when the pool is empty; in that case
  // ytFetchViaProxy falls back to direct fetch (mirrors what the
  // real path does when no proxy is available).
  const proxy = await getRandomProxy();
  const pair: YtKeyProxyPair = {
    key,
    proxyUrl: proxy?.url ?? '',
    proxyDeviceId: proxy?.deviceId?.substring(0, 8) ?? 'no-proxy',
    banned: false,
    banExpiry: 0,
  };

  const res = await ytFetchViaProxy(url, pair.proxyUrl ? pair : undefined);
  const httpStatus = res.status || null;
  const proxyUsed = res.proxyUsed;

  // Subprocess / network failure — keep status=0 separate from API
  // errors so we don't punish a key for a flaky proxy.
  if (res.status === 0 || res.data == null) {
    return {
      outcome: 'network',
      httpStatus,
      errorMessage: res.error?.slice(0, 200),
      proxyUsed,
    };
  }

  const data = res.data as { items?: unknown[]; error?: { errors?: { reason?: string }[]; message?: string } };
  if (data.error) {
    const reason = data.error.errors?.[0]?.reason ?? 'unknown';
    if (reason === 'quotaExceeded') {
      return { outcome: 'quotaExceeded', httpStatus, reason, errorMessage: data.error.message, proxyUsed };
    }
    if (reason === 'forbidden') {
      // CONSUMER_SUSPENDED lives under forbidden. Anything else
      // under forbidden Google returns for un-recoverable keys
      // (IP-restriction etc.) — treat them all as terminal.
      return { outcome: 'suspended', httpStatus, reason, errorMessage: data.error.message, proxyUsed };
    }
    return { outcome: 'other', httpStatus, reason, errorMessage: data.error.message, proxyUsed };
  }
  if (Array.isArray(data.items) && data.items.length > 0) {
    return { outcome: 'working', httpStatus, proxyUsed };
  }
  return { outcome: 'other', httpStatus, errorMessage: 'response had no items + no error', proxyUsed };
}

/**
 * Promise.all-with-bounded-concurrency. Equivalent to a small
 * worker pool — fans out N at a time until items is empty.
 */
async function runConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as {
    limit?: number; concurrency?: number; dryRun?: boolean;
  };
  const limit       = Math.max(1,  Math.min(body.limit       ?? 500, 2000));
  // Each probe spawns a Python subprocess via ytFetchViaProxy.
  // 20 in-flight keeps memory + fd usage comfortable on Railway;
  // hard cap at 50 so a misconfigured client can't OOM the box.
  const concurrency = Math.max(1,  Math.min(body.concurrency ?? 20,  50));
  const dryRun      = !!body.dryRun;

  const pool = await getPool();

  // Candidate set: active keys + previously-banned keys whose ban
  // window expired. Random sample so repeated calls cover the pool.
  const candidates = await pool.query<{ id: number; key: string }>(
    `SELECT id, key
       FROM xgodo_api_keys
      WHERE service = 'youtube_data'
        AND (
          status = 'active'
          OR (status = 'banned' AND (banned_until IS NULL OR banned_until < NOW()))
        )
      ORDER BY RANDOM()
      LIMIT $1`,
    [limit],
  );

  const startedAt = Date.now();
  const results = await runConcurrent(candidates.rows, concurrency, async row => {
    const r = await probeOne(row.key);
    const out: ProbeResult = {
      keyId: row.id,
      keyPreview: `${row.key.slice(0, 12)}…`,
      outcome: r.outcome,
      httpStatus: r.httpStatus,
      reason: r.reason,
      errorMessage: r.errorMessage,
      proxyUsed: r.proxyUsed,
    };
    return out;
  });

  // Tally for the response summary.
  const summary = {
    working: 0, quotaExceeded: 0, suspended: 0, other: 0, network: 0,
  };
  for (const r of results) summary[r.outcome]++;

  // Apply DB updates. Three separate UPDATEs keyed by id arrays so
  // the SQL stays simple — same total cost as one CASE statement
  // because each query hits the PK. Skipped when dryRun.
  let dbUpdates = { activated: 0, banned: 0, invalidated: 0 };
  if (!dryRun) {
    const workingIds      = results.filter(r => r.outcome === 'working').map(r => r.keyId);
    const quotaIds        = results.filter(r => r.outcome === 'quotaExceeded').map(r => r.keyId);
    const suspendedIds    = results.filter(r => r.outcome === 'suspended').map(r => r.keyId);

    if (workingIds.length > 0) {
      const u = await pool.query(
        `UPDATE xgodo_api_keys
            SET status = 'active',
                banned_until = NULL
          WHERE id = ANY($1::int[])
            AND (status != 'active' OR banned_until IS NOT NULL)`,
        [workingIds],
      );
      dbUpdates.activated = u.rowCount ?? 0;
    }
    if (quotaIds.length > 0) {
      const u = await pool.query(
        `UPDATE xgodo_api_keys
            SET status = 'banned',
                banned_until = NOW() + INTERVAL '12 hours'
          WHERE id = ANY($1::int[])`,
        [quotaIds],
      );
      dbUpdates.banned = u.rowCount ?? 0;
    }
    if (suspendedIds.length > 0) {
      const u = await pool.query(
        `UPDATE xgodo_api_keys
            SET status = 'invalid',
                invalidated_at = NOW()
          WHERE id = ANY($1::int[])`,
        [suspendedIds],
      );
      dbUpdates.invalidated = u.rowCount ?? 0;
    }
  }

  // Pool-wide totals AFTER updates so the caller sees the net
  // effect of this run on the pool composition.
  const poolAfter = await pool.query<{
    active: string; banned: string; invalid: string; disabled: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status='active')   ::text AS active,
       COUNT(*) FILTER (WHERE status='banned')   ::text AS banned,
       COUNT(*) FILTER (WHERE status='invalid')  ::text AS invalid,
       COUNT(*) FILTER (WHERE status='disabled') ::text AS disabled
       FROM xgodo_api_keys
      WHERE service='youtube_data'`,
  );
  const poolStats = poolAfter.rows[0];

  return NextResponse.json({
    ok: true,
    dryRun,
    probed: candidates.rows.length,
    elapsedMs: Date.now() - startedAt,
    concurrency,
    sample: summary,                  // outcomes for the keys this run probed
    dbUpdates,                        // rows actually changed in the DB
    pool: {                           // total xgodo_api_keys with service='youtube_data'
      active:   parseInt(poolStats?.active   ?? '0'),
      banned:   parseInt(poolStats?.banned   ?? '0'),
      invalid:  parseInt(poolStats?.invalid  ?? '0'),
      disabled: parseInt(poolStats?.disabled ?? '0'),
    },
    // First few non-working samples — helps spot a misclassified
    // bucket without trawling all 500 results.
    examples: results
      .filter(r => r.outcome !== 'working')
      .slice(0, 5)
      .map(r => ({
        keyPreview: r.keyPreview,
        outcome: r.outcome,
        reason: r.reason,
        proxyUsed: r.proxyUsed,
        errorMessage: r.errorMessage?.slice(0, 120),
      })),
  });
}

/**
 * GET /api/admin/tools/yt-keys-health
 *
 * Lightweight read-only status snapshot — same pool composition the
 * POST returns at the end, with no probing or writes. Handy for
 * dashboard polling.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const pool = await getPool();
  const r = await pool.query<{
    service: string; status: string; n: string;
    banned_recoverable: string;
  }>(
    `SELECT service, status, COUNT(*)::text AS n,
            COUNT(*) FILTER (WHERE status='banned' AND (banned_until IS NULL OR banned_until < NOW()))::text AS banned_recoverable
       FROM xgodo_api_keys
       WHERE service IN ('youtube_data','google_ai_studio')
       GROUP BY service, status
       ORDER BY service, status`,
  );
  return NextResponse.json({ ok: true, rows: r.rows });
}
