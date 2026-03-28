/**
 * Shared helpers for the stateful clipping pipeline.
 * Each step endpoint uses these to update project state in DB.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from './db';
import { getApiUser, type ApiUser } from './api-auth';

export type PipelineStep = 'upload' | 'download' | 'analyze' | 'select-clips' | 'detect-faces' | 'cut-clips';

/** Mark a step as running. Returns false if another step is already running. */
export async function setStepRunning(projectId: string, step: PipelineStep, progress?: Record<string, unknown>): Promise<boolean> {
  const result = await pool.query(
    `UPDATE clipping_projects
     SET current_step = $2, step_status = 'running', step_progress = $3, error = NULL, updated_at = NOW()
     WHERE id = $1 AND (step_status IS NULL OR step_status != 'running' OR current_step = $2)
     RETURNING id`,
    [projectId, step, JSON.stringify(progress || {})]
  );
  return (result.rowCount || 0) > 0;
}

/** Update progress for the current running step. */
export async function setStepProgress(projectId: string, progress: Record<string, unknown>): Promise<void> {
  await pool.query(
    `UPDATE clipping_projects SET step_progress = $2, updated_at = NOW() WHERE id = $1`,
    [projectId, JSON.stringify(progress)]
  );
}

/** Mark current step as done. */
export async function setStepDone(projectId: string, extraUpdates?: Record<string, unknown>): Promise<void> {
  let query = `UPDATE clipping_projects SET step_status = 'done', updated_at = NOW()`;
  const params: unknown[] = [projectId];
  let idx = 2;

  if (extraUpdates) {
    for (const [key, value] of Object.entries(extraUpdates)) {
      query += `, ${key} = $${idx}`;
      params.push(value);
      idx++;
    }
  }

  query += ` WHERE id = $1`;
  await pool.query(query, params);
}

/** Mark current step as failed with error message. */
export async function setStepError(projectId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE clipping_projects SET step_status = 'error', error = $2, updated_at = NOW() WHERE id = $1`,
    [projectId, error]
  );
}

/** Log a step to clipping_logs. */
export async function logStep(
  projectId: string,
  step: string,
  status: string,
  message: string,
  data?: Record<string, unknown>,
  analysisId?: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO clipping_logs (project_id, analysis_id, step, status, message, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [projectId, analysisId || null, step, status, message, data ? JSON.stringify(data) : null]
  ).catch((err) => console.error('[pipeline-log] Error:', err.message));
}

/** Auth + ownership check. Returns user + project or error response. */
export async function validateProject(
  req: NextRequest,
  projectId: string,
  requires?: { sourceVideo?: boolean; analysis?: boolean; clips?: boolean },
): Promise<{ user: ApiUser; project: Record<string, unknown> } | NextResponse> {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await pool.query(
    `SELECT * FROM clipping_projects WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)`,
    [projectId, user.id]
  );
  if (result.rows.length === 0) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const project = result.rows[0];

  if (requires?.sourceVideo && !project.source_path) {
    return NextResponse.json({ error: 'No source video. Upload or download a video first.' }, { status: 400 });
  }

  if (requires?.analysis) {
    const analysis = await pool.query(
      `SELECT id FROM clipping_analyses WHERE project_id = $1 AND status = 'done' LIMIT 1`,
      [projectId]
    );
    if (analysis.rows.length === 0) {
      return NextResponse.json({ error: 'No completed analysis. Run analyze first.' }, { status: 400 });
    }
  }

  if (requires?.clips) {
    const clips = await pool.query(
      `SELECT id FROM clipping_clips WHERE project_id = $1 LIMIT 1`,
      [projectId]
    );
    if (clips.rows.length === 0) {
      return NextResponse.json({ error: 'No clips selected. Run select-clips first.' }, { status: 400 });
    }
  }

  return { user, project };
}
