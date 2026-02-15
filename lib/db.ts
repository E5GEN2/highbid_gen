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

    // Shorts spy: channels (deduplicated, updated on each sync)
    await client.query(`
      CREATE TABLE IF NOT EXISTS shorts_channels (
        channel_id VARCHAR(64) PRIMARY KEY,
        channel_name VARCHAR(255),
        channel_url TEXT,
        channel_creation_date TIMESTAMP WITH TIME ZONE,
        first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        sighting_count INTEGER DEFAULT 1
      )
    `);

    // Add columns if missing (migration for existing DBs)
    await client.query(`
      ALTER TABLE shorts_channels ADD COLUMN IF NOT EXISTS avatar_url TEXT
    `);
    await client.query(`
      ALTER TABLE shorts_channels ADD COLUMN IF NOT EXISTS subscriber_count BIGINT
    `);
    await client.query(`
      ALTER TABLE shorts_channels ADD COLUMN IF NOT EXISTS total_video_count BIGINT
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_channels_created ON shorts_channels(channel_creation_date DESC)
    `);

    // Shorts spy: video sightings (same video can appear multiple times = trend tracking)
    await client.query(`
      CREATE TABLE IF NOT EXISTS shorts_videos (
        id SERIAL PRIMARY KEY,
        video_id VARCHAR(32) NOT NULL,
        video_url TEXT,
        title TEXT,
        duration_seconds INTEGER,
        upload_date TEXT,
        channel_id VARCHAR(64) REFERENCES shorts_channels(channel_id),
        view_count BIGINT,
        like_count BIGINT,
        comment_count BIGINT,
        collected_at TIMESTAMP WITH TIME ZONE,
        collection_id VARCHAR(64)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_videos_video_id ON shorts_videos(video_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_videos_channel ON shorts_videos(channel_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_videos_views ON shorts_videos(view_count DESC NULLS LAST)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_videos_collected ON shorts_videos(collected_at DESC)
    `);

    // Shorts spy: collection runs (tracks each xgodo task we ingested)
    await client.query(`
      CREATE TABLE IF NOT EXISTS shorts_collections (
        id VARCHAR(64) PRIMARY KEY,
        xgodo_task_id VARCHAR(64) NOT NULL UNIQUE,
        video_count INTEGER DEFAULT 0,
        collected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        confirmed_at TIMESTAMP WITH TIME ZONE
      )
    `);

    // Admin config key-value store
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_config (
        key VARCHAR(128) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Auth: users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        google_id VARCHAR(128) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        image TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Auth: channels seen by each user
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_seen_channels (
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        channel_id VARCHAR(64) REFERENCES shorts_channels(channel_id) ON DELETE CASCADE,
        seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        PRIMARY KEY (user_id, channel_id)
      )
    `);

    // Auth: user preferences
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        feed_filters JSONB DEFAULT '{}',
        hidden_channel_ids TEXT[] DEFAULT '{}',
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // X Posts: track channels that have been posted to X
    await client.query(`
      CREATE TABLE IF NOT EXISTS x_posted_channels (
        channel_id VARCHAR(64) PRIMARY KEY REFERENCES shorts_channels(channel_id) ON DELETE CASCADE,
        posted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        post_type VARCHAR(32)
      )
    `);

    // AI Channel Analysis: stores Gemini-based channel analysis results
    await client.query(`
      CREATE TABLE IF NOT EXISTS channel_analysis (
        channel_id VARCHAR(64) PRIMARY KEY REFERENCES shorts_channels(channel_id) ON DELETE CASCADE,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        category VARCHAR(128),
        niche VARCHAR(128),
        sub_niche VARCHAR(128),
        content_style VARCHAR(64),
        is_ai_generated BOOLEAN,
        channel_summary TEXT,
        tags TEXT[],
        raw_response JSONB,
        error_message TEXT,
        analyzed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE channel_analysis ADD COLUMN IF NOT EXISTS category VARCHAR(128)
    `);

    await client.query(`
      ALTER TABLE channel_analysis ADD COLUMN IF NOT EXISTS language VARCHAR(16)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_channel_analysis_status ON channel_analysis(status)
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
