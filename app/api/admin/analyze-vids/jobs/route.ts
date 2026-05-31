import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { runAnalysisJob } from '@/lib/video-analysis';

/**
 * Admin entry for the video-analysis pipeline.
 *
 * POST creates pending jobs for a batch of videos (from a custom niche
 * or an explicit videoIds list). GET lists jobs with the filters the
 * admin tab needs (niche, user, status, since).
 *
 * autoStart=true (default) immediately claims up to `concurrentStarts`
 * of the just-created jobs and fires their workers fire-and-forget so
 * the operator doesn't have to call process-pending separately.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

interface CreateJobsBody {
  customNicheId?: number;
  videoIds?: number[];
  userEmail?: string;
  limit?: number;                // cap on how many jobs to create
  skipAnalysed?: boolean;        // default true — don't re-enqueue videos
                                 // that already have a done/in-flight job for this user
  autoStart?: boolean;           // default true — kick workers right away
  concurrentStarts?: number;     // default 5 — how many to fire on POST
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as CreateJobsBody;
  const skipAnalysed   = body.skipAnalysed !== false;
  const autoStart      = body.autoStart    !== false;
  const concurrentStarts = Math.max(1, Math.min(20, body.concurrentStarts ?? 5));
  const limit          = Math.max(1, Math.min(1000, body.limit ?? 1000));

  const pool = await getPool();

  // Resolve user_id from email if provided. Optional — analysis jobs
  // can run unattached when the operator just wants to backfill.
  let userId: string | null = null;
  if (body.userEmail) {
    const r = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [body.userEmail]);
    if (r.rows.length === 0) {
      return NextResponse.json({ error: `no user with email ${body.userEmail}` }, { status: 400 });
    }
    userId = r.rows[0].id;
  }

  // Pull videos either from the custom niche or from explicit ids.
  // Both paths join niche_spy_videos for the url + title; the url is
  // what yt-dlp needs.
  let videoRows: Array<{ id: number; url: string; title: string | null }> = [];
  if (body.customNicheId != null) {
    const r = await pool.query<{ id: number; url: string; title: string | null }>(
      `SELECT v.id, v.url, v.title
         FROM custom_niche_videos cnv
         JOIN niche_spy_videos v ON v.id = cnv.video_id
        WHERE cnv.custom_niche_id = $1
          AND v.url IS NOT NULL
        ORDER BY cnv.added_at ASC
        LIMIT $2`,
      [body.customNicheId, limit],
    );
    videoRows = r.rows;
  } else if (Array.isArray(body.videoIds) && body.videoIds.length > 0) {
    const r = await pool.query<{ id: number; url: string; title: string | null }>(
      `SELECT id, url, title FROM niche_spy_videos
        WHERE id = ANY($1::int[]) AND url IS NOT NULL
        LIMIT $2`,
      [body.videoIds, limit],
    );
    videoRows = r.rows;
  } else {
    return NextResponse.json({ error: 'customNicheId or videoIds required' }, { status: 400 });
  }

  if (videoRows.length === 0) {
    return NextResponse.json({ ok: true, created: 0, skipped: 0, jobIds: [], note: 'no videos matched' });
  }

  // Optionally skip videos that already have a done or in-flight job
  // for this user. Lets the operator hit "Analyze niche" repeatedly
  // without redoing work.
  let toCreate = videoRows;
  let skipped = 0;
  if (skipAnalysed) {
    const ids = videoRows.map(v => v.id);
    const existRes = await pool.query<{ video_id: number }>(
      `SELECT DISTINCT video_id FROM video_analysis_jobs
        WHERE video_id = ANY($1::int[])
          AND ($2::uuid IS NULL OR user_id = $2)
          AND status IN ('pending', 'downloading', 'splitting', 'analyzing', 'collapsing', 'done')`,
      [ids, userId],
    );
    const exist = new Set(existRes.rows.map(r => r.video_id));
    toCreate = videoRows.filter(v => !exist.has(v.id));
    skipped = videoRows.length - toCreate.length;
  }

  if (toCreate.length === 0) {
    return NextResponse.json({ ok: true, created: 0, skipped, jobIds: [], note: 'all videos already analysed / pending' });
  }

  // Bulk-insert all jobs in one round-trip.
  const valuesPh: string[] = [];
  const args: unknown[] = [];
  let p = 1;
  for (const v of toCreate) {
    valuesPh.push(`($${p++}, $${p++}, $${p++}, $${p++}, 'pending')`);
    args.push(v.id, body.customNicheId ?? null, userId, v.url);
  }
  const insRes = await pool.query<{ id: number }>(
    `INSERT INTO video_analysis_jobs
       (video_id, custom_niche_id, user_id, youtube_url, status)
     VALUES ${valuesPh.join(', ')}
     RETURNING id`,
    args,
  );
  const jobIds = insRes.rows.map(r => r.id);

  // Optionally fire the first N workers right away. The rest sit in
  // pending until process-pending claims them (or another POST runs).
  if (autoStart) {
    const startNow = jobIds.slice(0, concurrentStarts);
    for (const jobId of startNow) {
      // Fire-and-forget. runAnalysisJob handles its own status
      // transitions and error capture.
      void runAnalysisJob(jobId).catch(err => {
        console.error(`[analyze-vids] job ${jobId} runAnalysisJob threw:`, err);
      });
    }
  }

  return NextResponse.json({
    ok: true,
    created: jobIds.length,
    skipped,
    jobIds,
    startedNow: autoStart ? Math.min(concurrentStarts, jobIds.length) : 0,
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const pool = await getPool();
  const sp = req.nextUrl.searchParams;
  const customNicheId = sp.get('customNicheId');
  const userEmail     = sp.get('userEmail');
  const status        = sp.get('status');                   // comma-separated allowed
  const since         = sp.get('since');                    // ISO timestamp
  const limit         = Math.max(1, Math.min(500, parseInt(sp.get('limit') ?? '100') || 100));

  const conds: string[] = [];
  const args: unknown[] = [];
  let p = 1;
  if (customNicheId) { conds.push(`j.custom_niche_id = $${p++}`); args.push(parseInt(customNicheId)); }
  if (userEmail)     {
    conds.push(`j.user_id = (SELECT id FROM users WHERE email = $${p++})`);
    args.push(userEmail);
  }
  if (status) {
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length > 0) {
      conds.push(`j.status = ANY($${p++}::text[])`);
      args.push(statuses);
    }
  }
  if (since) { conds.push(`j.created_at > $${p++}`); args.push(since); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  args.push(limit);

  const r = await pool.query<{
    id: number;
    video_id: number | null;
    custom_niche_id: number | null;
    user_id: string | null;
    youtube_url: string;
    source_video_title: string | null;
    source_video_duration_s: number | null;
    num_clips: number;
    num_clips_done: number;
    num_clips_failed: number;
    total_segments: number | null;
    status: string;
    stage: string | null;
    error_message: string | null;
    started_at: Date | null;
    completed_at: Date | null;
    last_progress_at: Date | null;
    created_at: Date;
  }>(
    `SELECT j.id, j.video_id, j.custom_niche_id, j.user_id, j.youtube_url,
            j.source_video_title, j.source_video_duration_s,
            j.num_clips, j.num_clips_done, j.num_clips_failed, j.total_segments,
            j.status, j.stage, j.error_message,
            j.started_at, j.completed_at, j.last_progress_at, j.created_at
       FROM video_analysis_jobs j
       ${where}
       ORDER BY j.created_at DESC
       LIMIT $${p}`,
    args,
  );

  // Aggregate counts for the header strip (also scoped by filters).
  const statsRes = await pool.query<{
    pending: string; running: string; done: string; error: string; total: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE j.status = 'pending')::text AS pending,
       COUNT(*) FILTER (WHERE j.status IN ('downloading','splitting','analyzing','collapsing'))::text AS running,
       COUNT(*) FILTER (WHERE j.status = 'done')::text  AS done,
       COUNT(*) FILTER (WHERE j.status = 'error')::text AS error,
       COUNT(*)::text AS total
       FROM video_analysis_jobs j
       ${where}`,
    args.slice(0, -1),
  );

  return NextResponse.json({
    ok: true,
    rows: r.rows.map(r => ({
      id: r.id,
      videoId: r.video_id,
      customNicheId: r.custom_niche_id,
      userId: r.user_id,
      youtubeUrl: r.youtube_url,
      title: r.source_video_title,
      durationS: r.source_video_duration_s,
      numClips: r.num_clips,
      numClipsDone: r.num_clips_done,
      numClipsFailed: r.num_clips_failed,
      totalSegments: r.total_segments,
      status: r.status,
      stage: r.stage,
      errorMessage: r.error_message,
      startedAt: r.started_at?.toISOString() ?? null,
      completedAt: r.completed_at?.toISOString() ?? null,
      lastProgressAt: r.last_progress_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    })),
    stats: {
      pending: parseInt(statsRes.rows[0].pending),
      running: parseInt(statsRes.rows[0].running),
      done:    parseInt(statsRes.rows[0].done),
      error:   parseInt(statsRes.rows[0].error),
      total:   parseInt(statsRes.rows[0].total),
    },
  });
}
