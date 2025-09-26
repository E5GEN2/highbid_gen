import { updateJob } from '@/lib/videoQueue';

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

export async function processVideoInBackground(jobId: string, zipBuffer: Buffer) {
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
    tempDir = join(tmpdir(), `video-render-${jobId}`);
    await mkdir(tempDir, { recursive: true });

    await updateProgress(jobId, 10, 'processing', tempDir);
    console.log(`🎬 [${jobId}] Starting video processing...`);
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
    const storyboard = JSON.parse(await storyboardFile.async('text'));

    console.log(`📋 [${jobId}] Project:`, metadata.title);
    console.log(`🎬 [${jobId}] Scenes:`, storyboard.length);

    // Extract images and voiceovers
    await updateProgress(jobId, 30, 'processing', tempDir);
    const imageFiles = Object.keys(zip.files).filter(name => name.startsWith('images/scene-'));
    const voiceFiles = Object.keys(zip.files).filter(name => name.startsWith('voiceovers/scene-'));

    console.log(`🖼️  [${jobId}] Extracting ${imageFiles.length} images...`);
    for (const imagePath of imageFiles) {
      const file = zip.file(imagePath);
      if (file) {
        const imageData = await file.async('nodebuffer');
        const filename = imagePath.replace('images/', '');
        await writeFile(join(tempDir, filename), imageData);
      }
    }

    await updateProgress(jobId, 40, 'processing', tempDir);
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
    await updateProgress(jobId, 45, 'processing', tempDir);
    try {
      await execAsync('ffmpeg -version');
      console.log(`✅ [${jobId}] FFmpeg is available`);
    } catch {
      throw new Error('FFmpeg is not installed on the server');
    }

    // Build video segments
    await updateProgress(jobId, 50, 'processing', tempDir);
    console.log(`🎥 [${jobId}] Building video with FFmpeg...`);

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
        console.warn(`⚠️  [${jobId}] Could not get duration for ${voiceFile}`);
      }

      const durationPerImage = duration / sceneImages.length;

      // Create segments
      for (let imgIdx = 0; imgIdx < sceneImages.length; imgIdx++) {
        const imageFile = sceneImages[imgIdx];
        const segmentOutput = join(tempDir, `segment-${sceneId}-${imgIdx}.mp4`);

        const ffmpegCmd = [
          'ffmpeg -y',
          '-loop 1',
          `-i "${join(tempDir, imageFile)}"`,
          `-i "${audioPath}"`,
          `-t ${durationPerImage}`,
          '-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,zoompan=z=\'min(zoom+0.0015,1.1)\':d=125:x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':s=1080x1920"',
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-c:a aac',
          '-shortest',
          `"${segmentOutput}"`
        ].join(' ');

        console.log(`🎬 [${jobId}] Creating segment ${sceneId}-${imgIdx}...`);
        await execAsync(ffmpegCmd);
        concatList.push(`file '${segmentOutput}'`);
      }

      // Update progress (50-80% range for video processing)
      const progressPercent = 50 + Math.floor(((i + 1) / totalScenes) * 30);
      await updateProgress(jobId, progressPercent, 'processing', tempDir);
    }

    // Concatenate segments
    await updateProgress(jobId, 85, 'processing', tempDir);
    const concatListPath = join(tempDir, 'concat.txt');
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

    // Don't clean up immediately - leave video file for retrieval
    console.log(`📁 [${jobId}] Video file available at: ${finalVideoPath}`);

    // Mark job as complete
    await updateProgress(jobId, 100, 'completed', tempDir);

    console.log(`✅ [${jobId}] Video rendering complete!`);

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
    console.error(`❌ [${jobId}] Video rendering error:`, error);

    // Clean up on error
    if (tempDir) {
      try {
        const { rm } = await import('fs/promises');
        await rm(tempDir, { recursive: true, force: true });
      } catch {}
    }

    await updateProgress(jobId, 0, 'failed', tempDir || '/tmp');
  }
}