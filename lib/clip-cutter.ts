/**
 * ffmpeg-based clip cutter — cuts clips from source video and generates thumbnails.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

const CLIPS_DIR = '/tmp/clips';

export interface CutClipOptions {
  sourceVideoPath: string;
  clipId: string;
  projectId: string;
  startSec: number;
  endSec: number;
}

export interface CutClipResult {
  filePath: string;
  thumbnailPath: string;
  fileSizeBytes: number;
  durationSec: number;
}

/**
 * Ensure the clips directory exists for a project.
 */
function ensureDir(projectId: string): string {
  const dir = path.join(CLIPS_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Cut a clip from the source video using ffmpeg.
 * Uses -ss before -i for fast seeking.
 */
export async function cutClip(opts: CutClipOptions): Promise<CutClipResult> {
  const { sourceVideoPath, clipId, projectId, startSec, endSec } = opts;
  const dir = ensureDir(projectId);
  const duration = endSec - startSec;
  const outPath = path.join(dir, `${clipId}.mp4`);
  const thumbPath = path.join(dir, `${clipId}.jpg`);

  // Cut the clip
  await execFileAsync('ffmpeg', [
    '-ss', String(startSec),
    '-i', sourceVideoPath,
    '-t', String(duration),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
    outPath,
  ], { timeout: 120000 });

  // Generate thumbnail (2 seconds into the clip)
  const thumbOffset = Math.min(2, duration / 2);
  try {
    await execFileAsync('ffmpeg', [
      '-ss', String(startSec + thumbOffset),
      '-i', sourceVideoPath,
      '-vframes', '1',
      '-q:v', '5',
      '-y',
      thumbPath,
    ], { timeout: 30000 });
  } catch {
    // Thumbnail failure is non-fatal
    console.warn(`[clip-cutter] Thumbnail generation failed for ${clipId}`);
  }

  const stats = fs.statSync(outPath);

  return {
    filePath: outPath,
    thumbnailPath: fs.existsSync(thumbPath) ? thumbPath : '',
    fileSizeBytes: stats.size,
    durationSec: duration,
  };
}

/**
 * Download a video from URL to a local temp path.
 * Returns the local file path.
 */
export async function downloadVideo(url: string, projectId: string): Promise<string> {
  const dir = ensureDir(projectId);
  const ext = url.includes('.mov') ? '.mov' : '.mp4';
  const localPath = path.join(dir, `source${ext}`);

  // Skip if already downloaded
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer);
  return localPath;
}

/**
 * Clean up clips directory for a project.
 */
export function cleanupProject(projectId: string): void {
  const dir = path.join(CLIPS_DIR, projectId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Get the file path for a clip.
 */
export function getClipPath(projectId: string, clipId: string): string {
  return path.join(CLIPS_DIR, projectId, `${clipId}.mp4`);
}

/**
 * Get the thumbnail path for a clip.
 */
export function getThumbnailPath(projectId: string, clipId: string): string {
  return path.join(CLIPS_DIR, projectId, `${clipId}.jpg`);
}
