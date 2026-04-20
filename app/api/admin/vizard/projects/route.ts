import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import {
  createVizardProject,
  detectVideoType,
  detectExt,
  getVizardApiKey,
  type VizardPreferLength,
  type VizardVideoType,
} from '@/lib/vizard';

// Every request: filters and status reflect real-time DB state, so never cache.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/vizard/projects
 * List all projects with their clips (joined), newest first. Used by the
 * admin UI to render the grid + poll status.
 */
export async function GET() {
  const pool = await getPool();
  const projRes = await pool.query(
    `SELECT id, vizard_project_id, video_url, video_type, lang, prefer_length,
            status, error_message, last_code, clip_count,
            created_at, last_polled_at, completed_at
     FROM vizard_projects
     ORDER BY created_at DESC
     LIMIT 100`
  );
  const projectIds = projRes.rows.map(r => r.id as number);
  const clipsByProject: Record<number, unknown[]> = {};
  if (projectIds.length > 0) {
    const clipsRes = await pool.query(
      `SELECT id, project_id, vizard_video_id, video_url, duration_ms, title,
              transcript, viral_score, viral_reason, related_topic,
              clip_editor_url, local_path, xgodo_upload_status, xgodo_upload_id,
              created_at
       FROM vizard_clips
       WHERE project_id = ANY($1::int[])
       ORDER BY (viral_score::float) DESC NULLS LAST, id ASC`,
      [projectIds]
    );
    for (const row of clipsRes.rows) {
      const pid = row.project_id as number;
      if (!clipsByProject[pid]) clipsByProject[pid] = [];
      clipsByProject[pid].push({
        id: row.id,
        vizardVideoId: row.vizard_video_id,
        videoUrl: row.video_url,
        durationMs: row.duration_ms !== null ? parseInt(row.duration_ms) : null,
        title: row.title,
        transcript: row.transcript,
        viralScore: row.viral_score,
        viralReason: row.viral_reason,
        relatedTopic: row.related_topic,
        clipEditorUrl: row.clip_editor_url,
        localPath: row.local_path,
        xgodoUploadStatus: row.xgodo_upload_status,
        xgodoUploadId: row.xgodo_upload_id,
        createdAt: row.created_at,
      });
    }
  }

  const projects = projRes.rows.map(r => ({
    id: r.id,
    vizardProjectId: r.vizard_project_id,
    videoUrl: r.video_url,
    videoType: r.video_type,
    lang: r.lang,
    preferLength: r.prefer_length,
    status: r.status,
    errorMessage: r.error_message,
    lastCode: r.last_code,
    clipCount: r.clip_count,
    createdAt: r.created_at,
    lastPolledAt: r.last_polled_at,
    completedAt: r.completed_at,
    clips: clipsByProject[r.id] || [],
  }));

  return NextResponse.json({ projects });
}

/**
 * POST /api/admin/vizard/projects
 * Body: { videoUrl, preferLength?: number[], lang?: string, videoType?: 1-12, ext?: 'mp4'|... }
 *
 * Creates a Vizard project and inserts a pending row. Actual clip retrieval
 * happens via the tick route (server-side polling).
 */
export async function POST(req: NextRequest) {
  const pool = await getPool();
  const body = (await req.json().catch(() => ({}))) as {
    videoUrl?: string;
    preferLength?: number[];
    lang?: string;
    videoType?: number;
    ext?: 'mp4' | 'mov' | '3gp' | 'avi';
  };

  const videoUrl = (body.videoUrl || '').trim();
  if (!videoUrl) {
    return NextResponse.json({ error: 'videoUrl is required' }, { status: 400 });
  }

  const apiKey = await getVizardApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Vizard API key not configured. Set `vizard_api_key` in the admin General tab.' },
      { status: 400 }
    );
  }

  // Resolve videoType. Caller override > URL sniff. If we can't resolve, bail
  // early so we don't waste a Vizard call on an unsupported URL.
  const videoType: VizardVideoType | null =
    (body.videoType as VizardVideoType) || detectVideoType(videoUrl);
  if (!videoType) {
    return NextResponse.json(
      { error: `Could not detect video type from URL. Pass videoType explicitly (1=mp4, 2=YouTube, 3=Drive, 4=Vimeo, 5=StreamYard, 6=TikTok, 7=Twitter, 9=Twitch, 10=Loom, 11=Facebook, 12=LinkedIn).` },
      { status: 400 }
    );
  }

  // Normalize preferLength. Vizard rejects mixing 0 with other values, so if
  // the caller tries to, we strip non-zero when 0 is present.
  let preferLength = (body.preferLength || [0]) as VizardPreferLength[];
  if (preferLength.includes(0) && preferLength.length > 1) preferLength = [0];

  const lang = body.lang || 'auto';
  const ext = videoType === 1 ? (body.ext || detectExt(videoUrl) || 'mp4') : undefined;

  // Insert row first in 'pending' so the UI shows the submission even if
  // the Vizard call fails. Vizard's projectId is filled in after success.
  const insertRes = await pool.query(
    `INSERT INTO vizard_projects (video_url, video_type, lang, prefer_length, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id`,
    [videoUrl, videoType, lang, preferLength]
  );
  const dbId = insertRes.rows[0].id as number;

  try {
    const result = await createVizardProject(
      { videoUrl, videoType, lang, preferLength, ext },
      apiKey,
    );

    if (result.code === 2000 && result.projectId) {
      await pool.query(
        `UPDATE vizard_projects
         SET vizard_project_id = $1, status = 'processing', last_code = $2
         WHERE id = $3`,
        [String(result.projectId), result.code, dbId]
      );
      return NextResponse.json({ ok: true, id: dbId, vizardProjectId: result.projectId });
    }

    // Vizard returned a non-success code — persist the error so the UI can show it.
    await pool.query(
      `UPDATE vizard_projects
       SET status = 'error', last_code = $1, error_message = $2, completed_at = NOW()
       WHERE id = $3`,
      [result.code, result.errMsg || `Vizard code ${result.code}`, dbId]
    );
    return NextResponse.json(
      { error: `Vizard returned code ${result.code}: ${result.errMsg || 'unknown'}`, id: dbId },
      { status: 502 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    await pool.query(
      `UPDATE vizard_projects
       SET status = 'error', error_message = $1, completed_at = NOW()
       WHERE id = $2`,
      [msg, dbId]
    );
    return NextResponse.json({ error: msg, id: dbId }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/vizard/projects?id=123
 * Removes a project and its clips. Does NOT call Vizard (nothing to clean up
 * on their side — clips just expire in 7 days).
 */
export async function DELETE(req: NextRequest) {
  const pool = await getPool();
  const idStr = req.nextUrl.searchParams.get('id');
  if (!idStr) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  const id = parseInt(idStr);
  if (Number.isNaN(id)) return NextResponse.json({ error: 'id must be numeric' }, { status: 400 });
  await pool.query(`DELETE FROM vizard_projects WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
