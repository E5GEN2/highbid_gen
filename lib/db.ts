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

    // Deep Analysis pipeline tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS deep_analysis_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        channel_count INT DEFAULT 0,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS deep_analysis_channels (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES deep_analysis_runs(id),
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        channel_url TEXT,
        priority INT,
        interest_score REAL,
        triage_reason TEXT,
        what_to_look_for TEXT,
        synthesis JSONB,
        post_tweet TEXT,
        post_hook_category TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dac_run ON deep_analysis_channels(run_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS deep_analysis_storyboards (
        id TEXT PRIMARY KEY,
        channel_entry_id TEXT NOT NULL REFERENCES deep_analysis_channels(id),
        video_id TEXT NOT NULL,
        video_title TEXT,
        view_count BIGINT,
        storyboard JSONB,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_das_channel ON deep_analysis_storyboards(channel_entry_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS deep_analysis_logs (
        id SERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        channel_entry_id TEXT,
        step TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT,
        model TEXT DEFAULT 'gemini-flash',
        duration_ms INT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        tokens_in INT,
        tokens_out INT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dal_run ON deep_analysis_logs(run_id)
    `);

    // Clipping: projects for AI-powered video clipping
    await client.query(`
      CREATE TABLE IF NOT EXISTS clipping_projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT 'Untitled',
        status TEXT NOT NULL DEFAULT 'draft',
        thumbnail_url TEXT,
        video_duration REAL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_clipping_projects_user ON clipping_projects(user_id)
    `);

    // Clipping: add pipeline state columns (idempotent ALTERs)
    for (const col of [
      "current_step TEXT",
      "step_status TEXT DEFAULT 'idle'",
      "step_progress JSONB DEFAULT '{}'",
      "source_path TEXT",
      "source_url TEXT",
      "error TEXT",
    ]) {
      const colName = col.split(' ')[0];
      await client.query(`
        DO $$ BEGIN
          ALTER TABLE clipping_projects ADD COLUMN ${col};
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$
      `);
    }

    // Clipping: video analysis results (timestamped segments from Gemini)
    await client.query(`
      CREATE TABLE IF NOT EXISTS clipping_analyses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES clipping_projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        video_url TEXT,
        video_duration_seconds REAL,
        total_segments INT,
        segments JSONB,
        raw_response TEXT,
        error TEXT,
        prompt TEXT,
        tokens_in INT,
        tokens_out INT,
        duration_ms INT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_clipping_analyses_project ON clipping_analyses(project_id)
    `);

    // Clipping: processing logs for debugging
    await client.query(`
      CREATE TABLE IF NOT EXISTS clipping_logs (
        id SERIAL PRIMARY KEY,
        project_id UUID REFERENCES clipping_projects(id) ON DELETE CASCADE,
        analysis_id UUID REFERENCES clipping_analyses(id) ON DELETE CASCADE,
        step TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_clipping_logs_project ON clipping_logs(project_id)
    `);

    // Clipping: generated clips (AI-selected moments cut from source video)
    await client.query(`
      CREATE TABLE IF NOT EXISTS clipping_clips (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES clipping_projects(id) ON DELETE CASCADE,
        analysis_id UUID REFERENCES clipping_analyses(id),
        title TEXT NOT NULL,
        description TEXT,
        score REAL,
        start_sec REAL NOT NULL,
        end_sec REAL NOT NULL,
        duration_sec REAL NOT NULL,
        transcript TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        file_path TEXT,
        thumbnail_path TEXT,
        file_size_bytes BIGINT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_clipping_clips_project ON clipping_clips(project_id)
    `);

    // Clipping: face detection data for smart cropping
    await client.query(`
      CREATE TABLE IF NOT EXISTS clipping_face_data (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES clipping_projects(id) ON DELETE CASCADE,
        clip_id UUID REFERENCES clipping_clips(id) ON DELETE CASCADE,
        start_sec REAL,
        end_sec REAL,
        fps_sampled INT,
        total_frames INT,
        video_width INT,
        video_height INT,
        frames JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_clipping_face_data_project ON clipping_face_data(project_id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_clipping_face_data_unique
      ON clipping_face_data (project_id, COALESCE(clip_id, '00000000-0000-0000-0000-000000000000'::uuid))
    `);

    // API tokens for programmatic access
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        name TEXT NOT NULL DEFAULT 'default',
        token VARCHAR(128) UNIQUE NOT NULL,
        scopes TEXT DEFAULT 'clipping',
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_tokens_token ON api_tokens(token)
    `);
    // Widen token column if needed (was VARCHAR(64), tokens are 67+ chars)
    await client.query(`ALTER TABLE api_tokens ALTER COLUMN token TYPE VARCHAR(128)`).catch(() => {});

    // Niche Explorer: synced video data from external niche spy pipeline
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_spy_videos (
        id SERIAL PRIMARY KEY,
        external_id INTEGER UNIQUE,
        task_id TEXT,
        keyword TEXT,
        url TEXT,
        title TEXT,
        view_count BIGINT,
        channel_name TEXT,
        posted_date TEXT,
        posted_at TIMESTAMPTZ,
        score INTEGER,
        subscriber_count BIGINT,
        like_count BIGINT,
        comment_count BIGINT,
        top_comment TEXT,
        thumbnail TEXT,
        fetched_at TIMESTAMPTZ,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_niche_spy_keyword ON niche_spy_videos(keyword)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_niche_spy_score ON niche_spy_videos(score DESC NULLS LAST)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_niche_spy_views ON niche_spy_videos(view_count DESC NULLS LAST)`);
    // Add unique URL constraint if not exists
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_niche_spy_url ON niche_spy_videos(url)`).catch(() => {});
    // Add enrichment tracking column
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_spy_pipeline_runs (
        id SERIAL PRIMARY KEY,
        external_id INTEGER UNIQUE,
        ran_at TIMESTAMPTZ,
        fetched INTEGER,
        quality INTEGER,
        duplicates INTEGER,
        confirmed INTEGER,
        new_urls INTEGER,
        scheduled INTEGER,
        declined INTEGER,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Niche saturation tracking (worker-reported)
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_spy_saturation (
        id SERIAL PRIMARY KEY,
        keyword TEXT NOT NULL,
        task_id TEXT,
        total_seen INTEGER DEFAULT 0,
        total_known INTEGER DEFAULT 0,
        total_unseen INTEGER DEFAULT 0,
        saturation_pct NUMERIC(5,2) DEFAULT 0,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_niche_saturation_kw ON niche_spy_saturation(keyword, recorded_at DESC)`).catch(() => {});

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
