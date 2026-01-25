import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

let schemaInitialized = false;

export async function initSchema(): Promise<void> {
  if (schemaInitialized) return;

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS render_jobs (
        id VARCHAR(64) PRIMARY KEY,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        progress INTEGER NOT NULL DEFAULT 0,
        video_url TEXT,
        error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_render_jobs_created_at ON render_jobs(created_at)
    `);

    // Projects table for sidebar persistence
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        thumbnail TEXT,
        project_data JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC)
    `);

    schemaInitialized = true;
    console.log('Database schema initialized');
  } finally {
    client.release();
  }
}

export async function getPool(): Promise<Pool> {
  await initSchema();
  return pool;
}

export { pool };
