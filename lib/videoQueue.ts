import { Redis } from '@upstash/redis';

interface RenderJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  videoUrl?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Redis configuration for Upstash
const redis = new Redis({
  url: process.env.REDIS_URL!,
  token: process.env.REDIS_TOKEN!
});

export async function createJob(id: string): Promise<RenderJob> {
  const job: RenderJob = {
    id,
    status: 'pending',
    progress: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  try {
    await redis.set(`job:${id}`, JSON.stringify(job), { ex: 3600 }); // 1 hour expiry
    console.log(`📝 Created job ${id} in Redis`);
    return job;
  } catch (error) {
    console.error(`❌ Redis error creating job ${id}:`, error);
    throw error;
  }
}

export async function getJob(id: string): Promise<RenderJob | undefined> {
  try {
    console.log(`🔍 Looking up job ${id} in Redis...`);

    // Add timeout to Redis operations
    const data = await Promise.race([
      redis.get(`job:${id}`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis get timeout')), 5000)
      )
    ]);

    if (data) {
      const job = JSON.parse(data as string);
      console.log(`📖 Retrieved job ${id} from Redis: ${job.status} (${job.progress}%)`);
      return job;
    } else {
      console.log(`❌ Job ${id} not found in Redis`);
      return undefined;
    }
  } catch (error) {
    console.error(`❌ Redis error getting job ${id}:`, error);
    return undefined;
  }
}

export async function updateJob(id: string, updates: Partial<RenderJob>): Promise<void> {
  try {
    console.log(`🔄 Attempting to update job ${id} with:`, updates);

    // Try to get existing job with timeout
    let existing: RenderJob | undefined;
    try {
      existing = await Promise.race([
        getJob(id),
        new Promise<undefined>((_, reject) =>
          setTimeout(() => reject(new Error('Redis timeout')), 5000)
        )
      ]);
    } catch (redisError) {
      console.error(`❌ Redis getJob failed for ${id}:`, redisError);
      existing = undefined;
    }

    let jobToSave: RenderJob;
    if (existing) {
      jobToSave = { ...existing, ...updates, updatedAt: new Date() };
      console.log(`📝 Updating existing job ${id}: ${jobToSave.status} (${jobToSave.progress}%)`);
    } else {
      // Create new job if not found (for background processes)
      jobToSave = {
        id,
        status: 'pending',
        progress: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...updates
      };
      console.log(`📝 Creating new job ${id}: ${jobToSave.status} (${jobToSave.progress}%)`);
    }

    // Try to save with timeout
    try {
      await Promise.race([
        redis.set(`job:${id}`, JSON.stringify(jobToSave), { ex: 3600 }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Redis set timeout')), 5000)
        )
      ]);
      console.log(`✅ Successfully saved job ${id} to Redis: ${jobToSave.status} (${jobToSave.progress}%)`);
    } catch (redisError) {
      console.error(`❌ Redis set failed for job ${id}:`, redisError);
      console.log(`⚠️ Job ${id} update lost due to Redis failure`);
    }
  } catch (error) {
    console.error(`❌ Unexpected error updating job ${id}:`, error);
  }
}

export async function deleteJob(id: string): Promise<void> {
  try {
    await redis.del(`job:${id}`);
    console.log(`🗑️  Deleted job ${id} from Redis`);
  } catch (error) {
    console.error(`❌ Redis error deleting job ${id}:`, error);
  }
}