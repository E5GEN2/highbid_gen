import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { getProxyStats } from '@/lib/xgodo-proxy';

/**
 * GET /api/admin/tools/vid-gen/overwatch
 *
 * One-shot snapshot covering EVERYTHING that gates the prompt queue's
 * health. Built so Claude (or a human operator) can see in a single
 * call:
 *
 *   - queue counts (available / reserved / confirmed / total + breakdown)
 *   - recent generation runs with wedge detection
 *       wedged = status='running' AND no batch progress for > 2 min
 *       (the run's batches_total is still 0 after that long means the
 *       fire-and-forget worker died — most common cause: Next.js
 *       function-instance recycle mid-await, e.g. during a deploy)
 *   - vid-gen settings snapshot (auto-refill, suffix, target_model,
 *     saved theme length)
 *   - google_ai_studio key pool summary (active / invalid / cooling)
 *   - proxy pool summary (passed through from xgodo-proxy)
 *   - top-line health verdict so the caller doesn't have to interpret
 *     the numbers manually
 *
 * Read-only. Counterpart of POST /sweep (which fails wedged runs) and
 * POST /refill-trigger (which fires the auto-refill check manually).
 *
 * Auth: admin Bearer token.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WEDGED_AFTER_SECONDS = 120;  // running > 2 min with 0 batches = wedged

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const pool = await getPool();

  // ── 1. Queue counts ────────────────────────────────────────────────
  // Same 5-min visibility window the picker uses, so "available" here
  // matches what clients will actually pop.
  const queueRes = await pool.query<{
    available: string; reserved: string; confirmed: string;
    manual: string; ai: string;
    veo_lite: string; veo_omni: string;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE confirmed_at IS NULL
           AND (served_at IS NULL OR served_at < NOW() - INTERVAL '5 minutes')
       )::text AS available,
       COUNT(*) FILTER (
         WHERE confirmed_at IS NULL
           AND served_at >= NOW() - INTERVAL '5 minutes'
       )::text AS reserved,
       COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL)::text AS confirmed,
       COUNT(*) FILTER (WHERE source = 'manual')::text       AS manual,
       COUNT(*) FILTER (WHERE source = 'ai-generated')::text AS ai,
       COUNT(*) FILTER (WHERE target_model = 'veo-lite')::text AS veo_lite,
       COUNT(*) FILTER (WHERE target_model = 'veo-omni')::text AS veo_omni
       FROM video_prompts`,
  );
  const q = queueRes.rows[0];
  const queue = {
    available: parseInt(q.available),
    reserved:  parseInt(q.reserved),
    confirmed: parseInt(q.confirmed),
    manual:    parseInt(q.manual),
    ai:        parseInt(q.ai),
    byTargetModel: {
      'veo-lite': parseInt(q.veo_lite),
      'veo-omni': parseInt(q.veo_omni),
    },
    total: parseInt(q.available) + parseInt(q.reserved) + parseInt(q.confirmed),
  };

  // ── 2. Recent runs with wedge detection ────────────────────────────
  // Pull last 15 runs, compute age + a "wedged" flag for any running
  // row that's done zero batches after WEDGED_AFTER_SECONDS. The
  // batches=0 condition specifically targets workers that died before
  // their first DB UPDATE — a run that's making slow progress (batches
  // ticking up) is NOT wedged, just slow.
  const runsRes = await pool.query<{
    id: string; status: string; mode: string;
    started_at: Date; completed_at: Date | null;
    age_seconds: number;
    last_update_age_seconds: number | null;
    count_requested: number; count_generated: number;
    count_inserted: number; count_duplicates: number;
    batches_total: number; batches_failed: number;
    theme: string | null; model: string;
    last_error: string | null;
  }>(
    `SELECT id, status, mode,
            started_at, completed_at,
            EXTRACT(EPOCH FROM (NOW() - started_at))::int AS age_seconds,
            CASE
              WHEN status = 'running' AND batches_total = 0
                THEN EXTRACT(EPOCH FROM (NOW() - started_at))::int
              ELSE NULL
            END AS last_update_age_seconds,
            count_requested, count_generated,
            count_inserted, count_duplicates,
            batches_total, batches_failed,
            theme, model, last_error
       FROM vid_gen_runs
      ORDER BY started_at DESC
      LIMIT 15`,
  );

  const runs = runsRes.rows.map(r => {
    const wedged = r.status === 'running'
                && r.batches_total === 0
                && r.age_seconds > WEDGED_AFTER_SECONDS;
    return {
      id: r.id,
      idShort: r.id.slice(0, 8),
      status: r.status,
      mode: r.mode,
      startedAt: r.started_at.toISOString(),
      completedAt: r.completed_at?.toISOString() ?? null,
      ageSeconds: r.age_seconds,
      wedged,
      countRequested: r.count_requested,
      countGenerated: r.count_generated,
      countInserted:  r.count_inserted,
      countDuplicates: r.count_duplicates,
      batchesTotal:  r.batches_total,
      batchesFailed: r.batches_failed,
      themePreview: r.theme ? r.theme.slice(0, 80).replace(/\s+/g, ' ') : null,
      model: r.model,
      lastError: r.last_error ? r.last_error.slice(0, 200) : null,
    };
  });
  const wedgedCount = runs.filter(r => r.wedged).length;
  const runningCount = runs.filter(r => r.status === 'running').length;

  // ── 3. Settings snapshot ───────────────────────────────────────────
  const sRes = await pool.query<{
    suffix: string; suffix_enabled: boolean;
    auto_theme: string; auto_refill_enabled: boolean;
    auto_refill_threshold: number; auto_refill_target: number;
    target_model: string; updated_at: Date;
  }>(
    `SELECT suffix, suffix_enabled, auto_theme, auto_refill_enabled,
            auto_refill_threshold, auto_refill_target, target_model, updated_at
       FROM vid_gen_settings WHERE id = 1`,
  ).catch(() => ({ rows: [] }));
  const s = sRes.rows[0];
  const settings = s ? {
    suffix: s.suffix,
    suffixEnabled: s.suffix_enabled,
    autoTheme: { length: s.auto_theme?.length ?? 0, preview: s.auto_theme?.slice(0, 80).replace(/\s+/g, ' ') ?? '' },
    autoRefillEnabled: s.auto_refill_enabled,
    autoRefillThreshold: s.auto_refill_threshold,
    autoRefillTarget: s.auto_refill_target,
    targetModel: s.target_model,
    updatedAt: s.updated_at?.toISOString() ?? null,
  } : null;

  // ── 4. Key pool summary (google_ai_studio specifically — the only
  // service vid-gen uses). Same shape as embed-debug/stats so callers
  // can compare without translating field names.
  const keyRowsRes = await pool.query<{ status: string; n: number; cooling: number }>(
    `SELECT status,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE banned_until > NOW())::int AS cooling
       FROM xgodo_api_keys
      WHERE service = 'google_ai_studio'
      GROUP BY status`,
  );
  const keys = keyRowsRes.rows.reduce((acc, r) => {
    acc[r.status] = { count: r.n, cooling: r.cooling };
    return acc;
  }, {} as Record<string, { count: number; cooling: number }>);
  const activeKeys = keys.active?.count ?? 0;
  const coolingKeys = keys.active?.cooling ?? 0;

  // ── 5. Proxy pool (delegated to xgodo-proxy's stats helper).
  const proxies = await getProxyStats().catch(() => null);

  // ── 6. Top-line verdict — saves the caller from manually grading
  // five numbers. Worst-state wins, so a degraded key pool with an
  // empty queue surfaces as "queue-empty" because that's the
  // operator-actionable thing.
  const verdict: string[] = [];
  if (queue.available === 0)                          verdict.push('queue-empty');
  else if (queue.available < (settings?.autoRefillThreshold ?? 500))
                                                       verdict.push('queue-below-threshold');
  if (wedgedCount > 0)                                verdict.push(`${wedgedCount}-run(s)-wedged`);
  if (activeKeys === 0)                               verdict.push('no-active-keys');
  else if (activeKeys - coolingKeys < 5)              verdict.push('key-pool-degraded');
  if (settings && !settings.autoRefillEnabled)        verdict.push('auto-refill-disabled');
  const status = verdict.length === 0 ? 'healthy' : verdict.join(', ');

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    status,
    queue,
    runs: {
      total: runs.length,
      running: runningCount,
      wedged:  wedgedCount,
      wedgedAfterSeconds: WEDGED_AFTER_SECONDS,
      list: runs,
    },
    settings,
    keys: {
      byStatus: keys,
      activeUsable: activeKeys - coolingKeys,
    },
    proxies,
  });
}
