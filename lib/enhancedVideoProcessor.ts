import { updateJob } from '@/lib/videoQueue';
import { generateKenBurnsPan, PanAnimation } from './kenBurnsPan';
import { CompositionResult } from './storyboardCompositor';

// Enhanced video processor that integrates composed pages with Ken Burns panning
export interface RenderRequest {
  jobId: string;
  zipBuffer: Buffer;
  composedPages?: CompositionResult[];
  panAnimations?: PanAnimation[];
  useKenBurns?: boolean;
}

export interface SceneData {
  scene_id: number;
  text: string;
  duration?: number;
}

// File-based progress tracking for serverless environment
async function updateProgress(jobId: string, progress: number, status: string, tempDir: string) {
  const { writeFile } = await import('fs/promises');
  const { join } = await import('path');

  const progressData = {
    jobId,
    progress,
    status,
    updatedAt: new Date().toISOString()
  };

  try {
    // Write to temp directory file for immediate access
    const progressFile = join(tempDir, 'progress.json');
    await writeFile(progressFile, JSON.stringify(progressData));
    console.log(`📁 Progress written to file: ${status} (${progress}%)`);
  } catch (error) {
    console.error(`❌ Failed to write progress file:`, error);
  }

  // Also try Redis (may fail silently)
  try {
    await updateJob(jobId, { status: status as 'pending' | 'processing' | 'completed' | 'failed', progress });
  } catch (error) {
    console.log(`⚠️ Redis update failed (using file fallback):`, error);
  }
}

/**
 * Build FFmpeg filter for Ken Burns pan animation
 */
function buildKenBurnsFilter(panAnimation: PanAnimation, width: number = 1080, height: number = 1920): string {
  const { keyframes, durationMs, ease } = panAnimation;

  if (keyframes.length < 2) {
    // Fallback to static if no valid keyframes
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  }

  const startFrame = keyframes[0];
  const endFrame = keyframes[keyframes.length - 1];

  // Calculate zoom levels based on crop rectangles
  const startZoom = Math.max(width / startFrame.rect.w, height / startFrame.rect.h);
  const endZoom = Math.max(width / endFrame.rect.w, height / endFrame.rect.h);

  // Calculate pan positions (as percentages of image dimensions)
  const startX = startFrame.rect.x + startFrame.rect.w / 2;
  const startY = startFrame.rect.y + startFrame.rect.h / 2;
  const endX = endFrame.rect.x + endFrame.rect.w / 2;
  const endY = endFrame.rect.y + endFrame.rect.h / 2;

  // Convert duration to frame count (assuming 25fps)
  const totalFrames = Math.ceil((durationMs / 1000) * 25);

  // Build zoompan filter with easing
  let easingExpression = 't';
  if (ease === 'ease-in') {
    easingExpression = 't*t';
  } else if (ease === 'ease-out') {
    easingExpression = '1-(1-t)*(1-t)';
  } else if (ease === 'ease-in-out') {
    easingExpression = 't<0.5 ? 2*t*t : 1-2*(1-t)*(1-t)';
  } else if (ease === 'inOutSine') {
    easingExpression = '0.5*(1-cos(PI*t))';
  }

  // Zoom interpolation expression
  const zoomExpr = `${startZoom}+(${endZoom}-${startZoom})*${easingExpression}`;

  // Pan position interpolation expressions
  const xExpr = `(${startX}+(${endX}-${startX})*${easingExpression})/iw*ow-ow/2`;
  const yExpr = `(${startY}+(${endY}-${startY})*${easingExpression})/ih*oh-oh/2`;

  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    `zoompan=z='${zoomExpr}':d=${totalFrames}:x='${xExpr}':y='${yExpr}':s=${width}x${height}`
  ].join(',');
}

/**
 * Process composed pages with Ken Burns animations
 */
async function processComposedPages(
  tempDir: string,
  composedPages: CompositionResult[],
  panAnimations: PanAnimation[],
  sceneData: SceneData[]
): Promise<string[]> {
  const { join } = await import('path');
  const { writeFile } = await import('fs/promises');
  const { exec } = await import('child_process');
  const { promisify } = await import('util');

  const execAsync = promisify(exec);
  const segmentPaths: string[] = [];

  for (let i = 0; i < composedPages.length; i++) {
    const page = composedPages[i];
    const panAnimation = panAnimations[i];
    const scene = sceneData.find(s => s.scene_id === page.pageIndex + 1);

    if (!scene) continue;

    const composedImagePath = join(tempDir, `composed-page-${i}.png`);
    const voiceFile = `scene-${scene.scene_id}.wav`;
    const audioPath = join(tempDir, voiceFile);
    const segmentOutput = join(tempDir, `segment-${i}.mp4`);

    // Save composed page as PNG
    const pageBuffer = Buffer.from(page.composedImageBase64 || '', 'base64');
    await writeFile(composedImagePath, pageBuffer);

    // Get audio duration
    let duration = panAnimation.durationMs / 1000;
    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
      );
      duration = parseFloat(stdout.trim());
    } catch {
      console.warn(`⚠️ Could not get duration for ${voiceFile}, using pan duration`);
    }

    // Build Ken Burns filter
    const kenBurnsFilter = buildKenBurnsFilter(panAnimation, 1080, 1920);

    // Create video segment with Ken Burns effect
    const ffmpegCmd = [
      'ffmpeg -y',
      '-loop 1',
      `-i "${composedImagePath}"`,
      `-i "${audioPath}"`,
      `-t ${duration}`,
      `-vf "${kenBurnsFilter}"`,
      '-c:v libx264',
      '-pix_fmt yuv420p',
      '-c:a aac -b:a 192k -ar 44100',
      '-shortest',
      `"${segmentOutput}"`
    ].join(' ');

    console.log(`🎬 Creating Ken Burns segment ${i} (${duration.toFixed(2)}s)...`);
    await execAsync(ffmpegCmd);
    segmentPaths.push(segmentOutput);
  }

  return segmentPaths;
}

/**
 * Enhanced video processor with Ken Burns integration
 */
export async function processEnhancedVideo({
  jobId,
  zipBuffer,
  composedPages,
  panAnimations,
  useKenBurns = true
}: RenderRequest) {
  const JSZip = (await import('jszip')).default;
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const { writeFile, mkdir, rm } = await import('fs/promises');
  const { join } = await import('path');
  const { tmpdir } = await import('os');

  const execAsync = promisify(exec);
  let tempDir: string | null = null;

  try {
    // Create temporary directory first
    tempDir = join(tmpdir(), `enhanced-video-render-${jobId}`);
    await mkdir(tempDir, { recursive: true });

    await updateProgress(jobId, 10, 'processing', tempDir);
    console.log(`🎬 [${jobId}] Starting enhanced video processing...`);
    console.log(`📁 [${jobId}] Created temp directory:`, tempDir);

    // Extract ZIP
    await updateProgress(jobId, 20, 'processing', tempDir);
    const zip = await JSZip.loadAsync(zipBuffer);

    // Parse metadata and storyboard
    const metadataFile = zip.file('project-metadata.json');
    const storyboardFile = zip.file('storyboard.json');

    if (!metadataFile || !storyboardFile) {
      throw new Error('Invalid project ZIP: missing metadata or storyboard');
    }

    const metadata = JSON.parse(await metadataFile.async('text'));
    const storyboard: SceneData[] = JSON.parse(await storyboardFile.async('text'));

    console.log(`📋 [${jobId}] Project:`, metadata.title);
    console.log(`🎬 [${jobId}] Scenes:`, storyboard.length);

    // Extract voiceovers
    await updateProgress(jobId, 30, 'processing', tempDir);
    const voiceFiles = Object.keys(zip.files).filter(name => name.startsWith('voiceovers/scene-'));

    console.log(`🎤 [${jobId}] Extracting ${voiceFiles.length} voiceovers...`);
    for (const voicePath of voiceFiles) {
      const file = zip.file(voicePath);
      if (file) {
        const voiceData = await file.async('nodebuffer');
        const filename = voicePath.replace('voiceovers/', '');
        await writeFile(join(tempDir, filename), voiceData);
      }
    }

    // Check FFmpeg
    await updateProgress(jobId, 35, 'processing', tempDir);
    try {
      await execAsync('ffmpeg -version');
      console.log(`✅ [${jobId}] FFmpeg is available`);
    } catch {
      throw new Error('FFmpeg is not installed on the server');
    }

    let segmentPaths: string[] = [];

    if (useKenBurns && composedPages && panAnimations) {
      // Use enhanced Ken Burns processing
      await updateProgress(jobId, 40, 'processing', tempDir);
      console.log(`🎥 [${jobId}] Processing with Ken Burns effects...`);

      segmentPaths = await processComposedPages(tempDir, composedPages, panAnimations, storyboard);

      await updateProgress(jobId, 70, 'processing', tempDir);
    } else {
      // Fallback to original processing
      await updateProgress(jobId, 40, 'processing', tempDir);
      console.log(`🎥 [${jobId}] Processing with standard zoom effects...`);

      // Extract images
      const imageFiles = Object.keys(zip.files).filter(name => name.startsWith('images/scene-'));

      console.log(`🖼️ [${jobId}] Extracting ${imageFiles.length} images...`);
      for (const imagePath of imageFiles) {
        const file = zip.file(imagePath);
        if (file) {
          const imageData = await file.async('nodebuffer');
          const filename = imagePath.replace('images/', '');
          await writeFile(join(tempDir, filename), imageData);
        }
      }

      // Build video segments with standard processing
      const concatList: string[] = [];
      const totalScenes = storyboard.length;

      for (let i = 0; i < totalScenes; i++) {
        const sceneId = storyboard[i].scene_id;
        const voiceFile = `scene-${sceneId}.wav`;
        const audioPath = join(tempDir, voiceFile);

        // Find images for this scene
        const sceneImages = imageFiles
          .filter(img => img.includes(`scene-${sceneId}_`) || img.includes(`scene-${sceneId}.`))
          .map(img => img.replace('images/', ''));

        if (sceneImages.length === 0) continue;

        // Get audio duration
        let duration = 2;
        try {
          const { stdout } = await execAsync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
          );
          duration = parseFloat(stdout.trim());
        } catch {
          console.warn(`⚠️ [${jobId}] Could not get duration for ${voiceFile}`);
        }

        const durationPerImage = duration / sceneImages.length;

        // Create segments with standard zoom effect
        for (let imgIdx = 0; imgIdx < sceneImages.length; imgIdx++) {
          const imageFile = sceneImages[imgIdx];
          const segmentOutput = join(tempDir, `segment-${sceneId}-${imgIdx}.mp4`);

          // Calculate audio slice timing for this image
          const audioStartTime = imgIdx * durationPerImage;

          const ffmpegCmd = [
            'ffmpeg -y',
            '-loop 1',
            `-i "${join(tempDir, imageFile)}"`,
            `-ss ${audioStartTime}`,
            `-i "${audioPath}"`,
            `-t ${durationPerImage}`,
            '-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,zoompan=z=\'min(zoom+0.0015,1.1)\':d=125:x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':s=1080x1920"',
            '-c:v libx264',
            '-pix_fmt yuv420p',
            '-c:a aac -b:a 192k -ar 44100',
            '-shortest',
            `"${segmentOutput}"`
          ].join(' ');

          console.log(`🎬 [${jobId}] Creating standard segment ${sceneId}-${imgIdx}...`);
          await execAsync(ffmpegCmd);
          segmentPaths.push(segmentOutput);
        }

        // Update progress (40-70% range for video processing)
        const progressPercent = 40 + Math.floor(((i + 1) / totalScenes) * 30);
        await updateProgress(jobId, progressPercent, 'processing', tempDir);
      }
    }

    // Concatenate segments
    await updateProgress(jobId, 80, 'processing', tempDir);
    const concatListPath = join(tempDir, 'concat.txt');
    const concatList = segmentPaths.map(path => `file '${path}'`);
    await writeFile(concatListPath, concatList.join('\n'));
    console.log(`📝 [${jobId}] Created concat list with ${concatList.length} segments`);

    const finalVideoPath = join(tempDir, 'final-video.mp4');
    const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${finalVideoPath}"`;

    console.log(`🎬 [${jobId}] Concatenating segments into final video...`);
    await execAsync(concatCmd);

    // Read video file size for logging
    await updateProgress(jobId, 95, 'processing', tempDir);
    const { statSync } = await import('fs');
    const videoStats = statSync(finalVideoPath);

    console.log(`📹 [${jobId}] Final video size:`, videoStats.size, 'bytes');
    console.log(`📁 [${jobId}] Video file available at: ${finalVideoPath}`);

    // Mark job as complete
    await updateProgress(jobId, 100, 'completed', tempDir);
    console.log(`✅ [${jobId}] Enhanced video rendering complete!`);

    // Clean up after 10 minutes to save disk space
    setTimeout(async () => {
      try {
        if (tempDir) {
          await rm(tempDir, { recursive: true, force: true });
          console.log(`🧹 [${jobId}] Cleaned up temp directory after 10 minutes`);
        }
      } catch (cleanupError) {
        console.error(`❌ [${jobId}] Cleanup error:`, cleanupError);
      }
    }, 10 * 60 * 1000); // 10 minutes

  } catch (error) {
    console.error(`❌ [${jobId}] Enhanced video rendering error:`, error);

    // Clean up on error
    if (tempDir) {
      try {
        const { rm } = await import('fs/promises');
        await rm(tempDir, { recursive: true, force: true });
      } catch {}
    }

    await updateProgress(jobId, 0, 'failed', tempDir || '/tmp');
    throw error;
  }
}

// Backward compatibility export
export { processVideoInBackground } from './videoProcessor';