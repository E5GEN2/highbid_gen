import { NextResponse } from 'next/server';
import { createJob, getJob, updateJob } from '@/lib/videoQueue';
import { randomBytes } from 'crypto';

export async function GET() {
  try {
    // Test PostgreSQL operations
    const testId = randomBytes(8).toString('hex');

    console.log('Testing PostgreSQL with job ID:', testId);

    // Create a test job
    const job = await createJob(testId);
    console.log('Created test job:', job);

    // Retrieve the job
    const retrievedJob = await getJob(testId);
    console.log('Retrieved test job:', retrievedJob);

    // Update the job
    await updateJob(testId, { status: 'processing', progress: 50 });
    console.log('Updated test job');

    // Retrieve updated job
    const updatedJob = await getJob(testId);
    console.log('Retrieved updated job:', updatedJob);

    return NextResponse.json({
      success: true,
      message: 'PostgreSQL operations successful',
      testJob: updatedJob
    });

  } catch (error) {
    console.error('PostgreSQL test error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      details: error instanceof Error ? error.stack : 'No stack trace'
    }, { status: 500 });
  }
}
