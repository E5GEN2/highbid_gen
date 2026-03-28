import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getPapaiApiKey } from '@/lib/config';
import { validateProject, setStepRunning, setStepDone, setStepError, logStep } from '@/lib/clipping-pipeline';
import { selectClips } from '@/lib/gemini-clip-selector';
import type { VideoSegment } from '@/lib/gemini-files';

/**
 * POST /api/clipping/projects/{id}/select-clips
 * AI picks best clips from analyzed segments. Fire-and-forget.
 * Body: { clipLength? } (default "60s-90s")
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const validation = await validateProject(req, projectId, { analysis: true });
  if (validation instanceof NextResponse) return validation;

  const body = await req.json().catch(() => ({}));
  const clipLength = body.clipLength || '60s-90s';

  const apiKey = await getPapaiApiKey();
  if (!apiKey) return NextResponse.json({ error: 'PAPAI_API_KEY not configured' }, { status: 500 });

  const started = await setStepRunning(projectId, 'select-clips');
  if (!started) return NextResponse.json({ ok: true, step: 'select-clips', status: 'already-running' });

  runSelectClips(projectId, clipLength, apiKey).catch(async (err) => {
    await setStepError(projectId, err.message);
    await logStep(projectId, 'select-clips', 'error', err.message);
  });

  return NextResponse.json({ ok: true, step: 'select-clips', status: 'started' });
}

async function runSelectClips(projectId: string, clipLength: string, apiKey: string) {
  await logStep(projectId, 'select-clips', 'active', 'Selecting clips...');

  // Load segments from latest analysis
  const analysisRes = await pool.query(
    `SELECT id, segments FROM clipping_analyses WHERE project_id = $1 AND status = 'done' ORDER BY created_at DESC LIMIT 1`,
    [projectId]
  );
  const segments: VideoSegment[] = analysisRes.rows[0].segments;

  // Delete any existing clips for re-runs
  await pool.query(`DELETE FROM clipping_clips WHERE project_id = $1`, [projectId]);

  const selection = await selectClips(segments, apiKey, { clipLength });

  // Insert clip records
  for (const c of selection.clips) {
    await pool.query(
      `INSERT INTO clipping_clips (project_id, analysis_id, title, description, score, start_sec, end_sec, duration_sec, transcript, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
      [projectId, analysisRes.rows[0].id, c.title, c.description, c.score, c.start, c.end, c.end - c.start, c.transcript]
    );
  }

  await setStepDone(projectId);
  await logStep(projectId, 'select-clips', 'done', `Selected ${selection.clips.length} clips`, {
    clipCount: selection.clips.length, tokensIn: selection.tokens_in, tokensOut: selection.tokens_out,
  });
}

export const maxDuration = 300;
