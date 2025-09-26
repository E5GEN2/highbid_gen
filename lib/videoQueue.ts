// In-memory job queue for video rendering
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

export function createJob(id: string): RenderJob {
  const job: RenderJob = {
    id,
    status: 'pending',
    progress: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): RenderJob | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, updates: Partial<RenderJob>): void {
  const job = jobs.get(id);
  if (job) {
    Object.assign(job, updates, { updatedAt: new Date() });
    jobs.set(id, job);
  }
}

export function deleteJob(id: string): void {
  jobs.delete(id);
}