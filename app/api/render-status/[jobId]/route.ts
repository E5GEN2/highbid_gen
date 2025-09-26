import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/videoQueue';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    console.log(`🔍 Checking status for job: ${jobId}`);

    // First try to read from progress file (background process)
    try {
      const tempDir = join(tmpdir(), `video-render-${jobId}`);
      const progressFile = join(tempDir, 'progress.json');
      const progressData = await readFile(progressFile, 'utf-8');
      const progress = JSON.parse(progressData);

      console.log(`📁 Read progress from file: ${progress.status} (${progress.progress}%)`);

      // Convert to job format
      const job = {
        id: jobId,
        status: progress.status,
        progress: progress.progress,
        updatedAt: new Date(progress.updatedAt),
        createdAt: new Date(progress.updatedAt) // Fallback
      };

      return NextResponse.json({
        success: true,
        job: {
          id: job.id,
          status: job.status,
          progress: job.progress,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt
        }
      });
    } catch (fileError) {
      console.log(`📁 No progress file found, checking Redis: ${fileError instanceof Error ? fileError.message : 'Unknown error'}`);
    }

    // Fallback to Redis
    const job = await getJob(jobId);
    if (!job) {
      return NextResponse.json(
        { error: 'Job not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      job: {
        id: job.id,
        status: job.status,
        progress: job.progress,
        videoUrl: job.videoUrl,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt
      }
    });

  } catch (error) {
    console.error('❌ Status check error:', error);
    return NextResponse.json(
      {
        error: 'Failed to check job status',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}