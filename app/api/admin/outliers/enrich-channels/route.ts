import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { runOutlierEnrich } from '@/lib/outlier-enrich';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/admin/outliers/enrich-channels
 *
 * Synchronous channel enrichment — fires the worker pool, waits for
 * completion, returns counters. Powered by lib/outlier-enrich.ts which
 * uses a shared retry queue + random key+proxy pick. Same input/output
 * as the legacy version so the existing admin UI button still works.
 *
 * Body (optional):
 *   { limit?: number, threads?: number, maxVideos?: number, staleDays?: number, force?: boolean }
 *     limit      = max channels to process this call (default 100, cap 5000)
 *     threads    = parallel workers (default 10, cap 30)
 *     maxVideos  = recent uploads to sample per channel (default 30, max 50)
 *     staleDays  = skip channels fetched within this window (default 7)
 *     force      = refetch everything regardless of freshness
 *
 * For long-running enrichment (thousands of channels) prefer the
 * /agent route — it returns immediately, persists progress to
 * outlier_enrich_jobs, and lets you poll until done.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    limit?: number; threads?: number; maxVideos?: number; staleDays?: number; force?: boolean;
  };

  const startedAt = Date.now();
  try {
    const result = await runOutlierEnrich({
      limit: body.limit,
      threads: body.threads,
      maxVideos: body.maxVideos,
      staleDays: body.staleDays,
      force: body.force,
    });
    return NextResponse.json({
      ok: true,
      processed: result.processed,
      withStats: result.withStats,
      errors: result.errors,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message?.slice(0, 500) || 'unknown' },
      { status: 500 },
    );
  }
}

/**
 * GET returns a summary: how many channels have/need enrichment, so the UI
 * can show a progress stat without triggering work.
 */
export async function GET() {
  const pool = await getPool();
  const res = await pool.query<{ total: string; enriched: string; stale: string; pending: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE uploads_playlist_id IS NOT NULL) AS total,
      COUNT(*) FILTER (WHERE recent_videos_count IS NOT NULL AND recent_videos_count > 0) AS enriched,
      COUNT(*) FILTER (WHERE last_recent_videos_fetched_at IS NOT NULL
                        AND last_recent_videos_fetched_at < NOW() - INTERVAL '7 days') AS stale,
      COUNT(*) FILTER (WHERE uploads_playlist_id IS NOT NULL
                        AND last_recent_videos_fetched_at IS NULL) AS pending
    FROM niche_spy_channels
  `);
  const r = res.rows[0];
  return NextResponse.json({
    total:    parseInt(r.total    || '0'),
    enriched: parseInt(r.enriched || '0'),
    stale:    parseInt(r.stale    || '0'),
    pending:  parseInt(r.pending  || '0'),
  });
}
