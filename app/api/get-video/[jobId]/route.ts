import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    console.log(`📹 Looking for video file for job: ${jobId}`);

    // Try to find the video file in temp directory
    const tempDir = join(tmpdir(), `video-render-${jobId}`);
    const videoPath = join(tempDir, 'final-video.mp4');

    try {
      const videoBuffer = await readFile(videoPath);
      console.log(`✅ Found video file: ${videoBuffer.length} bytes`);

      // Return video as base64 data URL
      const videoBase64 = `data:video/mp4;base64,${videoBuffer.toString('base64')}`;

      return NextResponse.json({
        success: true,
        jobId,
        videoUrl: videoBase64,
        size: videoBuffer.length
      });

    } catch (fileError) {
      console.log(`❌ Video file not found for job ${jobId}:`, fileError);

      // Check if processing is still ongoing by looking for temp directory
      try {
        const { access } = await import('fs/promises');
        await access(tempDir);
        return NextResponse.json({
          success: false,
          status: 'processing',
          message: 'Video is still being processed'
        });
      } catch {
        return NextResponse.json({
          success: false,
          status: 'not_found',
          message: 'Video not found - may have been cleaned up or failed to process'
        });
      }
    }

  } catch (error) {
    console.error('❌ Get video error:', error);
    return NextResponse.json(
      {
        error: 'Failed to retrieve video',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}