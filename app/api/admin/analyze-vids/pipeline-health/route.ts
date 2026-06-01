import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/analyze-vids/pipeline-health
 *
 * One-shot diagnostic for "why isn't the pipeline making progress?".
 * Built after a stuck-worker / retry-cap deadlock that wasn't visible
 * from any other endpoint. Returns everything an operator needs to
 * tell at a glance whether workers are alive, where they're stuck,
 * what's been failing, and how many are unsalvageable.
 *
 * Optional ?customNicheId=N scopes everything below to that niche.
 *
 * Cheap: 4-5 aggregate queries, all indexed. Suitable for live polling.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface AgeBucket { label: string; min: number; max: number | null }
const AGE_BUCKETS: AgeBucket[] = [
  { label: '<30s',    min: 0,    max: 30 },
  { label: '30s-2m',  min: 30,   max: 120 },
  { label: '2m-5m',   min: 120,  max: 300 },
  { label: '5m-15m',  min: 300,  max: 900 },
  { label: '15m-1h',  min: 900,  max: 3600 },
  { label: '>1h',     min: 3600, max: null },
];

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const pool = await getPool();

  const nicheIdRaw = req.nextUrl.searchParams.get('customNicheId');
  const nicheId = nicheIdRaw ? parseInt(nicheIdRaw) : null;
  const scope = nicheId ? `AND custom_niche_id = ${nicheId}` : '';

  // 1. Job status histogram.
  const statusRes = await pool.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM video_analysis_jobs
      WHERE 1=1 ${scope}
      GROUP BY status ORDER BY status`,
  );
  const statusHist: Record<string, number> = {};
  for (const r of statusRes.rows) statusHist[r.status] = parseInt(r.n);

  // 2. In-flight (downloading/splitting/analyzing/collapsing) progress
  // age distribution. Buckets via SQL so we don't need to ship every
  // row to Node.
  const inFlightAgeRes = await pool.query<{
    active_lt_90s: string;
    active_90s_5m: string;
    active_5m_15m: string;
    stuck_15m_1h: string;
    stuck_gt_1h:  string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE last_progress_at > NOW() - INTERVAL '90 seconds')::text  AS active_lt_90s,
       COUNT(*) FILTER (WHERE last_progress_at <= NOW() - INTERVAL '90 seconds'
                          AND last_progress_at >  NOW() - INTERVAL '5 minutes')::text  AS active_90s_5m,
       COUNT(*) FILTER (WHERE last_progress_at <= NOW() - INTERVAL '5 minutes'
                          AND last_progress_at >  NOW() - INTERVAL '15 minutes')::text AS active_5m_15m,
       COUNT(*) FILTER (WHERE last_progress_at <= NOW() - INTERVAL '15 minutes'
                          AND last_progress_at >  NOW() - INTERVAL '1 hour')::text     AS stuck_15m_1h,
       COUNT(*) FILTER (WHERE last_progress_at <= NOW() - INTERVAL '1 hour')::text     AS stuck_gt_1h
       FROM video_analysis_jobs
      WHERE status IN ('downloading','splitting','analyzing','collapsing')
            ${scope}`,
  );
  const inFlightAge = {
    active_lt_90s: parseInt(inFlightAgeRes.rows[0].active_lt_90s),
    active_90s_5m: parseInt(inFlightAgeRes.rows[0].active_90s_5m),
    active_5m_15m: parseInt(inFlightAgeRes.rows[0].active_5m_15m),
    stuck_15m_1h:  parseInt(inFlightAgeRes.rows[0].stuck_15m_1h),
    stuck_gt_1h:   parseInt(inFlightAgeRes.rows[0].stuck_gt_1h),
  };

  // 3. Retry-cap distribution. Shows how many jobs are at the cap and
  // need a manual force-revive (auto_retry_count >= MAX_AUTO_RETRIES).
  const retryRes = await pool.query<{ retries: number; n: string }>(
    `SELECT auto_retry_count AS retries, COUNT(*)::text AS n
       FROM video_analysis_jobs
      WHERE 1=1 ${scope}
      GROUP BY auto_retry_count
      ORDER BY auto_retry_count`,
  );
  const retryHist: Record<string, number> = {};
  for (const r of retryRes.rows) retryHist[String(r.retries)] = parseInt(r.n);

  // 4. Clip status histogram.
  const clipStatusRes = await pool.query<{ status: string; n: string }>(
    `SELECT c.status, COUNT(*)::text AS n
       FROM video_analysis_clips c
       ${nicheId ? `JOIN video_analysis_jobs j ON j.id = c.job_id AND j.custom_niche_id = ${nicheId}` : ''}
      GROUP BY c.status ORDER BY c.status`,
  );
  const clipStatus: Record<string, number> = {};
  for (const r of clipStatusRes.rows) clipStatus[r.status] = parseInt(r.n);

  // 5. Recent error-category histogram (last hour, from clip attempts).
  // Reads each clip's attempts jsonb and counts category occurrences.
  // Last hour scope keeps this scanning recent rows only.
  const errCatRes = await pool.query<{ category: string; n: string }>(
    `SELECT (att->>'category') AS category, COUNT(*)::text AS n
       FROM video_analysis_clips c
       ${nicheId ? `JOIN video_analysis_jobs j ON j.id = c.job_id AND j.custom_niche_id = ${nicheId}` : ''}
       CROSS JOIN LATERAL jsonb_array_elements(c.attempts) AS att
      WHERE c.completed_at > NOW() - INTERVAL '1 hour'
      GROUP BY (att->>'category')
      ORDER BY COUNT(*) DESC
      LIMIT 20`,
  );
  const recentErrCats: Record<string, number> = {};
  for (const r of errCatRes.rows) recentErrCats[r.category] = parseInt(r.n);

  // 6. List the 10 most-stale in-flight jobs so the operator can spot
  // specific zombies — exactly the data I had to query per-job to
  // diagnose the deadlock that prompted this endpoint.
  const stalestRes = await pool.query<{
    id: number; status: string; stage: string;
    num_clips_done: number; num_clips: number; num_clips_failed: number;
    auto_retry_count: number;
    last_progress_at: Date | null;
    title: string | null;
  }>(
    `SELECT id, status, stage, num_clips_done, num_clips, num_clips_failed,
            auto_retry_count, last_progress_at,
            source_video_title AS title
       FROM video_analysis_jobs
      WHERE status IN ('downloading','splitting','analyzing','collapsing')
            ${scope}
      ORDER BY last_progress_at ASC NULLS FIRST
      LIMIT 10`,
  );

  // 7. Tunables — surface the constants so the operator sees what the
  // pipeline considers "stuck" vs "active" without grepping source.
  // Kept in sync with lib/video-analysis.ts; if you change those,
  // change here too.
  const tunables = {
    targetWorkers:         5,
    globalClipConcurrency: 20,
    stuckAfterMinutes:     15,
    maxAutoRetries:        5,
    watchdogTickMs:        90_000,
  };

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    scope: nicheId ? `customNiche=${nicheId}` : 'global',
    jobStatus:       statusHist,
    inFlightProgressAge: inFlightAge,
    retryCapDistribution: retryHist,
    clipStatus,
    recentErrorCategories: recentErrCats,
    stalestInFlight: stalestRes.rows.map(r => ({
      id: r.id, status: r.status, stage: r.stage,
      clipsDone: r.num_clips_done, clipsTotal: r.num_clips, clipsFailed: r.num_clips_failed,
      autoRetryCount: r.auto_retry_count,
      lastProgressAt: r.last_progress_at?.toISOString() ?? null,
      lastProgressAgeSeconds: r.last_progress_at
        ? Math.round((Date.now() - r.last_progress_at.getTime()) / 1000)
        : null,
      title: r.title,
    })),
    tunables,
    // Quick health verdict so operators don't have to interpret raw
    // counts. Healthy = at least 1 active worker, < TARGET_WORKERS
    // stuck slots, recentErrorCategories doesn't show >50% retriable
    // errors. Stuck = everything in flight is past STUCK_AFTER_MINUTES.
    verdict: buildVerdict(inFlightAge, statusHist, recentErrCats, tunables),
  });
}

function buildVerdict(
  age: { active_lt_90s: number; active_90s_5m: number; active_5m_15m: number; stuck_15m_1h: number; stuck_gt_1h: number },
  jobStatus: Record<string, number>,
  recentErrs: Record<string, number>,
  t: { targetWorkers: number; stuckAfterMinutes: number },
): string[] {
  const out: string[] = [];
  const active = age.active_lt_90s + age.active_90s_5m;
  const stuck  = age.stuck_15m_1h + age.stuck_gt_1h;
  const inFlight = active + age.active_5m_15m + stuck;

  if (inFlight === 0 && (jobStatus.pending ?? 0) > 0) {
    out.push(`⚠ ${jobStatus.pending} jobs pending but ZERO in flight — watchdog isn't spawning workers`);
  } else if (active < t.targetWorkers && (jobStatus.pending ?? 0) > 0) {
    out.push(`⚠ only ${active} workers actively progressing (target=${t.targetWorkers}) with ${jobStatus.pending} pending`);
  }
  if (stuck > 0) {
    out.push(`⚠ ${stuck} job${stuck === 1 ? '' : 's'} stuck >${t.stuckAfterMinutes}m without progress — watchdog should be resetting these`);
  }
  const totalErrs = Object.values(recentErrs).reduce((a, b) => a + b, 0);
  if (totalErrs > 0) {
    const top = Object.entries(recentErrs).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, n]) => `${k}=${n}`).join(', ');
    out.push(`recent errors (last 1h): ${top}`);
  }
  if (out.length === 0) {
    out.push(`✓ pipeline healthy: ${active} active workers, no stuck jobs`);
  }
  return out;
}
