import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { pool } from '@/lib/db';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const CLIPS_DIR = '/tmp/clips';

/**
 * POST /api/clipping/detect-faces
 * Run face detection on a clip or the full source video.
 * Body: { projectId, clipId?, start?, end?, fps? }
 *
 * If clipId is provided, runs on that clip's time range.
 * Otherwise runs on the full source (or start/end range).
 * Results stored in clipping_face_data table.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { projectId, clipId, start, end, fps = 5 } = await req.json();
  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 });
  }

  // Get source video path
  const analysis = await pool.query(
    `SELECT video_url FROM clipping_analyses
     WHERE project_id = $1 AND status = 'done'
     ORDER BY created_at DESC LIMIT 1`,
    [projectId]
  );
  if (analysis.rows.length === 0) {
    return NextResponse.json({ error: 'No completed analysis found' }, { status: 400 });
  }

  let videoUrl = analysis.rows[0].video_url;
  let videoPath: string;

  if (videoUrl.startsWith('file://')) {
    videoPath = videoUrl.replace('file://', '');
  } else {
    // Check if source exists in clips dir
    const possiblePaths = [
      path.join(CLIPS_DIR, projectId, 'source.mp4'),
      path.join(CLIPS_DIR, projectId, 'source.mov'),
    ];
    videoPath = possiblePaths.find(p => fs.existsSync(p)) || '';
    if (!videoPath) {
      return NextResponse.json({ error: 'Source video not found on disk' }, { status: 400 });
    }
  }

  if (!fs.existsSync(videoPath)) {
    return NextResponse.json({ error: `Video file not found: ${videoPath}` }, { status: 400 });
  }

  // Determine time range
  let startSec = start ?? 0;
  let endSec = end;

  if (clipId) {
    const clip = await pool.query(
      `SELECT start_sec, end_sec FROM clipping_clips WHERE id = $1 AND project_id = $2`,
      [clipId, projectId]
    );
    if (clip.rows.length > 0) {
      startSec = clip.rows[0].start_sec;
      endSec = clip.rows[0].end_sec;
    }
  }

  try {
    // Run face detection
    const args = [
      path.join(SCRIPTS_DIR, 'detect-faces.py'),
      videoPath,
      '--fps', String(fps),
      '--start', String(startSec),
    ];
    if (endSec != null) {
      args.push('--end', String(endSec));
    }

    const { stdout, stderr } = await execFileAsync('python3', args, {
      timeout: 300000, // 5 min
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });

    if (stderr) {
      console.log('[face-detect] stderr:', stderr.substring(0, 500));
    }

    const result = JSON.parse(stdout);

    // Store in DB
    await pool.query(
      `INSERT INTO clipping_face_data (project_id, clip_id, start_sec, end_sec, fps_sampled, total_frames, video_width, video_height, frames)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (project_id, COALESCE(clip_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET start_sec=$3, end_sec=$4, fps_sampled=$5, total_frames=$6, video_width=$7, video_height=$8, frames=$9, created_at=NOW()`,
      [
        projectId,
        clipId || null,
        startSec,
        endSec || result.end_sec,
        fps,
        result.total_frames,
        result.video_width,
        result.video_height,
        JSON.stringify(result.frames),
      ]
    );

    // Log
    await pool.query(
      `INSERT INTO clipping_logs (project_id, step, status, message, data)
       VALUES ($1, 'face_detect', 'done', $2, $3)`,
      [
        projectId,
        `Face detection: ${result.total_frames} frames, ${result.frames.filter((f: { faces: unknown[] }) => f.faces.length > 0).length} with faces`,
        JSON.stringify({
          clipId,
          startSec,
          endSec: endSec || result.end_sec,
          totalFrames: result.total_frames,
          framesWithFaces: result.frames.filter((f: { faces: unknown[] }) => f.faces.length > 0).length,
          videoWidth: result.video_width,
          videoHeight: result.video_height,
        }),
      ]
    );

    return NextResponse.json({
      ...result,
      stored: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Face detection failed';
    console.error('[face-detect] Error:', msg);

    await pool.query(
      `INSERT INTO clipping_logs (project_id, step, status, message)
       VALUES ($1, 'face_detect', 'error', $2)`,
      [projectId, msg]
    );

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * GET /api/clipping/detect-faces?projectId=xxx[&clipId=yyy]
 * Get stored face detection data.
 */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId');
  const clipId = req.nextUrl.searchParams.get('clipId');

  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 });
  }

  let result;
  if (clipId) {
    result = await pool.query(
      `SELECT * FROM clipping_face_data WHERE project_id = $1 AND clip_id = $2`,
      [projectId, clipId]
    );
  } else {
    result = await pool.query(
      `SELECT * FROM clipping_face_data WHERE project_id = $1 AND clip_id IS NULL`,
      [projectId]
    );
  }

  return NextResponse.json({ faceData: result.rows[0] || null });
}

export const maxDuration = 300;
