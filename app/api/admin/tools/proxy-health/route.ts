import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { getProxies, type ProxyInfo } from '@/lib/xgodo-proxy';
import { ytFetchViaProxy } from '@/lib/yt-proxy-fetch';
import type { YtKeyProxyPair } from '@/lib/yt-keys';

/**
 * POST /api/admin/tools/proxy-health
 *
 * Probes every online xgodo proxy with N tries each, using a
 * different randomly-drawn active YT key per try. Classifies each
 * proxy from the success rate and updates xgodo_proxy_health so
 * the (future) routing layer can skip dead devices.
 *
 * Design mirrors yt-keys-health but with the pinning flipped:
 *   keys tool   — pins key,   rotates proxy → measures the key
 *   proxy tool  — pins proxy, rotates key   → measures the proxy
 *
 * Why a per-try key rotation: production rotates BOTH per call, so
 * pinning a single key while testing all proxies would let the
 * key's variability bleed into the proxy verdict (a burned key
 * would make every proxy look broken).
 *
 * Success criterion: outcome ≠ 'network'. Even quotaExceeded or
 * suspended count as proxy successes because the proxy *did*
 * route the request through to YT. The only proxy failure is when
 * the request can't reach YT at all (curl exit 56, etc.).
 *
 * Classification rules (per proxy, over N tries):
 *   all-succeed   → 'healthy'
 *   all-network   → 'dead'      + banned_until = NOW()+12h
 *   mixed         → 'flaky'     + banned_until = NOW()+1h
 *
 * Body:
 *   {
 *     limit?:          number;  // max proxies to probe (default: all online)
 *     triesPerProxy?:  number;  // default 3, capped 1..5
 *     concurrency?:    number;  // default 15, capped 1..40
 *     keysPerSample?:  number;  // size of the key sample we rotate
 *                               //   through (default 30, capped 5..200)
 *     dryRun?:         boolean; // probe + classify only, no DB writes
 *     background?:     boolean; // when true, return runId immediately
 *                               //   and run async; poll via
 *                               //   GET ?runId=N
 *   }
 *
 * GET (no params)  → snapshot of xgodo_proxy_health
 * GET ?runId=N     → status of a single sweep run
 *
 * Auth: admin Bearer token.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

const TEST_VIDEO_ID = 'dQw4w9WgXcQ'; // Universally fetchable.

type ProbeOutcome = 'working' | 'quotaExceeded' | 'suspended' | 'other' | 'network';

interface SingleProbeResult {
  outcome: ProbeOutcome;
  httpStatus: number | null;
  errorMessage?: string;
  reason?: string;
  keyPreview: string;
  elapsedMs: number;
}

interface ProxyClassification {
  deviceId: string;
  name: string | null;
  country: string;
  tries: SingleProbeResult[];
  successes: number;
  failures: number;
  status: 'healthy' | 'flaky' | 'dead';
}

interface SampleSummary { healthy: number; flaky: number; dead: number; }
interface DbUpdates { newHealthy: number; newFlaky: number; newDead: number; recovered: number; }

/* ─────────────────────────────────────────────────────────────────
 *  Bounded concurrency runner (same shape as the keys tool).
 * ──────────────────────────────────────────────────────────────── */
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

/**
 * One probe: pinned proxy + rotating key from the supplied sample.
 * Caller threads its own random key in; this function doesn't pick
 * keys itself because the calling loop wants to ensure different
 * keys across the N tries for a single proxy.
 */
async function probeOnce(proxy: ProxyInfo, key: string): Promise<SingleProbeResult> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${TEST_VIDEO_ID}&key=${key}`;
  const pair: YtKeyProxyPair = {
    key,
    proxyUrl: proxy.url,
    proxyDeviceId: proxy.deviceId.substring(0, 8),
    banned: false,
    banExpiry: 0,
  };
  const t0 = Date.now();
  const res = await ytFetchViaProxy(url, pair);
  const elapsedMs = Date.now() - t0;
  const httpStatus = res.status || null;
  const keyPreview = `${key.slice(0, 12)}…`;

  if (res.status === 0 || res.data == null) {
    return { outcome: 'network', httpStatus, errorMessage: res.error?.slice(0, 200), keyPreview, elapsedMs };
  }
  const data = res.data as { items?: unknown[]; error?: { errors?: { reason?: string }[]; message?: string } };
  if (data.error) {
    const reason = data.error.errors?.[0]?.reason ?? 'unknown';
    const outcome: ProbeOutcome = reason === 'quotaExceeded' ? 'quotaExceeded'
      : reason === 'forbidden' ? 'suspended' : 'other';
    return { outcome, httpStatus, reason, errorMessage: data.error.message, keyPreview, elapsedMs };
  }
  if (Array.isArray(data.items) && data.items.length > 0) {
    return { outcome: 'working', httpStatus, keyPreview, elapsedMs };
  }
  return { outcome: 'other', httpStatus, errorMessage: 'response had no items + no error', keyPreview, elapsedMs };
}

/**
 * Probe one proxy with N tries, each using a different random key
 * from the supplied sample. Classifies the proxy from the success
 * rate; a probe counts as "success for the proxy" when it reaches
 * YT at all (ANY non-network outcome).
 */
async function probeProxy(proxy: ProxyInfo, keys: string[], triesPerProxy: number): Promise<ProxyClassification> {
  const tries: SingleProbeResult[] = [];
  // Shuffle a working copy so we don't reuse the same key in the
  // same proxy's N tries when sample > tries.
  const shuffled = [...keys].sort(() => Math.random() - 0.5);
  for (let i = 0; i < triesPerProxy; i++) {
    const key = shuffled[i % shuffled.length];
    tries.push(await probeOnce(proxy, key));
  }
  const successes = tries.filter(t => t.outcome !== 'network').length;
  const failures = tries.length - successes;
  const status: 'healthy' | 'flaky' | 'dead' =
    successes === tries.length ? 'healthy' :
    successes === 0            ? 'dead'    :
                                 'flaky';
  return {
    deviceId: proxy.deviceId,
    name: proxy.name,
    country: proxy.country,
    tries, successes, failures, status,
  };
}

/* ─────────────────────────────────────────────────────────────────
 *  Core sweep — shared between sync POST and background IIFE.
 * ──────────────────────────────────────────────────────────────── */
async function runSweep(opts: {
  runId: number;
  limit: number;
  triesPerProxy: number;
  concurrency: number;
  keysPerSample: number;
  dryRun: boolean;
}): Promise<{
  proxiesProbed: number;
  sample: SampleSummary;
  dbUpdates: DbUpdates;
  examples: Array<{ deviceId: string; status: string; successes: number; failures: number; firstError?: string }>;
}> {
  const pool = await getPool();

  // 1. Resolve the proxy set to test. Cap at `limit` if provided;
  //    otherwise all currently-online proxies.
  const allProxies = await getProxies();
  const proxies = allProxies.slice(0, opts.limit);

  // 2. Pull a key sample for rotation. We grab ACTIVE keys only —
  //    we want the request to be plausibly successful at the YT
  //    side so the proxy is the variable being measured.
  const keySample = await pool.query<{ key: string }>(
    `SELECT key
       FROM xgodo_api_keys
      WHERE service = 'youtube_data' AND status = 'active'
      ORDER BY RANDOM()
      LIMIT $1`,
    [opts.keysPerSample],
  );
  if (keySample.rows.length === 0) {
    throw new Error('no active youtube_data keys available to sample from');
  }
  const keyPool = keySample.rows.map(r => r.key);

  // 3. Probe each proxy with bounded concurrency. Update the run
  //    row's progress every 10 proxies so polling sees motion.
  const summary: SampleSummary = { healthy: 0, flaky: 0, dead: 0 };
  const classifications: ProxyClassification[] = new Array(proxies.length);
  let lastReport = 0;
  await runConcurrent(proxies, opts.concurrency, async (proxy, i) => {
    const c = await probeProxy(proxy, keyPool, opts.triesPerProxy);
    classifications[i] = c;
    summary[c.status]++;
    const done = classifications.filter(Boolean).length;
    if (done - lastReport >= 10) {
      lastReport = done;
      pool.query(
        `UPDATE xgodo_proxy_health_runs
            SET probed = $1, sample_summary = $2::jsonb
          WHERE id = $3`,
        [done, JSON.stringify(summary), opts.runId],
      ).catch(() => { /* progress write failures shouldn't kill the sweep */ });
    }
  });

  // 4. Persist per-proxy verdicts to xgodo_proxy_health. Need to
  //    know each proxy's PRIOR status to track "recovered" vs
  //    "newly classified" transitions, so do one bulk SELECT
  //    against the device_id list before upserting. This avoids
  //    the gotcha where a RETURNING subselect inside ON CONFLICT
  //    sees the post-update row (the upsert already happened).
  const dbUpdates: DbUpdates = { newHealthy: 0, newFlaky: 0, newDead: 0, recovered: 0 };
  if (!opts.dryRun) {
    const deviceIds = classifications.map(c => c.deviceId);
    const priorRows = await pool.query<{ device_id: string; status: string }>(
      `SELECT device_id, status FROM xgodo_proxy_health WHERE device_id = ANY($1::text[])`,
      [deviceIds],
    );
    const priorByDevice = new Map<string, string>();
    for (const r of priorRows.rows) priorByDevice.set(r.device_id, r.status);

    for (const c of classifications) {
      const banned_until_clause = c.status === 'dead'
        ? `NOW() + INTERVAL '12 hours'`
        : c.status === 'flaky'
          ? `NOW() + INTERVAL '1 hour'`
          : `NULL`;
      // Upsert. total_* accumulates across sweeps so we keep a
      // historical reliability ratio per device. last_* reflects
      // only the most recent run.
      await pool.query(
        `INSERT INTO xgodo_proxy_health
            (device_id, status, last_checked_at, banned_until,
             last_tries, last_successes,
             total_tries, total_successes,
             name, country, last_error)
          VALUES ($1, $2, NOW(), ${banned_until_clause},
                  $3, $4, $3, $4, $5, $6, $7)
          ON CONFLICT (device_id) DO UPDATE SET
            status = EXCLUDED.status,
            last_checked_at = EXCLUDED.last_checked_at,
            banned_until = EXCLUDED.banned_until,
            last_tries = EXCLUDED.last_tries,
            last_successes = EXCLUDED.last_successes,
            total_tries = xgodo_proxy_health.total_tries + EXCLUDED.last_tries,
            total_successes = xgodo_proxy_health.total_successes + EXCLUDED.last_successes,
            name = COALESCE(EXCLUDED.name, xgodo_proxy_health.name),
            country = COALESCE(EXCLUDED.country, xgodo_proxy_health.country),
            last_error = EXCLUDED.last_error`,
        [
          c.deviceId,
          c.status,
          c.tries.length,
          c.successes,
          c.name,
          c.country,
          c.tries.find(t => t.outcome === 'network')?.errorMessage?.slice(0, 200) ?? null,
        ],
      );
      // Tally by transition. First-insert (no prior row) is
      // bucketed as new<status>. A proxy that was previously
      // dead/flaky/unknown and is now healthy counts as
      // "recovered" — the metric you'd watch to know the sweep
      // is doing useful work.
      const prior = priorByDevice.get(c.deviceId);
      if (c.status === 'healthy') {
        dbUpdates.newHealthy++;
        if (prior && prior !== 'healthy') dbUpdates.recovered++;
      } else if (c.status === 'flaky') {
        dbUpdates.newFlaky++;
      } else {
        dbUpdates.newDead++;
      }
    }
  }

  // 5. Examples — top few non-healthy with first error message
  //    surfaced, for spot-check.
  const examples = classifications
    .filter(c => c.status !== 'healthy')
    .slice(0, 8)
    .map(c => ({
      deviceId: c.deviceId,
      status: c.status,
      successes: c.successes,
      failures: c.failures,
      firstError: c.tries.find(t => t.outcome === 'network')?.errorMessage?.slice(0, 120),
    }));

  return { proxiesProbed: proxies.length, sample: summary, dbUpdates, examples };
}

/* ─────────────────────────────────────────────────────────────────
 *  POST — sync or background sweep.
 * ──────────────────────────────────────────────────────────────── */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as {
    limit?: number; triesPerProxy?: number; concurrency?: number;
    keysPerSample?: number; dryRun?: boolean; background?: boolean;
  };
  const background     = !!body.background;
  const triesPerProxy  = Math.max(1, Math.min(body.triesPerProxy ?? 3, 5));
  const concurrency    = Math.max(1, Math.min(body.concurrency   ?? 15, 40));
  const keysPerSample  = Math.max(5, Math.min(body.keysPerSample ?? 30, 200));
  const dryRun         = !!body.dryRun;

  // Default limit = current proxy cache size. Caller can cap
  // smaller for quick spot-checks.
  const allProxies = await getProxies();
  const limit = Math.max(1, Math.min(body.limit ?? allProxies.length, allProxies.length));

  const pool = await getPool();
  const ins = await pool.query<{ id: number; started_at: string }>(
    `INSERT INTO xgodo_proxy_health_runs
       (mode, status, target_total, tries_per_proxy, concurrency, dry_run, sample_summary, db_updates, probed)
     VALUES ($1, 'running', $2, $3, $4, $5, '{}', '{}', 0)
     RETURNING id, started_at`,
    [background ? 'background' : 'sync', limit, triesPerProxy, concurrency, dryRun],
  );
  const runId = ins.rows[0].id;
  const startedAt = ins.rows[0].started_at;

  if (background) {
    (async () => {
      try {
        const r = await runSweep({ runId, limit, triesPerProxy, concurrency, keysPerSample, dryRun });
        await pool.query(
          `UPDATE xgodo_proxy_health_runs
              SET status='done', completed_at=NOW(),
                  probed=$1, sample_summary=$2::jsonb, db_updates=$3::jsonb
            WHERE id=$4`,
          [r.proxiesProbed, JSON.stringify(r.sample), JSON.stringify(r.dbUpdates), runId],
        );
      } catch (err) {
        await pool.query(
          `UPDATE xgodo_proxy_health_runs
              SET status='error', completed_at=NOW(), error_message=$1
            WHERE id=$2`,
          [(err as Error).message?.slice(0, 500) || 'unknown', runId],
        ).catch(() => { /* nothing else to do */ });
      }
    })();
    return NextResponse.json({
      ok: true, runId, mode: 'background', startedAt,
      target: limit, triesPerProxy,
      pollUrl: `/api/admin/tools/proxy-health?runId=${runId}`,
    });
  }

  try {
    const t0 = Date.now();
    const r = await runSweep({ runId, limit, triesPerProxy, concurrency, keysPerSample, dryRun });
    await pool.query(
      `UPDATE xgodo_proxy_health_runs
          SET status='done', completed_at=NOW(),
              probed=$1, sample_summary=$2::jsonb, db_updates=$3::jsonb
        WHERE id=$4`,
      [r.proxiesProbed, JSON.stringify(r.sample), JSON.stringify(r.dbUpdates), runId],
    );

    const poolAfter = await pool.query<{
      healthy: string; flaky: string; dead: string; unknown: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status='healthy')::text AS healthy,
         COUNT(*) FILTER (WHERE status='flaky')  ::text AS flaky,
         COUNT(*) FILTER (WHERE status='dead')   ::text AS dead,
         COUNT(*) FILTER (WHERE status='unknown')::text AS unknown
         FROM xgodo_proxy_health`,
    );
    const ps = poolAfter.rows[0];

    return NextResponse.json({
      ok: true,
      runId, mode: 'sync', dryRun,
      proxiesProbed: r.proxiesProbed,
      triesPerProxy,
      elapsedMs: Date.now() - t0,
      sample: r.sample,
      dbUpdates: r.dbUpdates,
      pool: {
        healthy: parseInt(ps?.healthy ?? '0'),
        flaky:   parseInt(ps?.flaky   ?? '0'),
        dead:    parseInt(ps?.dead    ?? '0'),
        unknown: parseInt(ps?.unknown ?? '0'),
      },
      examples: r.examples,
    });
  } catch (err) {
    await pool.query(
      `UPDATE xgodo_proxy_health_runs
          SET status='error', completed_at=NOW(), error_message=$1
        WHERE id=$2`,
      [(err as Error).message?.slice(0, 500) || 'unknown', runId],
    ).catch(() => { /* swallow */ });
    return NextResponse.json(
      { ok: false, runId, error: (err as Error).message?.slice(0, 500) || 'unknown' },
      { status: 500 },
    );
  }
}

/* ─────────────────────────────────────────────────────────────────
 *  GET — pool snapshot, or single run status by ?runId=N.
 * ──────────────────────────────────────────────────────────────── */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const runIdParam = req.nextUrl.searchParams.get('runId');
  const pool = await getPool();

  if (runIdParam) {
    const runId = parseInt(runIdParam);
    if (Number.isNaN(runId)) return NextResponse.json({ error: 'invalid runId' }, { status: 400 });
    const r = await pool.query(
      `SELECT id, mode, status, started_at, completed_at,
              target_total, tries_per_proxy, concurrency, dry_run,
              probed, sample_summary, db_updates, error_message
         FROM xgodo_proxy_health_runs
        WHERE id = $1`,
      [runId],
    );
    if (r.rows.length === 0) return NextResponse.json({ error: 'run not found' }, { status: 404 });
    const row = r.rows[0];
    return NextResponse.json({
      ok: true,
      run: {
        id: row.id,
        mode: row.mode,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        targetTotal: row.target_total,
        triesPerProxy: row.tries_per_proxy,
        concurrency: row.concurrency,
        dryRun: row.dry_run,
        probed: row.probed,
        sampleSummary: row.sample_summary,
        dbUpdates: row.db_updates,
        errorMessage: row.error_message,
        elapsedMs: row.completed_at
          ? new Date(row.completed_at).getTime() - new Date(row.started_at).getTime()
          : Date.now() - new Date(row.started_at).getTime(),
      },
    });
  }

  // Pool snapshot — current view of xgodo_proxy_health.
  const composition = await pool.query<{ status: string; n: string; banned_recoverable: string }>(
    `SELECT status, COUNT(*)::text AS n,
            COUNT(*) FILTER (WHERE banned_until IS NULL OR banned_until < NOW())::text AS banned_recoverable
       FROM xgodo_proxy_health
      GROUP BY status
      ORDER BY status`,
  );
  // Worst-offender list — proxies most-recently classified non-healthy.
  const worst = await pool.query(
    `SELECT device_id, status, name, country,
            last_tries, last_successes,
            total_tries, total_successes,
            last_checked_at, banned_until, last_error
       FROM xgodo_proxy_health
       WHERE status IN ('dead','flaky')
       ORDER BY (total_tries - total_successes) DESC NULLS LAST,
                last_checked_at DESC NULLS LAST
       LIMIT 20`,
  );
  return NextResponse.json({
    ok: true,
    composition: composition.rows.map(r => ({
      status: r.status,
      n: parseInt(r.n),
      bannedRecoverable: parseInt(r.banned_recoverable),
    })),
    worst: worst.rows.map(r => ({
      deviceId: r.device_id,
      status: r.status,
      name: r.name,
      country: r.country,
      lastTries: r.last_tries,
      lastSuccesses: r.last_successes,
      totalTries: r.total_tries,
      totalSuccesses: r.total_successes,
      lastCheckedAt: r.last_checked_at,
      bannedUntil: r.banned_until,
      lastError: r.last_error?.slice(0, 200),
    })),
  });
}
