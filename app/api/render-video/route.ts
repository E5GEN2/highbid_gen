import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

const execAsync = promisify(exec);

export async function POST(request: NextRequest) {
  let tempDir: string | null = null;

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

    // Create temporary directory for processing
    const tempId = randomBytes(16).toString('hex');
    tempDir = join(tmpdir(), `video-render-${tempId}`);
    await mkdir(tempDir, { recursive: true });
    console.log('📁 Created temp directory:', tempDir);

    // Extract ZIP file
    console.log('📂 Extracting ZIP file...');
    const zipBuffer = Buffer.from(await zipFile.arrayBuffer());
    const zip = await JSZip.loadAsync(zipBuffer);

    // Parse project metadata
    const metadataFile = zip.file('project-metadata.json');
    const storyboardFile = zip.file('storyboard.json');

    if (!metadataFile || !storyboardFile) {
      throw new Error('Invalid project ZIP: missing metadata or storyboard');
    }

    const metadata = JSON.parse(await metadataFile.async('text'));
    const storyboard = JSON.parse(await storyboardFile.async('text'));

    console.log('📋 Project:', metadata.title);
    console.log('🎬 Scenes:', storyboard.length);

    // Extract images and voiceovers
    const imagesFolder = zip.folder('images');
    const voicesFolder = zip.folder('voiceovers');

    if (!imagesFolder || !voicesFolder) {
      throw new Error('Invalid project ZIP: missing images or voiceovers folders');
    }

    // Save images to temp directory
    const imageFiles = Object.keys(zip.files).filter(name => name.startsWith('images/scene-'));
    console.log(`🖼️  Extracting ${imageFiles.length} images...`);

    for (const imagePath of imageFiles) {
      const file = zip.file(imagePath);
      if (file) {
        const imageData = await file.async('nodebuffer');
        const filename = imagePath.replace('images/', '');
        await writeFile(join(tempDir, filename), imageData);
      }
    }

    // Save voiceovers to temp directory
    const voiceFiles = Object.keys(zip.files).filter(name => name.startsWith('voiceovers/scene-'));
    console.log(`🎤 Extracting ${voiceFiles.length} voiceovers...`);

    for (const voicePath of voiceFiles) {
      const file = zip.file(voicePath);
      if (file) {
        const voiceData = await file.async('nodebuffer');
        const filename = voicePath.replace('voiceovers/', '');
        await writeFile(join(tempDir, filename), voiceData);
      }
    }

    // Check if FFmpeg is available
    try {
      await execAsync('ffmpeg -version');
      console.log('✅ FFmpeg is available');
    } catch {
      console.error('❌ FFmpeg not found');
      throw new Error('FFmpeg is not installed. Please install FFmpeg to render videos.');
    }

    // Build FFmpeg command to create video
    console.log('🎥 Building video with FFmpeg...');

    // Create input files list for FFmpeg
    const concatList: string[] = [];

    for (let i = 0; i < storyboard.length; i++) {
      const sceneId = storyboard[i].scene_id;
      const voiceFile = `scene-${sceneId}.wav`;

      // Find all images for this scene
      const sceneImages = imageFiles
        .filter(img => img.includes(`scene-${sceneId}_`) || img.includes(`scene-${sceneId}.`))
        .map(img => img.replace('images/', ''));

      if (sceneImages.length === 0) {
        console.warn(`⚠️  No images found for scene ${sceneId}`);
        continue;
      }

      // Get audio duration for this scene
      const audioPath = join(tempDir, voiceFile);
      let duration = 2; // Default 2 seconds

      try {
        const { stdout } = await execAsync(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
        );
        duration = parseFloat(stdout.trim());
        console.log(`⏱️  Scene ${sceneId} duration: ${duration}s`);
      } catch {
        console.warn(`⚠️  Could not get duration for ${voiceFile}, using default`);
      }

      // Calculate duration per image
      const durationPerImage = duration / sceneImages.length;

      // Create video segment for each image with audio
      for (let imgIdx = 0; imgIdx < sceneImages.length; imgIdx++) {
        const imageFile = sceneImages[imgIdx];
        const segmentOutput = join(tempDir, `segment-${sceneId}-${imgIdx}.mp4`);

        // Create video from image with pan/zoom effect
        const ffmpegCmd = [
          'ffmpeg',
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

        console.log(`🎬 Creating segment ${sceneId}-${imgIdx}...`);
        await execAsync(ffmpegCmd);

        concatList.push(`file '${segmentOutput}'`);
      }
    }

    // Write concat list file
    const concatListPath = join(tempDir, 'concat.txt');
    await writeFile(concatListPath, concatList.join('\n'));
    console.log('📝 Created concat list with', concatList.length, 'segments');

    // Concatenate all segments into final video
    const finalVideoPath = join(tempDir, 'final-video.mp4');
    const concatCmd = `ffmpeg -f concat -safe 0 -i "${concatListPath}" -c copy "${finalVideoPath}"`;

    console.log('🎬 Concatenating segments into final video...');
    await execAsync(concatCmd);
    console.log('✅ Video rendering complete!');

    // Read the final video and convert to base64
    const { readFileSync } = await import('fs');
    const videoBuffer = readFileSync(finalVideoPath);
    const videoBase64 = `data:video/mp4;base64,${videoBuffer.toString('base64')}`;

    console.log('📹 Final video size:', videoBuffer.length, 'bytes');

    // Clean up temp directory
    console.log('🧹 Cleaning up temporary files...');
    await rm(tempDir, { recursive: true, force: true });

    return NextResponse.json({
      success: true,
      message: 'Video rendered successfully',
      video: {
        videoUrl: videoBase64,
        duration: storyboard.length * 2,
        scenes: storyboard.length,
        resolution: '1080x1920',
        format: 'mp4',
        metadata: {
          title: metadata.title,
          createdAt: new Date().toISOString(),
          renderEngine: 'FFmpeg Video Processor'
        }
      }
    });

  } catch (error) {
    console.error('❌ Video rendering error:', error);

    // Clean up on error
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('Failed to cleanup temp directory:', cleanupError);
      }
    }

    return NextResponse.json(
      {
        error: 'Failed to render video',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}