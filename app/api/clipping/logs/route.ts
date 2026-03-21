import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';

/**
 * GET /api/clipping/logs?projectId=xxx[&analysisId=yyy][&limit=50]
 * Debug endpoint — returns processing logs for a clipping project.
 * No auth required (admin debug tool).
 */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId');
  const analysisId = req.nextUrl.searchParams.get('analysisId');
  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '100');

  if (!projectId && !analysisId) {
    return NextResponse.json({ error: 'projectId or analysisId required' }, { status: 400 });
  }

  let query: string;
  let params: (string | number)[];

  if (analysisId) {
    query = `SELECT * FROM clipping_logs WHERE analysis_id = $1 ORDER BY created_at ASC LIMIT $2`;
    params = [analysisId, limit];
  } else {
    query = `SELECT * FROM clipping_logs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`;
    params = [projectId!, limit];
  }

  const result = await pool.query(query, params);
  return NextResponse.json({ logs: result.rows, count: result.rows.length });
}

/**
 * DELETE /api/clipping/logs?projectId=xxx
 * Clear logs for a project.
 */
export async function DELETE(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 });
  }

  await pool.query(`DELETE FROM clipping_logs WHERE project_id = $1`, [projectId]);
  return NextResponse.json({ ok: true });
}
