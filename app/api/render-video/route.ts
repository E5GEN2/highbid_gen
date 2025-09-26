import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createJob, updateJob } from '@/lib/videoQueue';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const zipFile = formData.get('projectZip') as File;

    if (!zipFile) {
      return NextResponse.json(
        { error: 'Project ZIP file is required' },
        { status: 400 }
      );
    }

    console.log('📦 Received project ZIP:', zipFile.name, 'Size:', zipFile.size);

    // Create a job ID
    const jobId = randomBytes(16).toString('hex');

    // Convert ZIP to buffer immediately (this is fast)
    const zipBuffer = Buffer.from(await zipFile.arrayBuffer());

    // Create job in queue
    try {
      const job = await createJob(jobId);
      console.log('✅ Created render job:', jobId);
    } catch (redisError) {
      console.error('❌ Redis job creation failed:', redisError);
      return NextResponse.json(
        { error: 'Failed to create job in queue', details: redisError instanceof Error ? redisError.message : 'Unknown Redis error' },
        { status: 500 }
      );
    }

    // Return job ID immediately - process ZIP in background
    setImmediate(async () => {
      try {
        console.log('🔄 Starting background video processing...');
        await processVideoInBackground(jobId, zipBuffer);
      } catch (err) {
        console.error('❌ Background processing error:', err);
        await updateJob(jobId, { status: 'failed', error: err instanceof Error ? err.message : 'Unknown error' });
      }
    });

    return NextResponse.json({
      success: true,
      jobId,
      message: 'Video rendering started',
      status: job.status
    });

  } catch (error) {
    console.error('❌ Video rendering error:', error);
    return NextResponse.json(
      {
        error: 'Failed to start video rendering',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

// Background processing function
async function processVideoInBackground(jobId: string, zipBuffer: Buffer) {
  const { updateJob } = await import('@/lib/videoQueue');
  const JSZip = (await import('jszip')).default;
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const { writeFile, mkdir, rm } = await import('fs/promises');
  const { join } = await import('path');
  const { tmpdir } = await import('os');

  const execAsync = promisify(exec);
  let tempDir: string | null = null;

  try {
    updateJob(jobId, { status: 'processing', progress: 10 });
    console.log(`🎬 [${jobId}] Starting video processing...`);

    // Create temporary directory
    tempDir = join(tmpdir(), `video-render-${jobId}`);
    await mkdir(tempDir, { recursive: true });
    console.log(`📁 [${jobId}] Created temp directory:`, tempDir);

    // Extract ZIP
    updateJob(jobId, { progress: 20 });
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
    updateJob(jobId, { progress: 30 });
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

    updateJob(jobId, { progress: 40 });
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
    updateJob(jobId, { progress: 45 });
    try {
      await execAsync('ffmpeg -version');
      console.log(`✅ [${jobId}] FFmpeg is available`);
    } catch {
      throw new Error('FFmpeg is not installed on the server');
    }

    // Build video segments
    updateJob(jobId, { progress: 50 });
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
      updateJob(jobId, { progress: progressPercent });
    }

    // Concatenate segments
    updateJob(jobId, { progress: 85 });
    const concatListPath = join(tempDir, 'concat.txt');
    await writeFile(concatListPath, concatList.join('\n'));
    console.log(`📝 [${jobId}] Created concat list with ${concatList.length} segments`);

    const finalVideoPath = join(tempDir, 'final-video.mp4');
    const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${finalVideoPath}"`;

    console.log(`🎬 [${jobId}] Concatenating segments into final video...`);
    await execAsync(concatCmd);

    // Read and encode video
    updateJob(jobId, { progress: 95 });
    const { readFileSync } = await import('fs');
    const videoBuffer = readFileSync(finalVideoPath);
    const videoBase64 = `data:video/mp4;base64,${videoBuffer.toString('base64')}`;

    console.log(`📹 [${jobId}] Final video size:`, videoBuffer.length, 'bytes');

    // Clean up
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }

    // Mark job as complete
    updateJob(jobId, {
      status: 'completed',
      progress: 100,
      videoUrl: videoBase64
    });

    console.log(`✅ [${jobId}] Video rendering complete!`);

  } catch (error) {
    console.error(`❌ [${jobId}] Video rendering error:`, error);

    // Clean up on error
    if (tempDir) {
      try {
        const { rm } = await import('fs/promises');
        await rm(tempDir, { recursive: true, force: true });
      } catch {}
    }

    updateJob(jobId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}