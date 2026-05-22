import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Bumped 20 → 50. The novelty + ai-labels backfills run with 10-12
  // worker threads each, plus video-seed requests need their own
  // connections. At max=20, those jobs together starved the pool and
  // page requests got "timeout exceeded when trying to connect".
  // Railway pg default max_connections=100, so 50 is half the budget.
  max: 50,
  idleTimeoutMillis: 30000,
  // Bumped from 10s — getLatestGlobalRun fans out 6 queries in
  // parallel and the niche-tree page can stack a few simultaneous
  // requests during initial render. 10s was tight enough that Railway
  // connection-pool churn surfaced as "timeout exceeded when trying
  // to connect" in the UI.
  connectionTimeoutMillis: 30000,
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
    // Composite index matching the shape of the insights/distribution queries:
    // WHERE keyword=? AND score>=? ORDER BY view_count DESC — collapses 8-15s queries to <500ms
    await client.query(`CREATE INDEX IF NOT EXISTS idx_niche_spy_kw_score_views ON niche_spy_videos(keyword, score DESC NULLS LAST, view_count DESC NULLS LAST)`).catch(() => {});
    // Add unique URL constraint if not exists
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_niche_spy_url ON niche_spy_videos(url)`).catch(() => {});
    // Add enrichment tracking column
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS channel_created_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS channel_id VARCHAR(64)`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS channel_avatar TEXT`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS title_embedding REAL[]`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ`).catch(() => {});
    // v2 (gemini-embedding-2-preview) — separate columns so we can coexist with v1
    // and roll out gradually. Thumbnail embeddings only make sense on v2 (multimodal).
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS title_embedding_v2 REAL[]`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS title_embedded_v2_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS thumbnail_embedding_v2 REAL[]`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS thumbnail_embedded_v2_at TIMESTAMPTZ`).catch(() => {});
    // combined_v2 — gemini multimodal embedding of (title text + thumbnail
    // image) packed into a single content with two parts. One vector that
    // captures the joint signal "this title delivered with this visual".
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS combined_embedding_v2 REAL[]`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS combined_embedded_v2_at TIMESTAMPTZ`).catch(() => {});
    // Novelty: mean K-NN cosine distance in the combined (title_v2 +
    // thumbnail_v2) space. Populated by /api/admin/novelty/recompute.
    // Higher = more unique. Used by the admin "Novelty" tab to surface
    // blue-ocean video angles (unique + viral) before building them out.
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS novelty_score DOUBLE PRECISION`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS novelty_updated_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nsv_novelty ON niche_spy_videos(novelty_score DESC NULLS LAST)`).catch(() => {});
    // Marks a video whose thumbnail cannot be retrieved (HTTP 404/410/451,
    // or img.youtube.com returns the ~120B placeholder for a deleted /
    // privated / region-blocked video). Set on first failed fetch by the
    // embedding worker so the v2/combined_v2 SELECTs can skip the row
    // permanently. Once we observe a 404 the video is never coming back
    // (YouTube doesn't restore thumbnails); marking sidesteps an endless
    // re-fetch loop that previously dominated the embedding error budget.
    await client.query(`ALTER TABLE niche_spy_videos ADD COLUMN IF NOT EXISTS thumbnail_dead_at TIMESTAMPTZ`).catch(() => {});
    // Partial index so the "v2 embedding queue" SELECTs find live-thumbnail
    // rows fast without scanning the whole table — small index since most
    // rows are alive (the dead set is in the ~5-10% range).
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nsv_thumb_dead ON niche_spy_videos(thumbnail_dead_at) WHERE thumbnail_dead_at IS NOT NULL`).catch(() => {});
    // Remember which target a job was for — so the admin UI can tell the user
    // "you clicked Thumbnail but there's already a Title v2 job running".
    await client.query(`ALTER TABLE niche_spy_embedding_jobs ADD COLUMN IF NOT EXISTS target TEXT`).catch(() => {});

    // Channel-level cache. Videos reference channels by channel_id; we store
    // channel metadata here (instead of duplicating on every video row) so
    // expensive lookups — subscriber_count, channel_created_at, and especially
    // first_upload_at (derived from walking the uploads playlist) — are done
    // once per channel not once per video.
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_spy_channels (
        channel_id TEXT PRIMARY KEY,
        channel_name TEXT,
        channel_handle TEXT,
        channel_avatar TEXT,
        subscriber_count BIGINT,
        channel_created_at TIMESTAMPTZ,
        first_upload_at TIMESTAMPTZ,
        latest_upload_at TIMESTAMPTZ,
        video_count INTEGER,
        uploads_playlist_id TEXT,
        dormancy_days INTEGER,
        last_channel_fetched_at TIMESTAMPTZ,
        last_uploads_fetched_at TIMESTAMPTZ,
        error_message TEXT
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nsc_first_upload ON niche_spy_channels(first_upload_at)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nsc_last_uploads ON niche_spy_channels(last_uploads_fetched_at NULLS FIRST)`).catch(() => {});
    // Peer-outlier score: channel.avg_views / median(avg_views of channels in
    // the same subscriber bucket). Computed by a nightly cron over all
    // enriched channels. Index on score DESC so the outliers page can sort
    // fast without a full table scan.
    await client.query(`ALTER TABLE niche_spy_channels ADD COLUMN IF NOT EXISTS peer_outlier_score DOUBLE PRECISION`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_channels ADD COLUMN IF NOT EXISTS peer_outlier_bucket TEXT`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_channels ADD COLUMN IF NOT EXISTS peer_outlier_updated_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nsc_peer_outlier ON niche_spy_channels(peer_outlier_score DESC NULLS LAST)`).catch(() => {});
    // Unbiased view-stats from the channel's OWN recent uploads (walked via
    // playlistItems.list + videos.list). Required for accurate peer-outlier
    // scoring — otherwise avg_views is computed over whatever biased subset
    // xgodo scraped (usually the channel's hits, which inflates the avg).
    await client.query(`ALTER TABLE niche_spy_channels ADD COLUMN IF NOT EXISTS recent_videos_avg_views BIGINT`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_channels ADD COLUMN IF NOT EXISTS recent_videos_median_views BIGINT`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_channels ADD COLUMN IF NOT EXISTS recent_videos_max_views BIGINT`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_channels ADD COLUMN IF NOT EXISTS recent_videos_count INTEGER`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_channels ADD COLUMN IF NOT EXISTS last_recent_videos_fetched_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nsc_recent_fetched ON niche_spy_channels(last_recent_videos_fetched_at NULLS FIRST)`).catch(() => {});

    // Favourites — a single global list (no per-user scoping). One row per
    // starred video. Deleting a video cascades to remove its favourite.
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_spy_favourites (
        video_id INTEGER PRIMARY KEY REFERENCES niche_spy_videos(id) ON DELETE CASCADE,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nsf_added ON niche_spy_favourites(added_at DESC)`).catch(() => {});

    // Niche-level favourites — parallel to niche_spy_favourites but
    // keyed on cluster_id. The star button on each NicheClusterCard
    // writes here. Cluster row delete cascades a row delete here.
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_spy_favourite_clusters (
        cluster_id INTEGER PRIMARY KEY REFERENCES niche_tree_clusters(id) ON DELETE CASCADE,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nsfc_added ON niche_spy_favourite_clusters(added_at DESC)`).catch(() => {});

    // Custom niches — user-defined collections of videos. Unlike the
    // auto-discovered niche_tree_clusters these are manually curated:
    // give it a name + optional description, then star videos into it
    // from anywhere on the site. M:n join with niche_spy_videos via
    // custom_niche_videos. Cascade delete from either side cleans the
    // join automatically.
    await client.query(`
      CREATE TABLE IF NOT EXISTS custom_niches (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`
      CREATE TABLE IF NOT EXISTS custom_niche_videos (
        custom_niche_id INTEGER NOT NULL REFERENCES custom_niches(id) ON DELETE CASCADE,
        video_id        INTEGER NOT NULL REFERENCES niche_spy_videos(id) ON DELETE CASCADE,
        added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (custom_niche_id, video_id)
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cnv_video    ON custom_niche_videos(video_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cnv_added    ON custom_niche_videos(added_at DESC)`).catch(() => {});
    // Niche center — user-designated "most central" video for the
    // custom niche. Manually picked (custom niches don't have a
    // mathematical centroid like auto clusters do), used to anchor
    // similarity sorts inside the niche + as the canonical
    // representative on the niche card. ON DELETE SET NULL so
    // removing the underlying video from the DB doesn't break the
    // niche row. Foreign key relaxation matters because the user
    // can also pick a video, then later remove it from the niche
    // — center then naturally falls back to NULL.
    await client.query(`
      ALTER TABLE custom_niches
        ADD COLUMN IF NOT EXISTS center_video_id INTEGER REFERENCES niche_spy_videos(id) ON DELETE SET NULL
    `).catch(() => {});

    // One-time backfill: copy channel-level data we already collected on the
    // videos table into the new channels table. Idempotent via ON CONFLICT.
    await client.query(`
      INSERT INTO niche_spy_channels (channel_id, channel_name, channel_avatar,
        subscriber_count, channel_created_at, last_channel_fetched_at)
      SELECT DISTINCT ON (channel_id)
        channel_id, channel_name, channel_avatar,
        subscriber_count, channel_created_at, enriched_at
      FROM niche_spy_videos
      WHERE channel_id IS NOT NULL AND channel_id != ''
      ORDER BY channel_id, enriched_at DESC NULLS LAST
      ON CONFLICT (channel_id) DO NOTHING
    `).catch((err) => {
      console.warn('[db] channels backfill skipped:', (err as Error).message);
    });

    // YT Data API enrichment jobs — mirrors niche_spy_embedding_jobs so the
    // admin UI can render the same progress treatment for both pipelines.
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_yt_enrich_jobs (
        id SERIAL PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'running',
        keyword TEXT,
        threads INTEGER DEFAULT 1,
        total_needed INTEGER DEFAULT 0,
        processed INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        current_batch INTEGER DEFAULT 0,
        total_batches INTEGER DEFAULT 0,
        enriched_videos INTEGER DEFAULT 0,
        enriched_channels INTEGER DEFAULT 0,
        error_message TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `).catch(() => {});
    // Indefinite mode: when true, the worker re-fetches the pending
    // queue and keeps running batches until cancelled or the source
    // table is fully enriched. `loops` tracks how many full passes
    // have completed so the UI can show "loop 3 of ∞".
    await client.query(`ALTER TABLE niche_yt_enrich_jobs ADD COLUMN IF NOT EXISTS indefinite BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
    await client.query(`ALTER TABLE niche_yt_enrich_jobs ADD COLUMN IF NOT EXISTS loops INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nyej_status ON niche_yt_enrich_jobs(status, started_at DESC)`).catch(() => {});

    // Embedding job progress (survives page reload)
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_spy_embedding_jobs (
        id SERIAL PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'running',
        keyword TEXT,
        total_needed INTEGER DEFAULT 0,
        processed INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        current_batch INTEGER DEFAULT 0,
        total_batches INTEGER DEFAULT 0,
        error_message TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `).catch(() => {});
    // Normalize existing URLs to canonical youtu.be/VIDEO_ID format and dedup
    await client.query(`
      UPDATE niche_spy_videos
      SET url = 'https://youtu.be/' || SUBSTRING(url FROM '([a-zA-Z0-9_-]{11})$')
      WHERE url IS NOT NULL AND url NOT LIKE 'https://youtu.be/___________'
        AND SUBSTRING(url FROM '([a-zA-Z0-9_-]{11})$') IS NOT NULL
    `).catch(() => {});
    // Remove duplicates by URL: keep the row with best data
    await client.query(`
      DELETE FROM niche_spy_videos WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY url ORDER BY score DESC NULLS LAST, view_count DESC NULLS LAST, enriched_at DESC NULLS LAST) as rn
          FROM niche_spy_videos WHERE url IS NOT NULL
        ) sub WHERE rn > 1
      )
    `).catch(() => {});
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_niche_spy_url ON niche_spy_videos(url)`).catch(() => {});

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

    // Niche saturation runs — server-side A/B/C model (authoritative)
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_saturation_runs (
        id SERIAL PRIMARY KEY,
        keyword TEXT NOT NULL,
        run_at TIMESTAMPTZ DEFAULT NOW(),
        known_before INTEGER DEFAULT 0,
        run_total INTEGER DEFAULT 0,
        new_count INTEGER DEFAULT 0,
        overlap_count INTEGER DEFAULT 0,
        missed_count INTEGER DEFAULT 0,
        run_saturation_pct NUMERIC(5,2) DEFAULT 0,
        global_saturation_pct NUMERIC(5,2) DEFAULT 0,
        niche_universe_size INTEGER DEFAULT 0
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_niche_sat_runs_kw ON niche_saturation_runs(keyword, run_at DESC)`).catch(() => {});

    // Clustering tables for sub-niche discovery
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_cluster_runs (
        id SERIAL PRIMARY KEY,
        keyword TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        algorithm TEXT DEFAULT 'hdbscan',
        params JSONB DEFAULT '{}',
        num_clusters INTEGER DEFAULT 0,
        num_noise INTEGER DEFAULT 0,
        total_videos INTEGER DEFAULT 0,
        error_message TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ncr_keyword ON niche_cluster_runs(keyword, started_at DESC)`).catch(() => {});
    // Embedding space this run was clustered on — lets us run multiple runs
    // per keyword (title/thumbnail/combined) and display the right one
    await client.query(`ALTER TABLE niche_cluster_runs ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'title_v1'`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_clusters (
        id SERIAL PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES niche_cluster_runs(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        cluster_index INTEGER NOT NULL,
        auto_label TEXT,
        ai_label TEXT,
        label TEXT,
        video_count INTEGER DEFAULT 0,
        avg_score REAL,
        avg_views BIGINT,
        total_views BIGINT,
        top_channels TEXT[],
        representative_video_id INTEGER,
        centroid_2d REAL[],
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nc_run ON niche_clusters(run_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nc_keyword ON niche_clusters(keyword)`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_cluster_assignments (
        id SERIAL PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES niche_cluster_runs(id) ON DELETE CASCADE,
        video_id INTEGER NOT NULL,
        cluster_id INTEGER REFERENCES niche_clusters(id) ON DELETE CASCADE,
        cluster_index INTEGER NOT NULL,
        x_2d REAL,
        y_2d REAL,
        distance_to_centroid REAL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nca_run ON niche_cluster_assignments(run_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nca_cluster ON niche_cluster_assignments(cluster_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nca_video ON niche_cluster_assignments(video_id)`).catch(() => {});

    // ─────────────────────────────────────────────────────────────────
    // Niche TREE — hierarchical clustering across the entire dataset.
    // Sandboxed in its own tables while we validate it before merging
    // with the per-keyword pipeline above. Every cluster has a level
    // (1 = global, 2 = sub-niche of an L1, etc.) and an optional
    // parent_cluster_id pointing one level up. NULL parent = top-level.
    //
    // The Python clustering script (scripts/cluster-niches.py) is reused
    // verbatim — Node passes the input video set (all embedded videos
    // for L1, the L1 cluster's videos for L2, etc.) and writes the
    // returned assignments here.
    // ─────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_tree_runs (
        id SERIAL PRIMARY KEY,
        kind TEXT NOT NULL,                     -- 'global' | 'subdivide'
        parent_cluster_id INTEGER,              -- NULL for global; set for subdivide
        level INTEGER NOT NULL DEFAULT 1,       -- depth this run produces (1, 2, 3…)
        source TEXT NOT NULL DEFAULT 'thumbnail_v2',
        status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'done' | 'error'
        params JSONB DEFAULT '{}',
        num_clusters INTEGER DEFAULT 0,
        num_noise INTEGER DEFAULT 0,
        total_videos INTEGER DEFAULT 0,
        error_message TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);
    // Live progress for in-flight runs — parsed from the Python script's
    // stderr stage markers (X shape, UMAP done, HDBSCAN, etc.) as they
    // stream in. Read by the admin UI to render a per-stage progress bar
    // alongside the cluster grid.
    await client.query(`ALTER TABLE niche_tree_runs ADD COLUMN IF NOT EXISTS progress JSONB DEFAULT '{}'`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ntr_kind ON niche_tree_runs(kind, started_at DESC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ntr_parent ON niche_tree_runs(parent_cluster_id)`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_tree_clusters (
        id SERIAL PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES niche_tree_runs(id) ON DELETE CASCADE,
        parent_cluster_id INTEGER REFERENCES niche_tree_clusters(id) ON DELETE CASCADE,
        level INTEGER NOT NULL,
        cluster_index INTEGER NOT NULL,
        auto_label TEXT,
        ai_label TEXT,
        label TEXT,
        video_count INTEGER DEFAULT 0,
        avg_score REAL,
        avg_views BIGINT,
        total_views BIGINT,
        top_channels TEXT[],
        representative_video_id INTEGER,
        centroid_2d REAL[],
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ntc_run    ON niche_tree_clusters(run_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ntc_parent ON niche_tree_clusters(parent_cluster_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ntc_level  ON niche_tree_clusters(level)`).catch(() => {});

    // Stitching layer — stable identity for clusters across re-runs.
    //
    // Each row in niche_tree_clusters is one (run_id, cluster_index) pair, so
    // the same logical niche has multiple rows over time. `stable_id` is the
    // shared label that ties those rows together: it's minted once when a
    // cluster is born and inherited by future runs whose member-set Jaccard
    // overlap with the previous run is high enough.
    //
    //   stable_id          → identity that survives across runs
    //   parent_stable_id   → for splits: which old stable_id this one came from
    //
    // niche_cluster_events logs every birth/death/split/merge/grew/shrank
    // detected by the stitcher. Powers the lifecycle UI and the analytics
    // endpoints under /api/niche-spy/cluster/control.
    await client.query(`ALTER TABLE niche_tree_clusters ADD COLUMN IF NOT EXISTS stable_id TEXT`).catch(() => {});
    await client.query(`ALTER TABLE niche_tree_clusters ADD COLUMN IF NOT EXISTS parent_stable_id TEXT`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ntc_stable_id ON niche_tree_clusters(stable_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ntc_parent_stable ON niche_tree_clusters(parent_stable_id)`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_cluster_events (
        id BIGSERIAL PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES niche_tree_runs(id) ON DELETE CASCADE,
        stable_id TEXT NOT NULL,
        parent_stable_id TEXT,
        event TEXT NOT NULL,             -- born | grew | shrank | split | merged | died | same
        level INTEGER NOT NULL,
        size_before INTEGER,
        size_after INTEGER,
        jaccard REAL,                    -- match score against predecessor (NULL for born)
        payload JSONB,
        detected_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nce_run ON niche_cluster_events(run_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nce_stable ON niche_cluster_events(stable_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nce_event ON niche_cluster_events(event)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nce_detected ON niche_cluster_events(detected_at DESC)`).catch(() => {});

    // Video-seed niche discovery — replacement for the per-keyword Gemini
    // scoring loop. xgodo agents POST a seed video + candidate URLs
    // (typically pulled from the seed's YT "suggested" panel); we fetch
    // their titles/thumbnails, embed via combined_v2, cosine-compare
    // against the seed, and log every (seed, candidate, similarity)
    // tuple here. The admin UI polls this table to render a live feed.
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_seed_expansions (
        id BIGSERIAL PRIMARY KEY,
        seed_video_id INTEGER,                -- niche_spy_videos.id of the seed (null until ingested)
        seed_url TEXT,                        -- canonical seed URL (always set)
        candidate_video_id INTEGER,           -- niche_spy_videos.id of the candidate (null on fail)
        candidate_url TEXT NOT NULL,
        candidate_title TEXT,
        candidate_thumbnail TEXT,
        similarity REAL,                      -- cosine(seed, candidate) in combined_v2; null if either failed to embed
        matched BOOLEAN NOT NULL DEFAULT FALSE, -- passed the threshold/topK of the originating request
        threshold REAL,                       -- the threshold used for this request (null if topK)
        rank_in_batch INTEGER,                -- 1-based rank within the candidate set
        task_id TEXT,                         -- xgodo task that submitted this (for filtering in the admin feed)
        keyword TEXT,                         -- optional niche label the operator supplies for grouping
        error_message TEXT,                   -- non-null if we couldn't fetch/embed the candidate
        detected_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nse_detected ON niche_seed_expansions(detected_at DESC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nse_task ON niche_seed_expansions(task_id, detected_at DESC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nse_seed ON niche_seed_expansions(seed_video_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nse_matched ON niche_seed_expansions(matched, detected_at DESC)`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_tree_assignments (
        id SERIAL PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES niche_tree_runs(id) ON DELETE CASCADE,
        video_id INTEGER NOT NULL,
        cluster_id INTEGER REFERENCES niche_tree_clusters(id) ON DELETE CASCADE,
        cluster_index INTEGER NOT NULL,
        x_2d REAL,
        y_2d REAL,
        distance_to_centroid REAL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nta_run     ON niche_tree_assignments(run_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nta_cluster ON niche_tree_assignments(cluster_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nta_video   ON niche_tree_assignments(video_id)`).catch(() => {});

    // Google API key inventory — sourced from xgodo workers (the
    // youtubeApiKeyJob / googleAiStudioKeyJob proofs) plus any legacy
    // keys migrated out of the admin_config newline-string. One row per
    // (service, key); `service` scopes which API the key targets.
    //
    // No device/worker columns: routing uses the round-robin USA proxy
    // pool, not per-device pairing, and the worker name is just xgodo
    // bookkeeping noise. Status drives scheduling:
    //   active            → eligible for the round-robin pool
    //   banned (with banned_until in future) → temporarily skipped (5-min 429/403 cooloff)
    //   invalid           → key never worked (dropped permanently from rotation)
    //   disabled          → operator-disabled; manual re-enable
    await client.query(`
      CREATE TABLE IF NOT EXISTS xgodo_api_keys (
        id SERIAL PRIMARY KEY,
        service TEXT NOT NULL CHECK (service IN ('youtube_data', 'google_ai_studio')),
        key TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'xgodo',
        status TEXT NOT NULL DEFAULT 'active',
        banned_until TIMESTAMPTZ,
        invalidated_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (service, key)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_xak_service_status ON xgodo_api_keys(service, status)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_xak_banned_until ON xgodo_api_keys(banned_until) WHERE banned_until IS NOT NULL`).catch(() => {});

    // Agent task tracking — first-seen/last-seen per xgodo task
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_task_log (
        task_id TEXT PRIMARY KEY,
        keyword TEXT NOT NULL,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT DEFAULT 'running',
        worker_name TEXT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_atl_keyword ON agent_task_log(keyword)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_atl_status ON agent_task_log(status)`).catch(() => {});

    // Agent thread targets for the thermostat
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_thread_targets (
        id SERIAL PRIMARY KEY,
        keyword TEXT NOT NULL UNIQUE,
        target_threads INTEGER NOT NULL DEFAULT 0,
        last_deployed_at TIMESTAMPTZ,
        last_checked_at TIMESTAMPTZ,
        active_threads INTEGER DEFAULT 0,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Agent planned-task pins — when the scheduler routes a planned task
    // to a specific worker device (so the agent can skip its
    // browser-data wipe and continue researching where it left off), we
    // track the pin here. Used for two things:
    //   1. Don't double-pin the same warm device on the next tick
    //   2. Zombie sweep — if a pinned device drops off the market list
    //      we delete the planned task so xgodo isn't sitting on it
    //      forever, and the thermostat re-deploys on the next tick.
    // Rows are removed when their planned_task_id leaves xgodo's
    // unassigned planned-tasks list (= got picked up, or was deleted).
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_planned_pins (
        planned_task_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        keyword TEXT NOT NULL,
        device_name TEXT NOT NULL,
        device_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_app_keyword ON agent_planned_pins(keyword)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_app_device  ON agent_planned_pins(device_name)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_app_created ON agent_planned_pins(created_at)`).catch(() => {});

    // Semantic search query log — every text query that hits the
    // /api/niche-spy/search-semantic endpoint gets stored here with its
    // embedding. Two purposes:
    //   1. Cache: same query string → reuse the cached vector instead of
    //      re-embedding. Free-tier keys are abundant but query latency
    //      drops from ~1s (Gemini call) to ~0ms (DB hit).
    //   2. Analytics / future suggestions: cluster the saved queries to
    //      find demand patterns, surface popular searches, etc.
    // Embedding is stored as REAL[] in the main DB and mirrored to the
    // pgvector DB if/when we want similarity-on-queries.
    await client.query(`
      CREATE TABLE IF NOT EXISTS search_queries (
        id SERIAL PRIMARY KEY,
        query TEXT NOT NULL UNIQUE,
        embedding REAL[],
        source TEXT NOT NULL DEFAULT 'combined_v2',
        hit_count INTEGER NOT NULL DEFAULT 1,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sq_last_seen ON search_queries(last_seen_at DESC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sq_hit_count ON search_queries(hit_count DESC)`).catch(() => {});

    // Vizard.ai clip generation — one project per submitted URL, many clips
    // per project. Polling is server-driven (see app/api/admin/vizard/tick),
    // so `status` tracks the lifecycle:
    //   pending    — submitted, Vizard returned 2000 or 1000, waiting for clips
    //   processing — Vizard returned 1000 on last poll
    //   done       — clips retrieved (videos array populated)
    //   error      — Vizard returned 4xxx or our submission failed
    await client.query(`
      CREATE TABLE IF NOT EXISTS vizard_projects (
        id SERIAL PRIMARY KEY,
        vizard_project_id TEXT UNIQUE,   -- nullable: set after create-call returns
        video_url TEXT NOT NULL,
        video_type INTEGER NOT NULL,     -- 1=mp4 url, 2=youtube, 3=drive, etc.
        lang TEXT DEFAULT 'auto',
        prefer_length INTEGER[] DEFAULT ARRAY[0],
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        last_code INTEGER,               -- last Vizard code seen (2000, 1000, 4xxx)
        clip_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_polled_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      )
    `).catch(() => {});
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_vizard_projects_status ON vizard_projects(status)`
    ).catch(() => {});

    // One row per clip Vizard produces. Stores the metadata + temporary
    // videoUrl (valid ~7 days per Vizard's docs). If we later re-host on our
    // Railway Volume for xgodo handoff, the path goes in local_path.
    await client.query(`
      CREATE TABLE IF NOT EXISTS vizard_clips (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES vizard_projects(id) ON DELETE CASCADE,
        vizard_video_id TEXT,            -- Vizard's videoId; unique per clip
        video_url TEXT,                  -- temporary download url (7-day expiry)
        duration_ms BIGINT,
        title TEXT,
        transcript TEXT,
        viral_score TEXT,                -- Vizard returns as string "0"–"10"
        viral_reason TEXT,
        related_topic TEXT,              -- stringified JSON array
        clip_editor_url TEXT,
        local_path TEXT,                 -- filled if we re-host to Railway volume
        xgodo_upload_status TEXT,        -- null | pending | sent | failed
        xgodo_upload_id TEXT,            -- xgodo's ID once uploaded
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_vizard_clips_project ON vizard_clips(project_id)`
    ).catch(() => {});
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_vizard_clips_vizard_video_id ON vizard_clips(vizard_video_id) WHERE vizard_video_id IS NOT NULL`
    ).catch(() => {});

    // YT-upload reporting columns. xgodo_upload_id was created originally as
    // a generic "xgodo's ID" — repurpose it as the planned_task_id we get
    // back from /planned_tasks/submit. Everything else is filled by the cron
    // poller as the worker progresses through pickup → upload → confirmation.
    //
    // Status state machine:
    //   queued    – task submitted to xgodo, no worker assigned yet
    //   running   – worker picked it up, upload in progress
    //   uploaded  – worker submitted with YT URL (xgodo status='pending')
    //   confirmed – employer reviewed and accepted (xgodo status='confirmed')
    //   failed    – worker reported failure
    //   declined  – employer rejected the submission
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_job_task_id TEXT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_device_id TEXT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_device_name TEXT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_worker_id TEXT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_worker_name TEXT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_submitted_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_started_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_finished_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_last_polled_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_error TEXT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS youtube_url TEXT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS upload_title TEXT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS upload_description TEXT`).catch(() => {});
    // Live view-count tracking via YouTube Data API. Refreshed on demand from
    // the Vizard tab. youtube_video_id is the 11-char YT ID extracted from
    // youtube_url so we can batch up to 50 IDs per videos.list call.
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS youtube_video_id TEXT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS youtube_view_count BIGINT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS youtube_like_count BIGINT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS youtube_comment_count BIGINT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS youtube_views_fetched_at TIMESTAMPTZ`).catch(() => {});
    // Worker-side failure detail. xgodo attaches a `comment` (e.g. "CRASH",
    // "Login required", etc.) and a screenshot URL when a task fails during
    // execution. We surface both in the Uploads UI until the user retries.
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_failure_comment TEXT`).catch(() => {});
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_failure_screenshot_url TEXT`).catch(() => {});
    // YT account that uploaded this clip — captured from xgodo's job_proof.
    // Each device hosts one or more gmails, and (per current setup) each
    // gmail has exactly one YT channel. We use account_email as the join
    // key to vizard_yt_accounts for channel-level stats.
    await client.query(`ALTER TABLE vizard_clips ADD COLUMN IF NOT EXISTS xgodo_account_email TEXT`).catch(() => {});
    // Pull poll work efficiently: index in-flight tasks by status + last poll.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_vizard_clips_upload_status_polled
       ON vizard_clips(xgodo_upload_status, xgodo_last_polled_at NULLS FIRST)`
    ).catch(() => {});
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_vizard_clips_account_email
       ON vizard_clips(xgodo_account_email) WHERE xgodo_account_email IS NOT NULL`
    ).catch(() => {});

    // Per-account channel stats — gmail → YT channel → subs/views.
    // Refreshed via the same Data API + key/proxy pool used for clip-view
    // refresh. Resolved by taking any uploaded clip for the account, looking
    // up videos.list to get channelId, then channels.list for stats.
    await client.query(`
      CREATE TABLE IF NOT EXISTS vizard_yt_accounts (
        account_email     TEXT PRIMARY KEY,
        channel_id        TEXT,
        channel_title     TEXT,
        custom_url        TEXT,
        subscriber_count  BIGINT,
        view_count        BIGINT,
        video_count       INTEGER,
        fetched_at        TIMESTAMPTZ,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vya_channel_id ON vizard_yt_accounts(channel_id) WHERE channel_id IS NOT NULL`).catch(() => {});

    // Background-job tracking for the "refresh all view counts" admin
    // action. Lets the threaded worker persist progress so the agent
    // endpoint (and the UI) can poll instead of relying on a long-lived
    // SSE stream that breaks on any network blip.
    //
    // Status state machine:
    //   running    – worker pool is processing batches
    //   done       – every batch finished (errors are counted, not fatal)
    //   error      – fatal error before any batch ran (e.g. no keys)
    //   cancelled  – DELETE on the agent endpoint flipped it; workers stop
    //                between batches
    // Background-job tracking for the Outlier Pipeline channel
    // enrichment (playlistItems + videos.list per channel). Same shape
    // as vizard_refresh_jobs so the agent endpoint can render and
    // poll a single uniform status.
    await client.query(`
      CREATE TABLE IF NOT EXISTS outlier_enrich_jobs (
        id                 SERIAL PRIMARY KEY,
        status             TEXT NOT NULL DEFAULT 'running',
        threads            INTEGER NOT NULL DEFAULT 10,
        max_videos         INTEGER NOT NULL DEFAULT 30,
        stale_days         INTEGER NOT NULL DEFAULT 7,
        force              BOOLEAN NOT NULL DEFAULT FALSE,
        target_channels    INTEGER NOT NULL DEFAULT 0,
        processed          INTEGER NOT NULL DEFAULT 0,
        with_stats         INTEGER NOT NULL DEFAULT 0,
        errors             INTEGER NOT NULL DEFAULT 0,
        api_calls          INTEGER NOT NULL DEFAULT 0,
        indefinite         BOOLEAN NOT NULL DEFAULT FALSE,
        loops              INTEGER NOT NULL DEFAULT 0,
        error_message      TEXT,
        started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at       TIMESTAMPTZ,
        last_progress_at   TIMESTAMPTZ
      )
    `);
    await client.query(`ALTER TABLE outlier_enrich_jobs ADD COLUMN IF NOT EXISTS indefinite BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
    await client.query(`ALTER TABLE outlier_enrich_jobs ADD COLUMN IF NOT EXISTS loops INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oej_status ON outlier_enrich_jobs(status, started_at DESC)`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS vizard_refresh_jobs (
        id                 SERIAL PRIMARY KEY,
        status             TEXT NOT NULL DEFAULT 'running',
        threads            INTEGER NOT NULL DEFAULT 10,
        total_clips        INTEGER NOT NULL DEFAULT 0,
        total_batches      INTEGER NOT NULL DEFAULT 0,
        completed_batches  INTEGER NOT NULL DEFAULT 0,
        updated            INTEGER NOT NULL DEFAULT 0,
        errors             INTEGER NOT NULL DEFAULT 0,
        calls              INTEGER NOT NULL DEFAULT 0,
        force              BOOLEAN NOT NULL DEFAULT FALSE,
        stale_minutes      INTEGER,
        clip_ids           INTEGER[],
        error_message      TEXT,
        started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at       TIMESTAMPTZ,
        last_progress_at   TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vrj_status ON vizard_refresh_jobs(status, started_at DESC)`).catch(() => {});

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
