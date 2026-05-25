import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

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
 *     concurrency?: number;   // default 50 in-flight probes.
 *     dryRun?:      boolean;  // probe + classify only, no DB writes.
 *   }
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
}

async function probeOne(key: string): Promise<{ outcome: Outcome; httpStatus: number | null; reason?: string; errorMessage?: string }> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${TEST_VIDEO_ID}&key=${key}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const httpStatus = res.status;
    const text = await res.text();
    let parsed: { items?: unknown[]; error?: { errors?: { reason?: string }[]; message?: string } } | null = null;
    try { parsed = JSON.parse(text); } catch { /* leave null */ }

    if (parsed?.error) {
      const reason = parsed.error.errors?.[0]?.reason ?? 'unknown';
      if (reason === 'quotaExceeded') {
        return { outcome: 'quotaExceeded', httpStatus, reason, errorMessage: parsed.error.message };
      }
      if (reason === 'forbidden') {
        // CONSUMER_SUSPENDED lives under forbidden — message is the
        // canonical "Permission denied: Consumer '...' has been
        // suspended." Treat anything else under forbidden as
        // suspended too; in practice that's what Google returns
        // for keys we can't recover from automatically.
        return { outcome: 'suspended', httpStatus, reason, errorMessage: parsed.error.message };
      }
      return { outcome: 'other', httpStatus, reason, errorMessage: parsed.error.message };
    }
    if (Array.isArray(parsed?.items) && parsed.items.length > 0) {
      return { outcome: 'working', httpStatus };
    }
    return { outcome: 'other', httpStatus, errorMessage: 'response had no items + no error' };
  } catch (err) {
    return {
      outcome: 'network',
      httpStatus: null,
      errorMessage: (err as Error).message?.slice(0, 200),
    };
  }
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
  const concurrency = Math.max(1,  Math.min(body.concurrency ?? 50,  100));
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
      .map(r => ({ keyPreview: r.keyPreview, outcome: r.outcome, reason: r.reason, errorMessage: r.errorMessage?.slice(0, 120) })),
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
