import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getConcurrencyStats } from '@/lib/gemini-files';

/**
 * GET /api/clipping/debug?projectId=xxx
 * Debug endpoint — returns full project + analysis + logs data.
 * No auth required (admin debug tool).
 */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId');

  if (!projectId) {
    // List all projects with their latest analysis status
    const result = await pool.query(`
      SELECT p.*,
        a.id as analysis_id, a.status as analysis_status,
        a.video_url, a.video_duration_seconds, a.total_segments,
        a.error as analysis_error, a.tokens_in, a.tokens_out, a.duration_ms,
        a.created_at as analysis_started, a.completed_at as analysis_completed,
        (SELECT COUNT(*) FROM clipping_logs WHERE project_id = p.id) as log_count
      FROM clipping_projects p
      LEFT JOIN LATERAL (
        SELECT * FROM clipping_analyses WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1
      ) a ON true
      ORDER BY p.updated_at DESC
      LIMIT 50
    `);
    return NextResponse.json({ projects: result.rows, concurrency: getConcurrencyStats() });
  }

  // Full detail for a specific project
  const project = await pool.query(
    `SELECT * FROM clipping_projects WHERE id = $1`, [projectId]
  );

  const analyses = await pool.query(
    `SELECT id, status, video_url, video_duration_seconds, total_segments,
            error, tokens_in, tokens_out, duration_ms, created_at, completed_at
     FROM clipping_analyses WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId]
  );

  const logs = await pool.query(
    `SELECT * FROM clipping_logs WHERE project_id = $1 ORDER BY created_at ASC LIMIT 200`,
    [projectId]
  );

  // Get segments from latest analysis (separate query to keep listing light)
  let segments = null;
  if (analyses.rows.length > 0) {
    const segResult = await pool.query(
      `SELECT segments FROM clipping_analyses WHERE id = $1`, [analyses.rows[0].id]
    );
    segments = segResult.rows[0]?.segments;
  }

  return NextResponse.json({
    project: project.rows[0] || null,
    analyses: analyses.rows,
    segments,
    logs: logs.rows,
  });
}
