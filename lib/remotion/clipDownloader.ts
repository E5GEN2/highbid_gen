import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { getCachedClip, getCachePath, getThumbnailFallback, evictIfNeeded } from './clipCache';

const execFileAsync = promisify(execFile);

interface ClipResult {
  filePath: string;
  isVideo: boolean;
}

export async function downloadClip(
  videoId: string,
  maxDuration = 4
): Promise<ClipResult> {
  // Check cache first
  const cached = getCachedClip(videoId);
  if (cached) {
    return { filePath: cached, isVideo: true };
  }

  const outputPath = getCachePath(videoId);
  const tempPath = outputPath + '.tmp.mp4';

  try {
    // Download with yt-dlp
    await execFileAsync('yt-dlp', [
      '-f', 'best[height<=1080][ext=mp4]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '-o', tempPath,
      `https://youtube.com/shorts/${videoId}`,
    ], { timeout: 30000 });

    // Trim to first N seconds with ffmpeg
    if (fs.existsSync(tempPath)) {
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', tempPath,
          '-t', maxDuration.toString(),
          '-c', 'copy',
          '-an', // no audio
          outputPath,
        ], { timeout: 15000 });
        // Clean up temp
        fs.unlinkSync(tempPath);
      } catch {
        // If ffmpeg fails, use the untrimmed version
        if (fs.existsSync(tempPath)) {
          fs.renameSync(tempPath, outputPath);
        }
      }
    }

    if (fs.existsSync(outputPath)) {
      await evictIfNeeded();
      return { filePath: outputPath, isVideo: true };
    }
  } catch (err) {
    console.warn(`yt-dlp download failed for ${videoId}:`, err);
    // Clean up any partial downloads
    for (const p of [tempPath, outputPath]) {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }

  // Fallback to thumbnail
  return { filePath: getThumbnailFallback(videoId), isVideo: false };
}

export async function downloadClipsForChannels(
  channelVideoMap: Record<string, string[]>,
  clipsPerChannel = 3,
  maxConcurrent = 3,
  onProgress?: (done: number, total: number) => void,
): Promise<Record<string, ClipResult[]>> {
  const results: Record<string, ClipResult[]> = {};
  const tasks: { channelId: string; videoId: string }[] = [];

  for (const [channelId, videoIds] of Object.entries(channelVideoMap)) {
    results[channelId] = [];
    for (const vid of videoIds.slice(0, clipsPerChannel)) {
      tasks.push({ channelId, videoId: vid });
    }
  }

  let done = 0;
  const total = tasks.length;

  // Process in batches
  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    const batch = tasks.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(
      batch.map(async ({ channelId, videoId }) => {
        const result = await downloadClip(videoId);
        done++;
        onProgress?.(done, total);
        return { channelId, result };
      })
    );

    for (const { channelId, result } of batchResults) {
      results[channelId].push(result);
    }
  }

  return results;
}
