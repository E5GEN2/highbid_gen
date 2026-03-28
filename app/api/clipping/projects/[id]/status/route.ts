import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getApiUser } from '@/lib/api-auth';

/**
 * GET /api/clipping/projects/{id}/status
 * Full project state — polled by frontend and CLI.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;

  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const projectRes = await pool.query(
    `SELECT id, user_id, title, status, current_step, step_status, step_progress,
            source_path, source_url, video_duration, error,
            created_at, updated_at
     FROM clipping_projects WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)`,
    [projectId, user.id]
  );
  if (projectRes.rows.length === 0) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const [analysisRes, clipsRes, faceRes, logsRes] = await Promise.all([
    pool.query(
      `SELECT id, status, total_segments, video_duration_seconds, error, tokens_in, tokens_out, duration_ms, created_at, completed_at
       FROM clipping_analyses WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [projectId]
    ),
    pool.query(
      `SELECT id, title, description, score, start_sec, end_sec, duration_sec, transcript, status, file_path, thumbnail_path, file_size_bytes, created_at
       FROM clipping_clips WHERE project_id = $1 ORDER BY score DESC`,
      [projectId]
    ),
    pool.query(
      `SELECT total_frames, video_width, video_height, fps_sampled FROM clipping_face_data WHERE project_id = $1 AND clip_id IS NULL LIMIT 1`,
      [projectId]
    ),
    pool.query(
      `SELECT step, status, message, created_at FROM clipping_logs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 15`,
      [projectId]
    ),
  ]);

  const faceRow = faceRes.rows[0];

  return NextResponse.json({
    project: projectRes.rows[0],
    analysis: analysisRes.rows[0] || null,
    clips: clipsRes.rows,
    faceData: faceRow ? {
      totalFrames: faceRow.total_frames,
      videoWidth: faceRow.video_width,
      videoHeight: faceRow.video_height,
      fpsSampled: faceRow.fps_sampled,
    } : null,
    recentLogs: logsRes.rows,
  });
}
