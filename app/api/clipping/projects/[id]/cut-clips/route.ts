import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { validateProject, setStepRunning, setStepProgress, setStepDone, setStepError, logStep } from '@/lib/clipping-pipeline';
import { cutClip } from '@/lib/clip-cutter';

/**
 * POST /api/clipping/projects/{id}/cut-clips
 * ffmpeg cuts clips from source video. Fire-and-forget.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const validation = await validateProject(req, projectId, { sourceVideo: true, clips: true });
  if (validation instanceof NextResponse) return validation;
  const { project } = validation;

  const started = await setStepRunning(projectId, 'cut-clips', { completed: 0, total: 0 });
  if (!started) return NextResponse.json({ ok: true, step: 'cut-clips', status: 'already-running' });

  runCutClips(projectId, project.source_path as string).catch(async (err) => {
    await setStepError(projectId, err.message);
    await logStep(projectId, 'cut-clips', 'error', err.message);
  });

  return NextResponse.json({ ok: true, step: 'cut-clips', status: 'started' });
}

async function runCutClips(projectId: string, sourcePath: string) {
  // Load pending clips
  const clipsRes = await pool.query(
    `SELECT id, title, start_sec, end_sec FROM clipping_clips WHERE project_id = $1 AND status IN ('pending', 'error') ORDER BY start_sec`,
    [projectId]
  );
  const clips = clipsRes.rows;
  await logStep(projectId, 'cut-clips', 'active', `Cutting ${clips.length} clips...`);
  await setStepProgress(projectId, { completed: 0, total: clips.length });

  let completed = 0;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    try {
      await pool.query(`UPDATE clipping_clips SET status = 'cutting' WHERE id = $1`, [clip.id]);

      const result = await cutClip({
        sourceVideoPath: sourcePath,
        projectId,
        clipId: `clip_${i + 1}`,
        startSec: clip.start_sec,
        endSec: clip.end_sec,
      });

      await pool.query(
        `UPDATE clipping_clips SET status = 'done', file_path = $1, thumbnail_path = $2, file_size_bytes = $3 WHERE id = $4`,
        [result.filePath, result.thumbnailPath, result.fileSizeBytes, clip.id]
      );

      completed++;
      await setStepProgress(projectId, { completed, total: clips.length });
      await logStep(projectId, 'cut-clip', 'done', `Cut clip ${i + 1}/${clips.length}: ${clip.title}`);
    } catch (err) {
      await pool.query(`UPDATE clipping_clips SET status = 'error' WHERE id = $1`, [clip.id]);
      await logStep(projectId, 'cut-clip', 'error', `Clip ${i + 1} failed: ${err instanceof Error ? err.message : ''}`);
    }
  }

  await setStepDone(projectId, { status: 'done' });
  await logStep(projectId, 'cut-clips', 'done', `Cut ${completed}/${clips.length} clips`);
}

export const maxDuration = 600;
