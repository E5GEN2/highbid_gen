// Simple in-memory job queue as fallback
// In production, use Redis or a proper queue service

interface RenderJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  videoUrl?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const jobs = new Map<string, RenderJob>();

export async function createJob(id: string): Promise<RenderJob> {
  const job: RenderJob = {
    id,
    status: 'pending',
    progress: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  jobs.set(id, job);
  console.log(`📝 Created job ${id} in memory`);
  return job;
}

export async function getJob(id: string): Promise<RenderJob | undefined> {
  const job = jobs.get(id);
  if (job) {
    console.log(`📖 Retrieved job ${id} from memory: ${job.status} (${job.progress}%)`);
  } else {
    console.log(`❌ Job ${id} not found in memory`);
  }
  return job;
}

export async function updateJob(id: string, updates: Partial<RenderJob>): Promise<void> {
  const job = jobs.get(id);
  if (job) {
    Object.assign(job, updates, { updatedAt: new Date() });
    jobs.set(id, job);
    console.log(`📝 Updated job ${id} in memory: ${job.status} (${job.progress}%)`);
  } else {
    console.error(`❌ Cannot update job ${id}: not found`);
  }
}

export async function deleteJob(id: string): Promise<void> {
  jobs.delete(id);
  console.log(`🗑️  Deleted job ${id} from memory`);
}