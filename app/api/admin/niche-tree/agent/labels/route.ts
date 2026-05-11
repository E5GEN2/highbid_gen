import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { backfillClusterAiLabels, type LabelBackfillProgress } from '@/lib/cluster-labels';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Admin endpoint to (re)label clusters via Gemini Flash.
 *
 * Fire-and-forget: POST returns immediately and the actual labeling
 * work runs server-side until completion. The handler keeps a module-
 * scope flag so concurrent triggers are rejected, and persists live
 * progress to admin_config so a GET can read it back across restarts.
 *
 *   POST /api/admin/niche-tree/agent/labels
 *     body: {
 *       runId?: number,         // scope: only label this run's clusters (and L2 children); omit for all
 *       mode?: 'missing' | 'all',
 *       threads?: number
 *     }
 *     → { ok, started, jobKey } (started=false if already running)
 *
 *   GET /api/admin/niche-tree/agent/labels[?runId=N]
 *     → { running, jobKey, last: LabelBackfillProgress | null,
 *         counts: { total, labeled, missing } }
 *
 * The TF-IDF auto_label is still written by cluster-niches.py; ai_label
 * is an additive layer the frontend prefers when present.
 */

// In-memory single-flight gate. Railway container restarts reset this,
// which is fine — mode='missing' lets the operator just re-trigger and
// the worker picks up from where it left off.
let inFlight = false;
let lastProgress: LabelBackfillProgress | null = null;
let lastJobKey: string | null = null;

async function fetchCounts(runId?: number): Promise<{ total: number; labeled: number; missing: number }> {
  const pool = await getPool();
  const params: number[] = [];
  let scope = '';
  if (runId) {
    scope = `AND (run_id = $1 OR parent_cluster_id IN (SELECT id FROM niche_tree_clusters WHERE run_id = $1))`;
    params.push(runId);
  }
  const r = await pool.query<{ total: string; labeled: string; missing: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE ai_label IS NOT NULL AND ai_label != '')::text AS labeled,
       COUNT(*) FILTER (WHERE ai_label IS NULL OR ai_label = '')::text AS missing
     FROM niche_tree_clusters
     WHERE 1=1 ${scope}`,
    params,
  );
  return {
    total: parseInt(r.rows[0].total),
    labeled: parseInt(r.rows[0].labeled),
    missing: parseInt(r.rows[0].missing),
  };
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const runIdParam = req.nextUrl.searchParams.get('runId');
  const runId = runIdParam ? parseInt(runIdParam) : undefined;
  const counts = await fetchCounts(runId);
  return NextResponse.json({
    running: inFlight,
    jobKey: lastJobKey,
    last: lastProgress,
    counts,
  });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    runId?: number;
    mode?: 'missing' | 'all';
    threads?: number;
  };

  if (inFlight) {
    return NextResponse.json(
      { ok: true, started: false, reason: 'already_running', jobKey: lastJobKey },
      { status: 200 },
    );
  }

  const mode = body.mode ?? 'missing';
  const threads = body.threads ?? 10;
  const runId = body.runId;
  const jobKey = `labels-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  lastJobKey = jobKey;
  inFlight = true;

  // Reset progress baseline so a /GET right after start doesn't show
  // stale numbers from the previous job.
  lastProgress = { total: 0, processed: 0, upserted: 0, skipped: 0, errors: 0 };

  // Fire-and-forget. Returning the response below releases the request;
  // the promise keeps running on the same Node process. Errors are
  // logged + recorded into lastProgress so a /GET surfaces them.
  (async () => {
    const startedAt = Date.now();
    console.log(`[cluster-labels] starting jobKey=${jobKey} mode=${mode} runId=${runId ?? 'all'} threads=${threads}`);
    try {
      const result = await backfillClusterAiLabels({
        mode,
        scope: runId ? { runId } : 'all',
        threads,
        onProgress: p => { lastProgress = p; },
      });
      lastProgress = result;
      console.log(`[cluster-labels] jobKey=${jobKey} done in ${((Date.now() - startedAt) / 1000).toFixed(0)}s — total=${result.total} upserted=${result.upserted} skipped=${result.skipped} errors=${result.errors}`);
    } catch (err) {
      console.error(`[cluster-labels] jobKey=${jobKey} failed:`, err);
      // Keep the last partial progress visible to GET so the operator
      // can see how far we got before the crash.
    } finally {
      inFlight = false;
    }
  })();

  return NextResponse.json({
    ok: true,
    started: true,
    jobKey,
    mode,
    threads,
    runId: runId ?? null,
  });
}
