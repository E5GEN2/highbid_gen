import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createJob } from '@/lib/videoQueue';
import { processVideoInBackground } from '@/lib/videoProcessor';

export async function POST(request: NextRequest) {
  try {
    console.log('🔄 Starting form data parsing...');
    const formData = await Promise.race([
      request.formData(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('FormData parsing timeout')), 10000))
    ]);
    console.log('✅ Form data parsed successfully');
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

    // Create job in Redis
    try {
      await createJob(jobId);
      console.log('✅ Created job:', jobId);
    } catch (redisError) {
      console.error('❌ Redis job creation failed:', redisError);
      // Continue anyway - background processing will still work
      console.log('⚠️ Continuing without Redis persistence');
    }

    // Start background processing
    setImmediate(async () => {
      try {
        console.log('🔄 Starting background ZIP processing...');
        const zipBuffer = Buffer.from(await zipFile.arrayBuffer());
        await processVideoInBackground(jobId, zipBuffer);
      } catch (err) {
        console.error('❌ Background processing error:', err);
      }
    });

    return NextResponse.json({
      success: true,
      jobId,
      message: 'Video rendering started',
      status: 'pending'
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