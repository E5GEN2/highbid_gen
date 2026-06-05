import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { extractChannelMeta } from '@/lib/content-gen/channel-analysis';

/**
 * GET /api/admin/content-gen/meta-test?videoIds=1,2,3
 *
 * Throwaway test harness for the meta-extraction prompt. For each video
 * with a DONE transcription job, runs extractChannelMeta() over its
 * timeline and returns the structured output side-by-side with the video
 * title. Lets us eyeball niche_label / recipe_formula quality before
 * wiring meta-extraction into the pipeline + persisting results.
 *
 * Does NOT persist anything — pure read + Gemini call.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const videoIds = (req.nextUrl.searchParams.get('videoIds') ?? '')
    .split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));
  if (videoIds.length === 0) {
    return NextResponse.json({ error: 'videoIds query param required' }, { status: 400 });
  }

  const pool = await getPool();
  const r = await pool.query<{
    video_id: number;
    job_id: number;
    status: string;
    source_video_title: string | null;
    timeline_jsonb: Record<string, unknown> | null;
    total_segments: number | null;
  }>(
    `SELECT DISTINCT ON (j.video_id)
       j.video_id, j.id AS job_id, j.status, j.source_video_title,
       j.timeline_jsonb, j.total_segments
     FROM video_analysis_jobs j
     WHERE j.video_id = ANY($1::int[])
     ORDER BY j.video_id, j.created_at DESC`,
    [videoIds],
  );

  const results = await Promise.all(r.rows.map(async (row) => {
    if (row.status !== 'done' || !row.timeline_jsonb) {
      return {
        videoId: row.video_id,
        jobId: row.job_id,
        status: row.status,
        skipped: `not ready (status=${row.status}, hasTimeline=${!!row.timeline_jsonb})`,
      };
    }
    const t0 = Date.now();
    try {
      const meta = await extractChannelMeta(
        row.timeline_jsonb as Parameters<typeof extractChannelMeta>[0],
        row.source_video_title ?? '',
      );
      return {
        videoId: row.video_id,
        jobId: row.job_id,
        title: row.source_video_title,
        totalSegments: row.total_segments,
        extractionMs: Date.now() - t0,
        meta,
      };
    } catch (e) {
      return {
        videoId: row.video_id,
        jobId: row.job_id,
        title: row.source_video_title,
        error: (e as Error).message,
      };
    }
  }));

  return NextResponse.json({ ok: true, results });
}
