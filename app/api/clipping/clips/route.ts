import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { pool } from '@/lib/db';

/**
 * GET /api/clipping/clips?projectId=xxx
 * List clips for a project. Requires auth — user must own the project.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const projectId = req.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 });
  }

  // Verify ownership
  const projectCheck = await pool.query(
    `SELECT id, title, status FROM clipping_projects WHERE id = $1 AND user_id = $2`,
    [projectId, session.user.id]
  );
  if (projectCheck.rows.length === 0) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const clips = await pool.query(
    `SELECT id, title, description, score, start_sec, end_sec, duration_sec,
            transcript, status, file_size_bytes, created_at
     FROM clipping_clips
     WHERE project_id = $1
     ORDER BY score DESC`,
    [projectId]
  );

  return NextResponse.json({
    project: projectCheck.rows[0],
    clips: clips.rows,
  });
}
