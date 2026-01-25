import { getPool } from './db';

interface RenderJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  videoUrl?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Cleanup old jobs (older than 1 hour) - called lazily
async function cleanupOldJobs(): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.query(
      `DELETE FROM render_jobs WHERE created_at < NOW() - INTERVAL '1 hour'`
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`Cleaned up ${result.rowCount} old jobs`);
    }
  } catch (error) {
    console.error('Error cleaning up old jobs:', error);
  }
}

function rowToJob(row: {
  id: string;
  status: string;
  progress: number;
  video_url: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}): RenderJob {
  return {
    id: row.id,
    status: row.status as RenderJob['status'],
    progress: row.progress,
    videoUrl: row.video_url || undefined,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createJob(id: string): Promise<RenderJob> {
  try {
    // Lazily cleanup old jobs
    cleanupOldJobs().catch(() => {});

    const pool = await getPool();
    const result = await pool.query(
      `INSERT INTO render_jobs (id, status, progress, created_at, updated_at)
       VALUES ($1, 'pending', 0, NOW(), NOW())
       RETURNING *`,
      [id]
    );

    const job = rowToJob(result.rows[0]);
    console.log(`Created job ${id} in PostgreSQL`);
    return job;
  } catch (error) {
    console.error(`PostgreSQL error creating job ${id}:`, error);
    throw error;
  }
}

export async function getJob(id: string): Promise<RenderJob | undefined> {
  try {
    console.log(`Looking up job ${id} in PostgreSQL...`);

    const pool = await getPool();
    const result = await pool.query(
      `SELECT * FROM render_jobs WHERE id = $1`,
      [id]
    );

    if (result.rows.length > 0) {
      const job = rowToJob(result.rows[0]);
      console.log(`Retrieved job ${id} from PostgreSQL: ${job.status} (${job.progress}%)`);
      return job;
    } else {
      console.log(`Job ${id} not found in PostgreSQL`);
      return undefined;
    }
  } catch (error) {
    console.error(`PostgreSQL error getting job ${id}:`, error);
    return undefined;
  }
}

export async function updateJob(id: string, updates: Partial<RenderJob>): Promise<void> {
  try {
    console.log(`Attempting to update job ${id} with:`, updates);

    const pool = await getPool();

    // Check if job exists
    const existing = await getJob(id);

    if (existing) {
      // Build dynamic UPDATE query
      const setClauses: string[] = ['updated_at = NOW()'];
      const values: (string | number)[] = [];
      let paramIndex = 1;

      if (updates.status !== undefined) {
        setClauses.push(`status = $${paramIndex++}`);
        values.push(updates.status);
      }
      if (updates.progress !== undefined) {
        setClauses.push(`progress = $${paramIndex++}`);
        values.push(updates.progress);
      }
      if (updates.videoUrl !== undefined) {
        setClauses.push(`video_url = $${paramIndex++}`);
        values.push(updates.videoUrl);
      }
      if (updates.error !== undefined) {
        setClauses.push(`error = $${paramIndex++}`);
        values.push(updates.error);
      }

      values.push(id);

      await pool.query(
        `UPDATE render_jobs SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
        values
      );

      console.log(`Successfully updated job ${id} in PostgreSQL`);
    } else {
      // Create new job if not found (for background processes)
      const status = updates.status || 'pending';
      const progress = updates.progress || 0;
      const videoUrl = updates.videoUrl || null;
      const error = updates.error || null;

      await pool.query(
        `INSERT INTO render_jobs (id, status, progress, video_url, error, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        [id, status, progress, videoUrl, error]
      );

      console.log(`Created new job ${id} in PostgreSQL: ${status} (${progress}%)`);
    }
  } catch (error) {
    console.error(`PostgreSQL error updating job ${id}:`, error);
  }
}

export async function deleteJob(id: string): Promise<void> {
  try {
    const pool = await getPool();
    await pool.query(`DELETE FROM render_jobs WHERE id = $1`, [id]);
    console.log(`Deleted job ${id} from PostgreSQL`);
  } catch (error) {
    console.error(`PostgreSQL error deleting job ${id}:`, error);
  }
}
