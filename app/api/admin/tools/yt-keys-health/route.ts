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
 *     limit?:       number;   // default 500 keys per call. Capped
 *                             // at 10000 for background mode, 2000
 *                             // for sync.
 *     concurrency?: number;   // default 20 in-flight probes. Each
 *                             // probe spawns a Python subprocess via
 *                             // ytFetchViaProxy so 20 keeps the
 *                             // server's memory + fd budget sane.
 *     dryRun?:      boolean;  // probe + classify only, no DB writes.
 *     background?:  boolean;  // when true, insert a run row, return
 *                             // its id immediately, run the work
 *                             // async. Poll via GET ?runId=N.
 *   }
 *
 * Probes go through the SAME proxy stack the enrichment pipeline
 * uses (ytFetchViaProxy → Python+curl via xgodo proxy). Each probe
 * pairs the candidate key with a freshly-picked random proxy so a
 * single flaky proxy can't take out a whole sample. Mirrors the
 * production call path's reliability profile.
 *
 * Every run (sync or background) inserts a row into
 * xgodo_key_health_runs with its summary + DB updates so progress
 * can be polled in flight and the history is queryable later.
 *
 * GET (no params)          → live pool composition snapshot.
 * GET ?runId=N             → status of one historical / in-flight
 *                             run (probed-so-far, sample tallies,
 *                             db updates applied, started/completed).
 *
 * Auth: admin Bearer token.
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

interface SampleSummary {
  working: number; quotaExceeded: number; suspended: number; other: number; network: number;
}
interface DbUpdates { activated: number; banned: number; invalidated: number; }

/**
 * Probe one key by routing the request through the same xgodo
 * proxy stack the enrichment pipeline uses (lib/yt-proxy-fetch.ts).
 */
async function probeOne(key: string): Promise<{ outcome: Outcome; httpStatus: number | null; reason?: string; errorMessage?: string; proxyUsed?: string }> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${TEST_VIDEO_ID}&key=${key}`;
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
  if (res.status === 0 || res.data == null) {
    return { outcome: 'network', httpStatus, errorMessage: res.error?.slice(0, 200), proxyUsed };
  }
  const data = res.data as { items?: unknown[]; error?: { errors?: { reason?: string }[]; message?: string } };
  if (data.error) {
    const reason = data.error.errors?.[0]?.reason ?? 'unknown';
    if (reason === 'quotaExceeded') {
      return { outcome: 'quotaExceeded', httpStatus, reason, errorMessage: data.error.message, proxyUsed };
    }
    if (reason === 'forbidden') {
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
async function runConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

/* ─────────────────────────────────────────────────────────────────
 *  Core sweep — shared between sync POST and the background IIFE.
 * ──────────────────────────────────────────────────────────────── */
async function runSweep(opts: {
  runId: number;
  limit: number;
  concurrency: number;
  dryRun: boolean;
  reportProgressEvery?: number; // batch size between DB progress writes
}): Promise<{
  probed: number;
  sample: SampleSummary;
  dbUpdates: DbUpdates;
  proxyTopFailures: Array<{ proxyDeviceId: string; count: number }>;
  examples: Array<{ keyPreview: string; outcome: Outcome; reason?: string; proxyUsed?: string; errorMessage?: string }>;
}> {
  const pool = await getPool();
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
    [opts.limit],
  );

  const summary: SampleSummary = { working: 0, quotaExceeded: 0, suspended: 0, other: 0, network: 0 };
  const allResults: ProbeResult[] = [];
  let lastReportAt = 0;
  const REPORT_EVERY = opts.reportProgressEvery ?? 50;

  await runConcurrent(candidates.rows, opts.concurrency, async (row, i) => {
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
    summary[out.outcome]++;
    allResults[i] = out;
    // Periodic progress flush so background-mode pollers see live
    // counts instead of one big update at the end. Throttled so we
    // don't hammer the DB.
    if (allResults.length - lastReportAt >= REPORT_EVERY) {
      lastReportAt = allResults.length;
      // JSON.stringify the JSONB payload — node-postgres tries to
      // coerce raw JS objects/arrays into Postgres native types
      // (text[], composite) which JSONB then rejects with
      // "invalid input syntax for type json". Explicit stringify
      // forces it down the JSON path.
      pool.query(
        `UPDATE xgodo_key_health_runs
            SET probed = $1, sample_summary = $2::jsonb
          WHERE id = $3`,
        [allResults.filter(Boolean).length, JSON.stringify(summary), opts.runId],
      ).catch(() => { /* progress write failures shouldn't kill the sweep */ });
    }
  });

  // Persist results. Three UPDATEs keyed by id arrays — each hits
  // the PK so the cost is fine.
  const dbUpdates: DbUpdates = { activated: 0, banned: 0, invalidated: 0 };
  if (!opts.dryRun) {
    const workingIds   = allResults.filter(r => r.outcome === 'working').map(r => r.keyId);
    const quotaIds     = allResults.filter(r => r.outcome === 'quotaExceeded').map(r => r.keyId);
    const suspendedIds = allResults.filter(r => r.outcome === 'suspended').map(r => r.keyId);

    if (workingIds.length > 0) {
      const u = await pool.query(
        `UPDATE xgodo_api_keys SET status = 'active', banned_until = NULL
          WHERE id = ANY($1::int[]) AND (status != 'active' OR banned_until IS NOT NULL)`,
        [workingIds],
      );
      dbUpdates.activated = u.rowCount ?? 0;
    }
    if (quotaIds.length > 0) {
      const u = await pool.query(
        `UPDATE xgodo_api_keys SET status = 'banned', banned_until = NOW() + INTERVAL '12 hours'
          WHERE id = ANY($1::int[])`,
        [quotaIds],
      );
      dbUpdates.banned = u.rowCount ?? 0;
    }
    if (suspendedIds.length > 0) {
      const u = await pool.query(
        `UPDATE xgodo_api_keys SET status = 'invalid', invalidated_at = NOW()
          WHERE id = ANY($1::int[])`,
        [suspendedIds],
      );
      dbUpdates.invalidated = u.rowCount ?? 0;
    }
  }

  // Aggregate non-working probes by proxy device — surfaces a
  // single flaky proxy that's responsible for many failures.
  const proxyFailureCounts = new Map<string, number>();
  for (const r of allResults) {
    if (r.outcome === 'working' || r.outcome === 'quotaExceeded' || r.outcome === 'suspended') continue;
    const key = r.proxyUsed || 'unknown';
    proxyFailureCounts.set(key, (proxyFailureCounts.get(key) ?? 0) + 1);
  }
  const proxyTopFailures = [...proxyFailureCounts.entries()]
    .map(([proxyDeviceId, count]) => ({ proxyDeviceId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const examples = allResults
    .filter(r => r.outcome !== 'working')
    .slice(0, 8)
    .map(r => ({
      keyPreview: r.keyPreview,
      outcome: r.outcome,
      reason: r.reason,
      proxyUsed: r.proxyUsed,
      errorMessage: r.errorMessage?.slice(0, 120),
    }));

  return { probed: candidates.rows.length, sample: summary, dbUpdates, proxyTopFailures, examples };
}

/* ─────────────────────────────────────────────────────────────────
 *  POST — sync or background sweep.
 * ──────────────────────────────────────────────────────────────── */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as {
    limit?: number; concurrency?: number; dryRun?: boolean; background?: boolean;
  };
  const background = !!body.background;
  // Sync mode caps tighter — 2000 is roughly the maxDuration budget
  // at concurrency 20 with ~2s/probe. Background can chew much more
  // since the response returns immediately.
  const limit       = Math.max(1, Math.min(body.limit ?? 500, background ? 10000 : 2000));
  const concurrency = Math.max(1, Math.min(body.concurrency ?? 20, 50));
  const dryRun      = !!body.dryRun;
  const pool        = await getPool();

  // Insert the run row before starting any work so a pollable id
  // exists by the time we return (background) or by the time the
  // sweep starts (sync).
  const ins = await pool.query<{ id: number; started_at: string }>(
    `INSERT INTO xgodo_key_health_runs
       (service, mode, status, target_limit, concurrency, dry_run, sample_summary, db_updates, probed)
     VALUES ('youtube_data', $1, 'running', $2, $3, $4, '{}', '{}', 0)
     RETURNING id, started_at`,
    [background ? 'background' : 'sync', limit, concurrency, dryRun],
  );
  const runId = ins.rows[0].id;
  const startedAt = ins.rows[0].started_at;

  if (background) {
    // Fire-and-forget. The IIFE owns the runId and persists its
    // own progress + completion state. Top-level catch keeps a
    // crash from leaving the row stuck in 'running' forever.
    (async () => {
      try {
        const r = await runSweep({ runId, limit, concurrency, dryRun });
        await pool.query(
          `UPDATE xgodo_key_health_runs
              SET status='done', completed_at=NOW(),
                  probed=$1,
                  sample_summary=$2::jsonb,
                  db_updates=$3::jsonb,
                  proxy_top_failures=$4::jsonb
            WHERE id=$5`,
          [r.probed, JSON.stringify(r.sample), JSON.stringify(r.dbUpdates), JSON.stringify(r.proxyTopFailures), runId],
        );
      } catch (err) {
        await pool.query(
          `UPDATE xgodo_key_health_runs
              SET status='error', completed_at=NOW(),
                  error_message=$1
            WHERE id=$2`,
          [(err as Error).message?.slice(0, 500) || 'unknown', runId],
        ).catch(() => { /* nothing else to do */ });
      }
    })();
    return NextResponse.json({
      ok: true, runId, mode: 'background', startedAt,
      pollUrl: `/api/admin/tools/yt-keys-health?runId=${runId}`,
    });
  }

  // Sync mode — run inline, capture stats, write final row.
  try {
    const t0 = Date.now();
    const r = await runSweep({ runId, limit, concurrency, dryRun });
    await pool.query(
      `UPDATE xgodo_key_health_runs
          SET status='done', completed_at=NOW(),
              probed=$1,
              sample_summary=$2::jsonb,
              db_updates=$3::jsonb,
              proxy_top_failures=$4::jsonb
        WHERE id=$5`,
      [r.probed, JSON.stringify(r.sample), JSON.stringify(r.dbUpdates), JSON.stringify(r.proxyTopFailures), runId],
    );

    const poolAfter = await pool.query<{ active: string; banned: string; invalid: string; disabled: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status='active')   ::text AS active,
         COUNT(*) FILTER (WHERE status='banned')   ::text AS banned,
         COUNT(*) FILTER (WHERE status='invalid')  ::text AS invalid,
         COUNT(*) FILTER (WHERE status='disabled') ::text AS disabled
         FROM xgodo_api_keys
        WHERE service='youtube_data'`,
    );
    const ps = poolAfter.rows[0];

    return NextResponse.json({
      ok: true,
      runId,
      mode: 'sync',
      dryRun,
      probed: r.probed,
      elapsedMs: Date.now() - t0,
      concurrency,
      sample: r.sample,
      dbUpdates: r.dbUpdates,
      pool: {
        active:   parseInt(ps?.active   ?? '0'),
        banned:   parseInt(ps?.banned   ?? '0'),
        invalid:  parseInt(ps?.invalid  ?? '0'),
        disabled: parseInt(ps?.disabled ?? '0'),
      },
      proxyTopFailures: r.proxyTopFailures,
      examples: r.examples,
    });
  } catch (err) {
    await pool.query(
      `UPDATE xgodo_key_health_runs
          SET status='error', completed_at=NOW(),
              error_message=$1
        WHERE id=$2`,
      [(err as Error).message?.slice(0, 500) || 'unknown', runId],
    ).catch(() => { /* swallow secondary */ });
    return NextResponse.json({ ok: false, runId, error: (err as Error).message?.slice(0, 500) || 'unknown' }, { status: 500 });
  }
}

/* ─────────────────────────────────────────────────────────────────
 *  GET — pool snapshot (no params) or run status (?runId=N).
 * ──────────────────────────────────────────────────────────────── */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const runIdParam = req.nextUrl.searchParams.get('runId');
  const pool = await getPool();

  if (runIdParam) {
    const runId = parseInt(runIdParam);
    if (Number.isNaN(runId)) return NextResponse.json({ error: 'invalid runId' }, { status: 400 });
    const r = await pool.query(
      `SELECT id, service, mode, status, started_at, completed_at,
              target_limit, concurrency, dry_run,
              probed, sample_summary, db_updates, proxy_top_failures, error_message
         FROM xgodo_key_health_runs
        WHERE id = $1`,
      [runId],
    );
    if (r.rows.length === 0) return NextResponse.json({ error: 'run not found' }, { status: 404 });
    const row = r.rows[0];
    return NextResponse.json({
      ok: true,
      run: {
        id: row.id,
        service: row.service,
        mode: row.mode,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        targetLimit: row.target_limit,
        concurrency: row.concurrency,
        dryRun: row.dry_run,
        probed: row.probed,
        sampleSummary: row.sample_summary,
        dbUpdates: row.db_updates,
        proxyTopFailures: row.proxy_top_failures,
        errorMessage: row.error_message,
        elapsedMs: row.completed_at
          ? new Date(row.completed_at).getTime() - new Date(row.started_at).getTime()
          : Date.now() - new Date(row.started_at).getTime(),
      },
    });
  }

  // Pool composition snapshot.
  const r = await pool.query<{
    service: string; status: string; n: string; banned_recoverable: string;
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
