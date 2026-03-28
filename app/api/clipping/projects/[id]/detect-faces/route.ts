import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { validateProject, setStepRunning, setStepProgress, setStepDone, setStepError, logStep } from '@/lib/clipping-pipeline';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

/**
 * POST /api/clipping/projects/{id}/detect-faces
 * Run YuNet face detection on source video. Fire-and-forget.
 * Body: { fps? } (default 5)
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const validation = await validateProject(req, projectId, { sourceVideo: true });
  if (validation instanceof NextResponse) return validation;
  const { project } = validation;

  const body = await req.json().catch(() => ({}));
  const fps = body.fps || 5;

  const started = await setStepRunning(projectId, 'detect-faces', { percent: 0 });
  if (!started) return NextResponse.json({ ok: true, step: 'detect-faces', status: 'already-running' });

  runFaceDetection(projectId, project.source_path as string, fps).catch(async (err) => {
    await setStepError(projectId, err.message);
    await logStep(projectId, 'detect-faces', 'error', err.message);
  });

  return NextResponse.json({ ok: true, step: 'detect-faces', status: 'started' });
}

async function runFaceDetection(projectId: string, sourcePath: string, fps: number) {
  await logStep(projectId, 'detect-faces', 'active', 'Running face detection...');

  const { stdout, stderr } = await execFileAsync('python3', [
    path.join(SCRIPTS_DIR, 'detect-faces.py'),
    sourcePath,
    '--fps', String(fps),
    '--confidence', '0.6',
  ], { timeout: 600000, maxBuffer: 100 * 1024 * 1024 });

  if (stderr) console.log('[face-detect]', stderr.substring(0, 300));

  const result = JSON.parse(stdout);

  // Store in DB
  await pool.query(
    `INSERT INTO clipping_face_data (project_id, start_sec, end_sec, fps_sampled, total_frames, video_width, video_height, frames)
     VALUES ($1, 0, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [projectId, result.end_sec, fps, result.total_frames, result.video_width, result.video_height, JSON.stringify(result.frames)]
  );

  const framesWithFaces = result.frames.filter((f: { faces: unknown[] }) => f.faces.length > 0).length;
  await setStepDone(projectId);
  await logStep(projectId, 'detect-faces', 'done', `${result.total_frames} frames, ${framesWithFaces} with faces`, {
    totalFrames: result.total_frames, framesWithFaces, videoWidth: result.video_width, videoHeight: result.video_height,
  });
}

export const maxDuration = 600;
