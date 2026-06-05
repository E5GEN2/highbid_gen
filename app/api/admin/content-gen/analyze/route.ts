import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { runAnalysisJob } from '@/lib/video-analysis';

/**
 * Content-gen analysis orchestrator.
 *
 * Drives the FULL audiovisual transcription pipeline (the analyze-vids
 * module — download → ffmpeg split → Gemini-per-clip → timeline JSON,
 * ~$0.045/video) for the top videos of channels we're about to generate
 * a listicle from. Reuses the video_analysis_jobs table + runAnalysisJob
 * worker — same high-quality second-by-second timeline we mined from the
 * 352-video corpus.
 *
 * This is step [1] of content-gen stage A. Step [2] (meta-extraction:
 * timeline → clean niche label / recipe / language / faceless) reads the
 * timeline_jsonb these jobs produce and runs a single Gemini call over
 * it — added next.
 *
 * POST  { videoIds: number[], concurrentStarts?, skipAnalysed? }
 *   → enqueues a transcription job per video (skipping ones already
 *     done / in-flight), fires the first N workers, returns job ids +
 *     per-video status.
 *
 * GET   ?videoIds=1,2,3
 *   → poll: per-video job status + whether the timeline is ready.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

interface AnalyzeBody {
  videoIds?: number[];
  /** How many workers to fire immediately (rest sit pending). Default 5. */
  concurrentStarts?: number;
  /** Skip videos that already have a done/in-flight transcription. Default true. */
  skipAnalysed?: boolean;
}

const LIVE_STATUSES = ['pending', 'downloading', 'splitting', 'analyzing', 'collapsing', 'done'];

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as AnalyzeBody;
  const videoIds = Array.isArray(body.videoIds) ? body.videoIds.filter(n => Number.isFinite(n)) : [];
  const concurrentStarts = Math.max(1, Math.min(20, body.concurrentStarts ?? 5));
  const skipAnalysed = body.skipAnalysed !== false;

  if (videoIds.length === 0) {
    return NextResponse.json({ error: 'videoIds (number[]) required' }, { status: 400 });
  }

  const pool = await getPool();

  // Resolve url + title for each video. yt-dlp needs the url.
  const vidRes = await pool.query<{ id: number; url: string | null; title: string | null }>(
    `SELECT id, url, title FROM niche_spy_videos
      WHERE id = ANY($1::int[]) AND url IS NOT NULL`,
    [videoIds],
  );
  const videoRows = vidRes.rows.filter(v => v.url);
  if (videoRows.length === 0) {
    return NextResponse.json({ ok: true, created: 0, skipped: 0, jobIds: [], note: 'no videos with a url matched' });
  }

  // Skip videos that already have a usable transcription job.
  let toCreate = videoRows;
  let skipped: Array<{ videoId: number; jobId: number; status: string }> = [];
  if (skipAnalysed) {
    const existRes = await pool.query<{ id: number; video_id: number; status: string }>(
      `SELECT DISTINCT ON (video_id) id, video_id, status
         FROM video_analysis_jobs
        WHERE video_id = ANY($1::int[])
          AND status = ANY($2::text[])
        ORDER BY video_id, created_at DESC`,
      [videoRows.map(v => v.id), LIVE_STATUSES],
    );
    const existing = new Map(existRes.rows.map(r => [r.video_id, r]));
    toCreate = videoRows.filter(v => !existing.has(v.id));
    skipped = Array.from(existing.values()).map(r => ({ videoId: r.video_id, jobId: r.id, status: r.status }));
  }

  let jobIds: number[] = [];
  if (toCreate.length > 0) {
    const valuesPh: string[] = [];
    const args: unknown[] = [];
    let p = 1;
    for (const v of toCreate) {
      // custom_niche_id + user_id null — these are content-gen-driven,
      // not tied to a niche or user.
      valuesPh.push(`($${p++}, NULL, NULL, $${p++}, 'pending')`);
      args.push(v.id, v.url);
    }
    const insRes = await pool.query<{ id: number }>(
      `INSERT INTO video_analysis_jobs (video_id, custom_niche_id, user_id, youtube_url, status)
       VALUES ${valuesPh.join(', ')}
       RETURNING id`,
      args,
    );
    jobIds = insRes.rows.map(r => r.id);

    // Fire the first N workers immediately; the rest sit pending until a
    // GET poll re-fires them or the global process-pending sweep claims
    // them.
    for (const jobId of jobIds.slice(0, concurrentStarts)) {
      void runAnalysisJob(jobId).catch(err => {
        console.error(`[content-gen/analyze] job ${jobId} runAnalysisJob threw:`, err);
      });
    }
  }

  return NextResponse.json({
    ok: true,
    created: jobIds.length,
    skipped: skipped.length,
    skippedDetail: skipped,
    jobIds,
    startedNow: Math.min(concurrentStarts, jobIds.length),
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const videoIds = (sp.get('videoIds') ?? '')
    .split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));
  if (videoIds.length === 0) {
    return NextResponse.json({ error: 'videoIds query param required (comma-separated)' }, { status: 400 });
  }

  const pool = await getPool();

  // Latest job per video + whether its timeline is populated. Also
  // re-fire any 'pending' workers we find so a poll keeps the queue
  // moving even if the initial concurrentStarts didn't cover everything.
  const r = await pool.query<{
    video_id: number;
    job_id: number;
    status: string;
    stage: string | null;
    num_clips: number;
    num_clips_done: number;
    num_clips_failed: number;
    total_segments: number | null;
    has_timeline: boolean;
    error_message: string | null;
    error_category: string | null;
  }>(
    `SELECT DISTINCT ON (j.video_id)
       j.video_id, j.id AS job_id, j.status, j.stage,
       j.num_clips, j.num_clips_done, j.num_clips_failed, j.total_segments,
       (j.timeline_jsonb IS NOT NULL) AS has_timeline,
       j.error_message, j.error_category
     FROM video_analysis_jobs j
     WHERE j.video_id = ANY($1::int[])
     ORDER BY j.video_id, j.created_at DESC`,
    [videoIds],
  );

  // Re-fire stuck-pending jobs (fire-and-forget). runAnalysisJob is a
  // no-op if the job already moved past pending.
  for (const row of r.rows) {
    if (row.status === 'pending') {
      void runAnalysisJob(row.job_id).catch(() => {});
    }
  }

  const byVideo = new Map(r.rows.map(row => [row.video_id, row]));
  const jobs = videoIds.map(vid => {
    const row = byVideo.get(vid);
    if (!row) return { videoId: vid, status: 'not_enqueued' as const };
    return {
      videoId:        vid,
      jobId:          row.job_id,
      status:         row.status,
      stage:          row.stage,
      numClips:       row.num_clips,
      numClipsDone:   row.num_clips_done,
      numClipsFailed: row.num_clips_failed,
      totalSegments:  row.total_segments,
      hasTimeline:    row.has_timeline,
      errorMessage:   row.error_message,
      errorCategory:  row.error_category,
    };
  });

  const counts = {
    not_enqueued: jobs.filter(j => j.status === 'not_enqueued').length,
    pending:      jobs.filter(j => j.status === 'pending').length,
    in_progress:  jobs.filter(j => ['downloading', 'splitting', 'analyzing', 'collapsing'].includes(j.status)).length,
    done:         jobs.filter(j => j.status === 'done').length,
    error:        jobs.filter(j => j.status === 'error').length,
  };

  return NextResponse.json({
    ok: true,
    allDone: counts.done === videoIds.length,
    counts,
    jobs,
  });
}
