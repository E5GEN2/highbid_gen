import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/analyze-vids/export
 *
 * Stream a ZIP of every successfully-analysed video in a niche,
 * enriched with all the YouTube metadata we have in the DB. One JSON
 * per video at `videos/{videoId}_{slug}.json` plus a single
 * `manifest.json` at the root with aggregate stats.
 *
 * Excludes the actual clip mp4s — pure metadata + Gemini timelines.
 * 354 videos × ~50-150 KB JSON = ~30-50 MB zip; small enough to
 * build in memory and return as a single Response without streaming
 * a chunked archive.
 *
 * Query params:
 *   customNicheId  (required) — scope to a single custom niche
 *   userEmail      (optional) — scope to one user's jobs
 *   includeGaps    'true' | 'false' (default true) — include jobs that
 *                  finished with [MISSING ANALYSIS] placeholders
 *   includeFailed  'true' | 'false' (default false) — include jobs in
 *                  status='error' (no timeline). Off by default since
 *                  there's nothing useful to ship.
 *
 * One-shot; not streamed. Anything bigger than a single niche of
 * ~1000 videos would need a streamed archive.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const customNicheId = parseInt(sp.get('customNicheId') ?? '');
  if (!Number.isFinite(customNicheId)) {
    return NextResponse.json({ error: 'customNicheId (int) required' }, { status: 400 });
  }
  const userEmail    = sp.get('userEmail');
  const includeGaps  = sp.get('includeGaps')   !== 'false';
  const includeFailed = sp.get('includeFailed') === 'true';

  const pool = await getPool();

  // Niche header — for the manifest + filename.
  const nicheRes = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM custom_niches WHERE id = $1`, [customNicheId],
  );
  if (nicheRes.rows.length === 0) return NextResponse.json({ error: 'niche not found' }, { status: 404 });
  const niche = nicheRes.rows[0];

  // Resolve user id from email if provided.
  let userId: string | null = null;
  if (userEmail) {
    const r = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [userEmail]);
    userId = r.rows[0]?.id ?? null;
  }

  // Pull every analysed video in the niche joined with all the
  // metadata we keep on niche_spy_videos and channel_analysis. Picks
  // the latest non-cancelled job per video so multiple retries don't
  // produce duplicate entries.
  // Aliases: CTE row uses `lj`; the outer WHERE references `lj.status`
  // (NOT `j.status` — the inner `j` alias is only visible inside the
  // CTE).
  const statusFilter = includeFailed
    ? `lj.status IN ('done', 'error')`
    : `lj.status = 'done'`;
  const rowsRes = await pool.query<{
    job_id: number;
    video_id: number | null;
    youtube_url: string;
    source_title: string | null;
    source_duration_s: number | null;
    num_clips: number;
    num_clips_done: number;
    num_clips_failed: number;
    total_segments: number | null;
    timeline_jsonb: Record<string, unknown> | null;
    job_status: string;
    completed_at: Date | null;
    job_created_at: Date;
    // niche_spy_videos columns
    nsv_url: string | null;
    nsv_title: string | null;
    nsv_view_count: string | null;
    nsv_like_count: string | null;
    nsv_comment_count: string | null;
    nsv_subscriber_count: string | null;
    nsv_score: number | null;
    nsv_keyword: string | null;
    nsv_thumbnail: string | null;
    nsv_channel_name: string | null;
    nsv_channel_id: string | null;
    nsv_channel_avatar: string | null;
    nsv_channel_created_at: Date | null;
    nsv_posted_at: Date | null;
    nsv_posted_date: string | null;
    nsv_top_comment: string | null;
    nsv_fetched_at: Date | null;
    // channel_analysis
    ca_category: string | null;
  }>(
    `WITH latest_job AS (
       SELECT DISTINCT ON (j.video_id) j.*
         FROM video_analysis_jobs j
        WHERE j.custom_niche_id = $1
          AND j.status <> 'cancelled'
          AND ($2::uuid IS NULL OR j.user_id = $2)
        ORDER BY j.video_id, j.created_at DESC
     )
     SELECT lj.id AS job_id,
            lj.video_id, lj.youtube_url,
            lj.source_video_title AS source_title,
            lj.source_video_duration_s AS source_duration_s,
            lj.num_clips, lj.num_clips_done, lj.num_clips_failed,
            lj.total_segments, lj.timeline_jsonb,
            lj.status AS job_status, lj.completed_at,
            lj.created_at AS job_created_at,
            nsv.url AS nsv_url, nsv.title AS nsv_title,
            nsv.view_count::text AS nsv_view_count,
            nsv.like_count::text AS nsv_like_count,
            nsv.comment_count::text AS nsv_comment_count,
            nsv.subscriber_count::text AS nsv_subscriber_count,
            nsv.score AS nsv_score, nsv.keyword AS nsv_keyword,
            nsv.thumbnail AS nsv_thumbnail,
            nsv.channel_name AS nsv_channel_name,
            nsv.channel_id AS nsv_channel_id,
            nsv.channel_avatar AS nsv_channel_avatar,
            nsv.channel_created_at AS nsv_channel_created_at,
            nsv.posted_at AS nsv_posted_at,
            nsv.posted_date AS nsv_posted_date,
            nsv.top_comment AS nsv_top_comment,
            nsv.fetched_at AS nsv_fetched_at,
            ca.category AS ca_category
       FROM latest_job lj
       LEFT JOIN niche_spy_videos nsv ON nsv.id = lj.video_id
       LEFT JOIN channel_analysis ca ON ca.channel_id = nsv.channel_id
       WHERE ${statusFilter}
       ORDER BY lj.video_id`,
    [customNicheId, userId],
  );

  const zip = new JSZip();

  // Manifest header — counts, niche metadata, run timestamp.
  const manifest: Record<string, unknown> = {
    niche: { id: niche.id, name: niche.name },
    exportedAt: new Date().toISOString(),
    userEmail: userEmail || null,
    options: { includeGaps, includeFailed },
    counts: {
      jobs: rowsRes.rows.length,
      doneJobs: 0,
      errorJobs: 0,
      jobsWithGaps: 0,
      totalSegments: 0,
      totalClipsAnalysed: 0,
      totalClipsFailed: 0,
    },
    videos: [] as Array<{
      videoId: number | null;
      jobId: number;
      title: string | null;
      channelName: string | null;
      filename: string;
      durationSeconds: number | null;
      totalSegments: number | null;
      hasGaps: boolean;
      status: string;
    }>,
  };
  const counts = manifest.counts as Record<string, number>;

  // Build one JSON per video.
  for (const r of rowsRes.rows) {
    const hasGaps = (r.num_clips_failed ?? 0) > 0;
    if (!includeGaps && hasGaps) continue;

    counts.jobs++;
    if (r.job_status === 'done') counts.doneJobs++;
    if (r.job_status === 'error') counts.errorJobs++;
    if (hasGaps) counts.jobsWithGaps++;
    counts.totalSegments      += r.total_segments ?? 0;
    counts.totalClipsAnalysed += r.num_clips_done ?? 0;
    counts.totalClipsFailed   += r.num_clips_failed ?? 0;

    const slug = (r.source_title ?? r.nsv_title ?? `job-${r.job_id}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `job-${r.job_id}`;
    const filename = `videos/${r.video_id ?? 'noid'}_${slug}.json`;

    const payload = {
      videoId: r.video_id,
      jobId:   r.job_id,
      analysisStatus: r.job_status,
      youtubeUrl:     r.nsv_url ?? r.youtube_url,
      title:          r.nsv_title ?? r.source_title,
      durationSeconds: r.source_duration_s ?? null,
      channel: {
        id:        r.nsv_channel_id,
        name:      r.nsv_channel_name,
        avatar:    r.nsv_channel_avatar,
        createdAt: r.nsv_channel_created_at?.toISOString() ?? null,
        subscriberCount: r.nsv_subscriber_count ? parseInt(r.nsv_subscriber_count) : null,
        aiCategory: r.ca_category,
      },
      metrics: {
        viewCount:    r.nsv_view_count    ? parseInt(r.nsv_view_count)    : null,
        likeCount:    r.nsv_like_count    ? parseInt(r.nsv_like_count)    : null,
        commentCount: r.nsv_comment_count ? parseInt(r.nsv_comment_count) : null,
        score:        r.nsv_score,
      },
      postedAt:      r.nsv_posted_at?.toISOString() ?? null,
      postedDateStr: r.nsv_posted_date,
      thumbnail:     r.nsv_thumbnail,
      keyword:       r.nsv_keyword,
      topComment:    r.nsv_top_comment,
      sourceMetadataFetchedAt: r.nsv_fetched_at?.toISOString() ?? null,
      analysis: {
        clipCount:       r.num_clips,
        clipDoneCount:   r.num_clips_done,
        clipFailedCount: r.num_clips_failed,
        totalSegments:   r.total_segments,
        hasGaps,
        timeline:        r.timeline_jsonb,  // the full collapsed segment array
        completedAt:     r.completed_at?.toISOString() ?? null,
        createdAt:       r.job_created_at.toISOString(),
      },
    };

    zip.file(filename, JSON.stringify(payload, null, 2));

    (manifest.videos as Array<Record<string, unknown>>).push({
      videoId: r.video_id,
      jobId:   r.job_id,
      title:   payload.title,
      channelName: r.nsv_channel_name,
      filename,
      durationSeconds: r.source_duration_s,
      totalSegments:   r.total_segments,
      hasGaps,
      status: r.job_status,
    });
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const safeNicheName = niche.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) || `niche-${niche.id}`;
  const filename = `analyze-vids_${safeNicheName}_${new Date().toISOString().slice(0,10)}.zip`;

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buf.length),
    },
  });
}
