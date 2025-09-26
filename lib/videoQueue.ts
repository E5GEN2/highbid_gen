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

const redis = new Redis({
  url: process.env.REDIS_URL!,
  token: process.env.REDIS_TOKEN!,
});

export async function createJob(id: string): Promise<RenderJob> {
  const job: RenderJob = {
    id,
    status: 'pending',
    progress: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  await redis.set(`job:${id}`, JSON.stringify(job), { ex: 3600 }); // 1 hour expiry
  console.log(`📝 Created job ${id} in Redis`);
  return job;
}

export async function getJob(id: string): Promise<RenderJob | undefined> {
  try {
    const data = await redis.get(`job:${id}`);
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
    const existing = await getJob(id);
    if (existing) {
      const updated = { ...existing, ...updates, updatedAt: new Date() };
      await redis.set(`job:${id}`, JSON.stringify(updated), { ex: 3600 });
      console.log(`📝 Updated job ${id} in Redis: ${updated.status} (${updated.progress}%)`);
    } else {
      console.error(`❌ Cannot update job ${id}: not found in Redis`);
    }
  } catch (error) {
    console.error(`❌ Redis error updating job ${id}:`, error);
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