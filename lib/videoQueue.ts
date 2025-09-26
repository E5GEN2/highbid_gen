// Redis-based job queue for video rendering
import { createClient } from 'redis';

interface RenderJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  videoUrl?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Create Redis client
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://default:ATFEAAIncDIwZDViMWI5NzllYmI0NGY0YTk3NTdmNWM0NzlmZGE2ZnAyMTI2MTI@learning-ostrich-12612.upstash.io:6379',
  socket: {
    tls: true
  }
});

redis.on('error', (err) => console.error('Redis Client Error', err));

// Ensure connection
let isConnected = false;
async function ensureConnection() {
  if (!isConnected) {
    await redis.connect();
    isConnected = true;
    console.log('✅ Connected to Redis');
  }
}

export async function createJob(id: string): Promise<RenderJob> {
  await ensureConnection();

  const job: RenderJob = {
    id,
    status: 'pending',
    progress: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  await redis.setEx(`job:${id}`, 3600, JSON.stringify(job)); // 1 hour expiry
  console.log(`📝 Created job ${id} in Redis`);
  return job;
}

export async function getJob(id: string): Promise<RenderJob | undefined> {
  await ensureConnection();

  const jobData = await redis.get(`job:${id}`);
  if (!jobData) {
    console.log(`❌ Job ${id} not found in Redis`);
    return undefined;
  }

  const job = JSON.parse(jobData) as RenderJob;
  // Convert date strings back to Date objects
  job.createdAt = new Date(job.createdAt);
  job.updatedAt = new Date(job.updatedAt);

  console.log(`📖 Retrieved job ${id} from Redis: ${job.status} (${job.progress}%)`);
  return job;
}

export async function updateJob(id: string, updates: Partial<RenderJob>): Promise<void> {
  await ensureConnection();

  const existingJob = await getJob(id);
  if (!existingJob) {
    console.error(`❌ Cannot update job ${id}: not found`);
    return;
  }

  const updatedJob = {
    ...existingJob,
    ...updates,
    updatedAt: new Date()
  };

  await redis.setEx(`job:${id}`, 3600, JSON.stringify(updatedJob)); // 1 hour expiry
  console.log(`📝 Updated job ${id} in Redis: ${updatedJob.status} (${updatedJob.progress}%)`);
}

export async function deleteJob(id: string): Promise<void> {
  await ensureConnection();

  await redis.del(`job:${id}`);
  console.log(`🗑️  Deleted job ${id} from Redis`);
}