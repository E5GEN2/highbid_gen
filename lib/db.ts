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
    // Channel-level total view count (statistics.viewCount from YT Data API).
    // Different from recent_videos_avg_views * video_count which was a rough
    // approximation. Needed for MG-style "X,XXX,XXX views" narration to
    // match what the about modal screenshot actually shows.
    await client.query(`ALTER TABLE niche_spy_channels ADD COLUMN IF NOT EXISTS total_views BIGINT`).catch(() => {});
    await client.query(`ALTER TABLE niche_spy_channels ADD COLUMN IF NOT EXISTS stats_refreshed_at TIMESTAMPTZ`).catch(() => {});

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

    // Embedding requests — when a user wants to cluster a custom niche
    // by an embedding source (title_v2 / thumbnail_v2 / combined_v2)
    // that isn't yet computed for enough videos in the niche, they
    // file a request. Admin sees the request in a dedicated tab and
    // can kick off the embedding job. Once done, the user can come
    // back and cluster.
    await client.query(`
      CREATE TABLE IF NOT EXISTS embedding_requests (
        id SERIAL PRIMARY KEY,
        custom_niche_id INTEGER NOT NULL REFERENCES custom_niches(id) ON DELETE CASCADE,
        source TEXT NOT NULL,                  -- 'title_v2' | 'thumbnail_v2' | 'combined_v2'
        video_ids INTEGER[] NOT NULL,          -- specific unembedded videos at request time
        video_count INTEGER NOT NULL,          -- length(video_ids) cached for the admin list
        requested_by TEXT,                     -- api_tokens.id or session user id
        requester_label TEXT,                  -- human label (token name, email, etc.) for the admin UI
        status TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'processing' | 'done' | 'failed' | 'dismissed'
        note TEXT,                             -- admin / system notes
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_embreq_pending ON embedding_requests(created_at DESC) WHERE status = 'pending'`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_embreq_niche ON embedding_requests(custom_niche_id, source, created_at DESC)`).catch(() => {});
    // Live progress columns — updated after every batch by the
    // background worker (POST /process). Surfaces in the admin tab as
    // "Processing 24/62" while in flight.
    await client.query(`ALTER TABLE embedding_requests ADD COLUMN IF NOT EXISTS processed INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    await client.query(`ALTER TABLE embedding_requests ADD COLUMN IF NOT EXISTS errors INTEGER NOT NULL DEFAULT 0`).catch(() => {});

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
    // custom_niche_id is set for kind='custom_niche' runs — clustering
    // scoped to a single custom niche's videos. Reuses niche_tree_clusters
    // + niche_tree_assignments so the existing read path (with rep video
    // joins) works unchanged.
    await client.query(`ALTER TABLE niche_tree_runs ADD COLUMN IF NOT EXISTS custom_niche_id INTEGER`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ntr_kind ON niche_tree_runs(kind, started_at DESC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ntr_parent ON niche_tree_runs(parent_cluster_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ntr_custom_niche ON niche_tree_runs(custom_niche_id, started_at DESC) WHERE custom_niche_id IS NOT NULL`).catch(() => {});

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

    // Health-check runs — one row per yt-keys-health sweep. Lets
    // background sweeps be polled while in-flight and supervised
    // historically (pool composition trend, sweep cadence). The
    // sample_summary + db_updates JSON columns hold the per-run
    // tallies so we don't need a per-probe table.
    await client.query(`
      CREATE TABLE IF NOT EXISTS xgodo_key_health_runs (
        id SERIAL PRIMARY KEY,
        service TEXT NOT NULL,
        mode TEXT NOT NULL,                  -- 'sync' | 'background'
        status TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'done' | 'error'
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        target_limit INTEGER NOT NULL,
        concurrency INTEGER NOT NULL,
        dry_run BOOLEAN NOT NULL DEFAULT FALSE,
        probed INTEGER NOT NULL DEFAULT 0,
        sample_summary JSONB,                -- { working, quotaExceeded, suspended, network, other }
        db_updates JSONB,                    -- { activated, banned, invalidated }
        proxy_top_failures JSONB,            -- [{ proxyDeviceId, count }]
        error_message TEXT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_xkhr_started ON xgodo_key_health_runs(started_at DESC)`).catch(() => {});

    // Per-proxy health table — one row per xgodo device_id. Our
    // local view of which proxies are reliable; the proxy list
    // itself comes from xgodo (lib/xgodo-proxy.ts), so this is
    // strictly an annotation layer. The sweep updates this; the
    // proxy picker (Phase 2) reads it to skip dead devices.
    await client.query(`
      CREATE TABLE IF NOT EXISTS xgodo_proxy_health (
        device_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'unknown',
            -- 'healthy' | 'flaky' | 'dead' | 'unknown'
        last_checked_at TIMESTAMPTZ,
        banned_until TIMESTAMPTZ,
            -- when not null and > NOW, treat as dead for routing
        last_tries     INTEGER NOT NULL DEFAULT 0,
        last_successes INTEGER NOT NULL DEFAULT 0,
        total_tries     INTEGER NOT NULL DEFAULT 0,
        total_successes INTEGER NOT NULL DEFAULT 0,
        name TEXT,
        country TEXT,
        last_error TEXT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_xph_status ON xgodo_proxy_health(status)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_xph_banned_until ON xgodo_proxy_health(banned_until) WHERE banned_until IS NOT NULL`).catch(() => {});

    // Sweep-history table parallel to xgodo_key_health_runs.
    await client.query(`
      CREATE TABLE IF NOT EXISTS xgodo_proxy_health_runs (
        id SERIAL PRIMARY KEY,
        mode TEXT NOT NULL,                  -- 'sync' | 'background'
        status TEXT NOT NULL DEFAULT 'running',
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        target_total INTEGER NOT NULL,
        tries_per_proxy INTEGER NOT NULL,
        concurrency INTEGER NOT NULL,
        dry_run BOOLEAN NOT NULL DEFAULT FALSE,
        probed INTEGER NOT NULL DEFAULT 0,
        sample_summary JSONB,                -- { healthy, flaky, dead }
        db_updates JSONB,                    -- { newHealthy, newFlaky, newDead, recovered }
        error_message TEXT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_xphr_started ON xgodo_proxy_health_runs(started_at DESC)`).catch(() => {});

    // xg vid download pipeline. Bridges two xgodo jobs:
    //   review_job_id    — workers post videoUrl/remote_device_id as
    //                      job_proof; row status 'pending' = awaiting our
    //                      review. We pop those, schedule a download.
    //   download_job_id  — workers click the labs.google download button,
    //                      upload the mp4 to xgodo's /server/temp/ and
    //                      return prompt/model/uploadedUrl as job_proof.
    //
    // We then fetch the mp4 to the Railway volume, verify size>0, and
    // mark BOTH original xgodo tasks 'confirmed' (xgodo's term for
    // operator-satisfied). One DB row per review task — local_path
    // stamps when the file landed.
    await client.query(`
      CREATE TABLE IF NOT EXISTS xg_video_downloads (
        id SERIAL PRIMARY KEY,
        review_task_id TEXT NOT NULL UNIQUE,
            -- _id of the row from review_job_id (job 6a02e4e48c…)
        review_job_id TEXT NOT NULL,
        review_worker_name TEXT,
        source_video_url TEXT NOT NULL,
            -- the labs.google/fx/.../shared/video/... URL
        remote_device_id TEXT,
            -- captured from the review task's job_proof
        download_task_id TEXT,
            -- planned_task_id we get back when we submit to job
            -- 6a12c740d914a97f7c2bd0db. NULL until first submit.
        download_job_id TEXT,
        prompt TEXT,
            -- captured from the download task's job_proof on success
        model TEXT,
            -- e.g. "Veo 3.1 - Lite"
        uploaded_url TEXT,
            -- xgodo.com/server/temp/... URL the worker uploaded to
        local_path TEXT,
            -- absolute path on the Railway volume after we fetched it
        file_bytes BIGINT,
            -- size in bytes from the on-disk file (sanity for >0 check)
        status TEXT NOT NULL DEFAULT 'queued',
            -- 'queued'     | 'submitted'  | 'running' | 'downloaded'
            -- | 'confirmed' | 'failed'    | 'gone'
        error_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        submitted_at TIMESTAMPTZ,
        last_polled_at TIMESTAMPTZ,
        downloaded_at TIMESTAMPTZ,
        confirmed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_xvd_status ON xg_video_downloads(status)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_xvd_created ON xg_video_downloads(created_at DESC)`).catch(() => {});
    // Partial index for the worker queue — tiny, only covers in-flight
    // rows so the SKIP LOCKED claim stays O(active).
    await client.query(`CREATE INDEX IF NOT EXISTS idx_xvd_inflight ON xg_video_downloads(id) WHERE status IN ('queued','submitted','running','downloaded')`).catch(() => {});
    // Resubmission counter for the worker-side terminal recovery flow
    // (xgodo task failed/declined → submit a fresh task with a new
    // worker). Different lifecycle from `attempts` (which tracks
    // total claims). Capped in lib/xg-vid-download.ts so a fundamentally
    // broken input doesn't loop forever.
    await client.query(`ALTER TABLE xg_video_downloads ADD COLUMN IF NOT EXISTS resubmissions INTEGER NOT NULL DEFAULT 0`).catch(() => {});

    // Video-prompt queue — the "Vid Gen" admin tool fills this with
    // either manually-added or AI-generated short video prompts;
    // GET /api/video_prompt pops one at a time for client consumers.
    // served_at NULL = still available; non-null = already popped.
    // Keep served rows around so we have an audit trail of what's
    // been handed out. UNIQUE on prompt prevents identical duplicates
    // from AI generation runs.
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_prompts (
        id SERIAL PRIMARY KEY,
        prompt TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL DEFAULT 'manual',
            -- 'manual' | 'ai-generated'
        generation_meta JSONB,
            -- { batch_id, model, theme, etc. }
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        served_at TIMESTAMPTZ,
        served_to TEXT
            -- token id or 'anonymous' for whoever popped this
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vp_available ON video_prompts(id) WHERE served_at IS NULL`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vp_created ON video_prompts(created_at DESC)`).catch(() => {});

    // Reservation columns for visibility-timeout pop semantics. When a
    // client pops with ?reservable=1, we stamp served_at + claim_token
    // but DON'T treat the prompt as finally consumed until POST
    // /api/video_prompt/confirm comes back with the matching token. If
    // the client never confirms, the picker considers the prompt
    // available again after RESERVATION_TIMEOUT minutes — fixing the
    // "client popped 350 prompts, only generated 15 videos, the rest
    // are lost" scenario the operator hit on production.
    await client.query(`ALTER TABLE video_prompts ADD COLUMN IF NOT EXISTS claim_token TEXT`).catch(() => {});
    await client.query(`ALTER TABLE video_prompts ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE video_prompts ADD COLUMN IF NOT EXISTS confirmation_meta JSONB`).catch(() => {});
    // Partial index so confirm lookups stay O(1) — claim_token is a
    // UUID, never collides across active reservations.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vp_claim_token ON video_prompts(claim_token) WHERE claim_token IS NOT NULL AND confirmed_at IS NULL`).catch(() => {});
    // One-shot backfill: every row served before reservation existed
    // was implicitly "confirmed" (the old GET marked-and-consumed
    // atomically). Without this fill-in, the new picker would treat
    // those legacy-served rows as expired-reservations after 5min and
    // hand them out a second time. Idempotent — the WHERE clause skips
    // rows we already touched on a previous boot.
    await client.query(`
      UPDATE video_prompts
         SET confirmed_at = served_at
       WHERE served_at IS NOT NULL
         AND confirmed_at IS NULL
         AND claim_token IS NULL
    `).catch(() => {});

    // Vid Gen runs — durable log of every AI-generation kick-off.
    // Background mode would otherwise be a black box; this gives the
    // UI something to poll + the operator something to debug. Row is
    // created up front, then continuously updated as batches finish.
    await client.query(`
      CREATE TABLE IF NOT EXISTS vid_gen_runs (
        id UUID PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'running',
            -- 'running' | 'done' | 'failed'
        mode TEXT NOT NULL,
            -- 'sync' | 'background'
        count_requested INT NOT NULL,
        count_generated INT NOT NULL DEFAULT 0,
        count_inserted INT NOT NULL DEFAULT 0,
        count_duplicates INT NOT NULL DEFAULT 0,
        batches_total INT NOT NULL DEFAULT 0,
        batches_failed INT NOT NULL DEFAULT 0,
        theme TEXT,
        model TEXT NOT NULL,
        last_error TEXT,
        concurrency INT NOT NULL DEFAULT 1
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vgr_started ON vid_gen_runs(started_at DESC)`).catch(() => {});

    // Vid Gen settings — single-row config table for global suffix
    // that gets appended at serve time (e.g. ", photoreal, cinematic
    // 8k"). Storing this separately from the prompt rows means we
    // can toggle/edit it without touching every existing prompt and
    // it applies instantly to the next pop.
    // The CHECK (id = 1) enforces single-row semantics so we never
    // accidentally end up with multiple competing config rows.
    await client.query(`
      CREATE TABLE IF NOT EXISTS vid_gen_settings (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        suffix TEXT NOT NULL DEFAULT '',
        suffix_enabled BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO vid_gen_settings (id) VALUES (1) ON CONFLICT DO NOTHING`).catch(() => {});
    // Auto-refill: keep the queue topped up automatically. When a client
    // pop drops the available count under auto_refill_threshold we
    // fire a background generation of auto_refill_target prompts steered
    // by auto_theme. See lib/vid-gen-runner.ts triggerAutoRefillIfNeeded.
    await client.query(`ALTER TABLE vid_gen_settings ADD COLUMN IF NOT EXISTS auto_theme TEXT NOT NULL DEFAULT ''`).catch(() => {});
    await client.query(`ALTER TABLE vid_gen_settings ADD COLUMN IF NOT EXISTS auto_refill_enabled BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
    await client.query(`ALTER TABLE vid_gen_settings ADD COLUMN IF NOT EXISTS auto_refill_threshold INT NOT NULL DEFAULT 500`).catch(() => {});
    await client.query(`ALTER TABLE vid_gen_settings ADD COLUMN IF NOT EXISTS auto_refill_target INT NOT NULL DEFAULT 500`).catch(() => {});

    // Target generation model — the model the CLIENT will use to render
    // the video from each prompt (Veo Lite vs. Veo Omni). Independent
    // of the LLM that wrote the prompt. Stamped onto every new prompt
    // row at insert time so clients see it as part of /api/video_prompt's
    // response and can route to the right pipeline.
    await client.query(`ALTER TABLE vid_gen_settings ADD COLUMN IF NOT EXISTS target_model TEXT NOT NULL DEFAULT 'veo-omni'`).catch(() => {});
    await client.query(`ALTER TABLE video_prompts    ADD COLUMN IF NOT EXISTS target_model TEXT NOT NULL DEFAULT 'veo-omni'`).catch(() => {});

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

    // ── Seed-mode agents (video-URL niche discovery) ──────────────────
    // The xgodo niche-spy bot can now start from a SEED VIDEO URL instead
    // of a keyword. Multiple seed URLs that belong to the same niche share
    // a rofe-generated `nicheId`. agent_niches maps that nicheId to a
    // human label so the monitor can show "Sumerian tablets" rather than
    // the opaque id. The deploy carries nicheId in the xgodo task input
    // (alongside seedUrl); everything keyword-keyed elsewhere uses nicheId
    // as the grouping key for seed tasks.
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_niches (
        niche_id     TEXT PRIMARY KEY,
        label        TEXT NOT NULL,
        created_from TEXT DEFAULT 'manual',   -- manual | novelty_seed | content_gen
        seed_urls    TEXT[] DEFAULT '{}',      -- distinct seed URLs deployed under this niche
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Seed-mode additive columns on the existing agent tables. The
    // `keyword` column on these tables holds the WORK-UNIT KEY — the
    // keyword for keyword tasks, the nicheId for seed tasks. seed_url +
    // kind are carried for display / traceability. All nullable so
    // existing keyword rows are untouched.
    await client.query(`ALTER TABLE agent_task_log     ADD COLUMN IF NOT EXISTS kind     TEXT DEFAULT 'keyword'`).catch(() => {});
    await client.query(`ALTER TABLE agent_task_log     ADD COLUMN IF NOT EXISTS seed_url TEXT`).catch(() => {});
    await client.query(`ALTER TABLE agent_planned_pins ADD COLUMN IF NOT EXISTS seed_url TEXT`).catch(() => {});
    await client.query(`ALTER TABLE agent_thread_targets ADD COLUMN IF NOT EXISTS kind     TEXT DEFAULT 'keyword'`).catch(() => {});
    await client.query(`ALTER TABLE agent_thread_targets ADD COLUMN IF NOT EXISTS seed_url TEXT`).catch(() => {});

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

    // Video Analysis pipeline — per-video job + per-clip child rows.
    // One job = one YouTube URL through: download → split into ~60s
    // clips → analyze each clip via Gemini 2.5 Flash (Google AI Studio
    // keys + our proxy pool) → collapse per-clip JSONs into a single
    // per-video timeline. Clip-level rows let us track per-clip retries
    // independently and resume after partial failures without re-paying
    // for already-successful clips.
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_analysis_jobs (
        id                       SERIAL PRIMARY KEY,
        video_id                 INTEGER REFERENCES niche_spy_videos(id) ON DELETE SET NULL,
        custom_niche_id          INTEGER REFERENCES custom_niches(id)    ON DELETE SET NULL,
        user_id                  UUID    REFERENCES users(id)            ON DELETE SET NULL,
        youtube_url              TEXT NOT NULL,
        source_video_title       TEXT,
        source_video_duration_s  REAL,
        source_mp4_path          TEXT,
        clips_dir                TEXT,
        num_clips                INTEGER NOT NULL DEFAULT 0,
        num_clips_done           INTEGER NOT NULL DEFAULT 0,
        num_clips_failed         INTEGER NOT NULL DEFAULT 0,
        clip_durations           REAL[],
        total_segments           INTEGER,
        timeline_jsonb           JSONB,
        -- status transitions: pending → downloading → splitting →
        -- analyzing → collapsing → done. error is terminal. cancelled
        -- is operator-initiated.
        status                   TEXT NOT NULL DEFAULT 'pending',
        stage                    TEXT,
        error_message            TEXT,
        error_category           TEXT,
        started_at               TIMESTAMPTZ,
        completed_at             TIMESTAMPTZ,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_progress_at         TIMESTAMPTZ
      )
    `);
    // Optional per-job transcription cap. NULL = no cap (legacy
    // analyze-vids behaviour: transcribe the whole video). Content-gen
    // sets this to 1800 (30 min) so we don't waste minutes transcribing
    // multi-hour loops (e.g. healing-music videos) when the first chunk
    // already carries all the signal meta-extraction needs.
    await client.query(`ALTER TABLE video_analysis_jobs ADD COLUMN IF NOT EXISTS max_duration_s INTEGER`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vaj_status      ON video_analysis_jobs(status, created_at DESC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vaj_niche       ON video_analysis_jobs(custom_niche_id, created_at DESC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vaj_user        ON video_analysis_jobs(user_id, created_at DESC)`).catch(() => {});
    // Used by enqueue to skip videos already analysed for the same
    // url+user combo so a "re-run niche" doesn't double-charge per
    // unchanged video. NOT unique — a job can be retried after a hard
    // failure, and re-running a niche after the video moved is allowed.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vaj_video_user  ON video_analysis_jobs(video_id, user_id, created_at DESC)`).catch(() => {});

    // Content-gen meta-extraction results. One row per channel — the
    // distilled, script-ready data inventory produced by running
    // extractChannelMeta() over the channel's top-video transcription.
    // niche_label replaces the garbage cluster auto-labels; recipe_formula
    // fills the script's recipe slot; language/is_faceless are metadata.
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_channel_analysis (
        channel_id        TEXT PRIMARY KEY,
        analyzed_video_id INTEGER,
        analysis_job_id   INTEGER,
        niche_label       TEXT,
        recipe_formula    TEXT,
        language          TEXT,
        is_faceless       BOOLEAN,
        production_format TEXT,
        voice_type        TEXT,
        content_summary   TEXT,
        confidence        REAL,
        analyzer_version  INTEGER NOT NULL DEFAULT 1,
        analyzed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    // Unified-analyzer additions (catalog breadth + provenance counts).
    await client.query(`ALTER TABLE content_gen_channel_analysis ADD COLUMN IF NOT EXISTS niche_summary TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_gen_channel_analysis ADD COLUMN IF NOT EXISTS breadth TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_gen_channel_analysis ADD COLUMN IF NOT EXISTS sampled_videos INTEGER`).catch(() => {});
    await client.query(`ALTER TABLE content_gen_channel_analysis ADD COLUMN IF NOT EXISTS sampled_thumbnails INTEGER`).catch(() => {});
    await client.query(`ALTER TABLE content_gen_channel_analysis ADD COLUMN IF NOT EXISTS sampled_transcripts INTEGER`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cgca_video ON content_gen_channel_analysis(analyzed_video_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cgca_language ON content_gen_channel_analysis(language)`).catch(() => {});

    // Per-niche RPM cache. Gemini estimates the YouTube AdSense RPM
    // (revenue per 1000 views, USD) for a niche + audience geography.
    // Money figures in generated scripts = rpm × views. Cached because
    // RPM is stable per niche category — re-estimate is cheap but we
    // don't want to pay it on every generation. Keyed on
    // (normalized niche, geo).
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_rpm_cache (
        niche_key    TEXT NOT NULL,
        geo          TEXT NOT NULL DEFAULT 'en',
        niche_label  TEXT,
        rpm_low      REAL,
        rpm_typical  REAL,
        rpm_high     REAL,
        reasoning    TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (niche_key, geo)
      )
    `).catch(() => {});

    // Per-CHANNEL RPM. More accurate than per-niche: RPM varies by the
    // channel's actual audience geo + content specifics, which the niche
    // label alone can't capture. Gemini reads the channel via url_context
    // grounding + our extracted context (niche, catalog titles, subs).
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_channel_rpm (
        channel_id   TEXT PRIMARY KEY,
        channel_url  TEXT,
        niche_label  TEXT,
        geo_guess    TEXT,
        rpm_low      REAL,
        rpm_typical  REAL,
        rpm_high     REAL,
        reasoning    TEXT,
        url_fetched  BOOLEAN,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    // grounded_on records what Gemini actually consumed for the estimate:
    // 'video' (watched the top video), 'context' (fell back to our
    // titles/niche), or 'url' (legacy url_context). video_url = the
    // watched video.
    await client.query(`ALTER TABLE content_gen_channel_rpm ADD COLUMN IF NOT EXISTS video_url TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_gen_channel_rpm ADD COLUMN IF NOT EXISTS grounded_on TEXT`).catch(() => {});

    // Stage D output — the generated, timestamped beat-by-beat narration
    // script for a GROUP of channels. Keyed by a stable group_key (sorted
    // channel_ids joined) so re-generating a group upserts. script_jsonb
    // holds the full { intro, niches[], cta, meta } object.
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_scripts (
        group_key       TEXT PRIMARY KEY,
        channel_ids     TEXT[] NOT NULL,
        title           TEXT,
        script_jsonb    JSONB NOT NULL,
        model           TEXT,
        version         INTEGER,
        word_count      INTEGER,
        est_duration_s  INTEGER,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    // The compiled tri-track aud2vis timeline (MG transcript schema,
    // enriched into a render spec) lives alongside the narration script.
    await client.query(`ALTER TABLE content_gen_scripts ADD COLUMN IF NOT EXISTS timeline_jsonb JSONB`).catch(() => {});

    // The transcript-grounded "recipe showcase" — per channel, the paired
    // {narration, clip[t_start,t_end], shows} beats picked from the
    // channel's own aud/vis transcript(s). Drives the recipe_demo section:
    // the narrator explains HOW the channel makes content while we show the
    // exact clip moment that demonstrates each point. clip timestamps are
    // real (into source_video_id) so Stage E can extract them directly.
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_recipe_showcase (
        channel_id        TEXT PRIMARY KEY,
        source_video_ids  INTEGER[] NOT NULL,
        recipe_summary    TEXT,
        beats_jsonb       JSONB NOT NULL,
        n_beats           INTEGER,
        model             TEXT,
        version           INTEGER,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});

    // Image-generation tasks routed through xgodo's image-gen flow (the
    // same worker platform behind keys/proxies/vizard). One row per
    // requested image: {prompt, aspect, model} → a worker generates it and
    // returns a TEMP xgodo url (expires) which we download to the Railway
    // volume. Drives the on-demand icon/asset library for content-gen.
    //   status: queued | running | done | failed
    await client.query(`
      CREATE TABLE IF NOT EXISTS imagegen_tasks (
        id               SERIAL PRIMARY KEY,
        purpose          TEXT,                 -- free tag, e.g. 'icon:shrug_with_question_marks'
        prompt           TEXT NOT NULL,
        aspect           TEXT,                 -- '1:1' | '16:9' | '9:16'
        model            TEXT,                 -- 'nanobananapro' | 'nanobanana' | 'imagen4'
        status           TEXT NOT NULL DEFAULT 'queued',
        planned_task_id  TEXT,
        job_task_id      TEXT,
        xgodo_temp_url   TEXT,                 -- the expiring uploadedUrl
        expires_at       TIMESTAMPTZ,
        local_path       TEXT,                 -- downloaded file on the volume
        image_name       TEXT,
        worker_name      TEXT,
        device_id        TEXT,                 -- xgodo device that ran it (affinity routing)
        device_name      TEXT,
        pinned_device    TEXT,                 -- device we pinned this task to on submit (if any)
        retry_of         INTEGER,              -- imagegen_tasks.id this is a retry of
        error            TEXT,
        submitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at       TIMESTAMPTZ,
        finished_at      TIMESTAMPTZ,
        last_polled_at   TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    // Device-affinity columns (added after the table shipped) — we learn
    // which xgodo devices succeed at image-gen and pin future tasks to them.
    await client.query(`ALTER TABLE imagegen_tasks ADD COLUMN IF NOT EXISTS device_id TEXT`).catch(() => {});
    await client.query(`ALTER TABLE imagegen_tasks ADD COLUMN IF NOT EXISTS device_name TEXT`).catch(() => {});
    await client.query(`ALTER TABLE imagegen_tasks ADD COLUMN IF NOT EXISTS pinned_device TEXT`).catch(() => {});
    await client.query(`ALTER TABLE imagegen_tasks ADD COLUMN IF NOT EXISTS retry_of INTEGER`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_imagegen_status ON imagegen_tasks(status)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_imagegen_purpose ON imagegen_tasks(purpose)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_imagegen_device ON imagegen_tasks(device_name)`).catch(() => {});

    // Voice asset cache — every TTS'd phrase keyed by (text + voice + model +
    // settings) hash, so re-generating a script that reuses a sentence (e.g.
    // "from ads.") is a free disk lookup. The MP3 lives on the Railway
    // volume; duration_s is measured via ffprobe so timeline reflow knows
    // the EXACT spoken length, not an estimate.
    // SFX + music asset cache — every requested sound effect or music bed
    // keyed by (token + prompt + duration) hash, generated via ElevenLabs'
    // /v1/sound-generation. token is the symbolic name our timeline uses
    // ("whoosh", "ding_high_pitch", "intro", …) so we can later swap the
    // prompt for a token without changing callers.
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_sfx_assets (
        sfx_hash      TEXT PRIMARY KEY,
        token         TEXT NOT NULL,
        kind          TEXT NOT NULL,      -- 'sfx' | 'music'
        prompt        TEXT NOT NULL,
        duration_req  REAL NOT NULL,
        local_path    TEXT NOT NULL,
        duration_s    REAL,
        bytes         INTEGER,
        prompt_influence REAL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sfx_token ON content_gen_sfx_assets(token)`).catch(() => {});

    // YouTube-screen captures from Playwright. We screenshot real YT pages
    // through xgodo proxies (so subscriber counts / thumbnails are real and
    // geo-correct, per-channel rpm.geo when available). One row per
    // (channel_id, kind, date_bucket) — date_bucket lets us refresh stale
    // captures without losing the old PNG until the new one lands.
    //   kind: 'channel_page' | 'about_page' | 'videos_tab' | 'watch_page'
    //   status: 'pending' | 'capturing' | 'done' | 'failed'
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_yt_screens (
        id            SERIAL PRIMARY KEY,
        channel_id    TEXT NOT NULL,
        handle        TEXT,
        kind          TEXT NOT NULL,
        url           TEXT NOT NULL,
        geo           TEXT,
        date_bucket   TEXT NOT NULL,         -- YYYY-MM-DD; cache invalidates when bucket rolls
        status        TEXT NOT NULL DEFAULT 'pending',
        local_path    TEXT,                  -- PNG on the volume
        page_width    INTEGER,
        page_height   INTEGER,
        bytes         INTEGER,
        proxy_country TEXT,
        proxy_device  TEXT,
        error         TEXT,
        started_at    TIMESTAMPTZ,
        finished_at   TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_yt_screens_lookup ON content_gen_yt_screens(channel_id, kind, date_bucket)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yt_screens_status ON content_gen_yt_screens(status)`).catch(() => {});
    // asset_kind: 'image' (PNG screenshot) | 'video' (WebM/MP4 recording)
    // bboxes_jsonb: { element_name: {x,y,w,h} } — locations of subscriber
    //   count / total views / etc. so the renderer can place yellow circles
    //   in the exact right spot from a clean (unannotated) screenshot
    // capture_mode: 'static' (single screenshot) | 'scroll_record' (mp4 of
    //   panning the page — e.g. video grid for upload_rate)
    // duration_s: video length when asset_kind='video'
    await client.query(`ALTER TABLE content_gen_yt_screens ADD COLUMN IF NOT EXISTS asset_kind TEXT NOT NULL DEFAULT 'image'`).catch(() => {});
    await client.query(`ALTER TABLE content_gen_yt_screens ADD COLUMN IF NOT EXISTS capture_mode TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_gen_yt_screens ADD COLUMN IF NOT EXISTS duration_s REAL`).catch(() => {});
    await client.query(`ALTER TABLE content_gen_yt_screens ADD COLUMN IF NOT EXISTS bboxes_jsonb JSONB`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_voice_assets (
        text_hash    TEXT PRIMARY KEY,
        text         TEXT NOT NULL,
        voice_id     TEXT NOT NULL,
        model_id     TEXT NOT NULL,
        settings     JSONB,
        local_path   TEXT NOT NULL,
        duration_s   REAL,
        bytes        INTEGER,
        char_count   INTEGER,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    // Word-level timecodes from ElevenLabs /with-timestamps — drives the
    // continuous-narration slicing + MG-style word-by-word text reveal.
    await client.query(`ALTER TABLE content_gen_voice_assets ADD COLUMN IF NOT EXISTS alignment_jsonb JSONB`).catch(() => {});
    // Cross-video phrase-bank rotation history (script-skeleton variation
    // rules: avoid the last-50 used phrases per bank across generated videos).
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_phrase_history (
        id        SERIAL PRIMARY KEY,
        bank_id   TEXT NOT NULL,
        phrase    TEXT NOT NULL,
        video_id  TEXT,
        used_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_phrase_history_bank ON content_gen_phrase_history (bank_id, used_at DESC)`).catch(() => {});
    // Gemini-simplified one-clause recipe line ("This channel ___.") —
    // generated once per channel by niche-vars, cached here.
    await client.query(`ALTER TABLE content_gen_channel_analysis ADD COLUMN IF NOT EXISTS recipe_formula_simple TEXT`).catch(() => {});
    // Self-healing autopilot — every watchdog tick resets errored /
    // stuck / done-with-gaps jobs back to pending so by morning the
    // queue is 100% done without operator clicks. Capped at
    // MAX_AUTO_RETRIES so a genuinely-broken video (geo-blocked,
    // age-restricted, deleted) can't loop forever burning $.
    await client.query(`ALTER TABLE video_analysis_jobs ADD COLUMN IF NOT EXISTS auto_retry_count INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    await client.query(`ALTER TABLE video_analysis_jobs ADD COLUMN IF NOT EXISTS last_auto_retry_at TIMESTAMPTZ`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS video_analysis_clips (
        id                 SERIAL PRIMARY KEY,
        job_id             INTEGER NOT NULL REFERENCES video_analysis_jobs(id) ON DELETE CASCADE,
        clip_index         INTEGER NOT NULL,
        clip_path          TEXT,
        duration_s         REAL,
        size_bytes         BIGINT,
        -- status: pending → running → done|error
        status             TEXT NOT NULL DEFAULT 'pending',
        -- One element per HTTP attempt:
        --   { n, elapsed_s, category, http_status, detail }
        -- so the UI can render "ok on attempt 2 after 1 http_502".
        attempts           JSONB NOT NULL DEFAULT '[]'::jsonb,
        attempt_count      INTEGER NOT NULL DEFAULT 0,
        segments_jsonb     JSONB,
        segments_count     INTEGER,
        error_category     TEXT,
        error_detail       TEXT,
        -- Raw Gemini body cached when parse_error happens; otherwise NULL.
        -- Capped at 200KB at write time to avoid blowing the row.
        raw_debug_text     TEXT,
        elapsed_s          REAL,
        started_at         TIMESTAMPTZ,
        completed_at       TIMESTAMPTZ,
        UNIQUE (job_id, clip_index)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vac_job         ON video_analysis_clips(job_id, clip_index)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vac_status      ON video_analysis_clips(status)`).catch(() => {});

    // ──────────────────────────────────────────────────────────────
    // Producer — orchestrator that takes a ConcreteScript (from
    // script-writer) and drives every gem tool-call to produce a final
    // rendered mp4. Two tables:
    //   content_gen_producer_jobs — one row per render job
    //   content_gen_producer_gems — one row per (slot, gem) tool call
    // The gem table doubles as the live progress feed for the GUI.
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_producer_jobs (
        id              SERIAL PRIMARY KEY,
        channel_id      TEXT,
        channel_name    TEXT,
        niche_index     INTEGER,
        video_id        TEXT,
        -- 'pending' → 'running' → 'done' | 'failed' | 'cancelled'
        status          TEXT NOT NULL DEFAULT 'pending',
        -- Concrete script as authored by script-writer (kept verbatim
        -- for audit + retry).
        script_jsonb    JSONB NOT NULL,
        -- Final mp4 url after video_compose succeeds.
        final_video_url TEXT,
        -- Aggregate counts updated by the executor as gems progress.
        gems_total      INTEGER NOT NULL DEFAULT 0,
        gems_done       INTEGER NOT NULL DEFAULT 0,
        gems_failed     INTEGER NOT NULL DEFAULT 0,
        error           TEXT,
        started_at      TIMESTAMPTZ,
        finished_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cgpj_status ON content_gen_producer_jobs(status, updated_at DESC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cgpj_channel ON content_gen_producer_jobs(channel_id, created_at DESC)`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_producer_gems (
        id          SERIAL PRIMARY KEY,
        job_id      INTEGER NOT NULL REFERENCES content_gen_producer_jobs(id) ON DELETE CASCADE,
        slot_id     TEXT NOT NULL,
        slot_index  INTEGER NOT NULL,   -- 0..N-1 ordering inside the script
        gem_id      TEXT NOT NULL,      -- "narr" | "main" | "sfx" | ...
        tool        TEXT NOT NULL,      -- "tts" | "yt_capture" | ...
        args_jsonb  JSONB NOT NULL,
        -- Output of the tool — file_url + duration_s + bboxes etc. Schema
        -- matches the tool's OUTPUT_FIELDS in tools.ts.
        output_jsonb JSONB,
        -- 'pending' → 'running' → 'done' | 'failed' | 'skipped'
        status      TEXT NOT NULL DEFAULT 'pending',
        error       TEXT,
        elapsed_ms  INTEGER,
        started_at  TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (job_id, slot_id, gem_id)
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cgpg_job ON content_gen_producer_gems(job_id, slot_index, gem_id)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cgpg_status ON content_gen_producer_gems(status)`).catch(() => {});
    // Mark cache hits in the gems table so the GUI / execution graph can
    // show "cached" badges. Same status enum + new fields for diagnostics.
    await client.query(`ALTER TABLE content_gen_producer_gems ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN DEFAULT FALSE`).catch(() => {});
    await client.query(`ALTER TABLE content_gen_producer_gems ADD COLUMN IF NOT EXISTS cache_row_id INTEGER`).catch(() => {});

    // Tool-versioned asset cache. UNIQUE on args_hash so the same
    // (tool, version, args) combo across different jobs deduplicates.
    // Bumping a tool's version invalidates all rows tagged with the
    // previous version — the lookupCache call returns null on miss and
    // the old row gets overwritten via the ON CONFLICT path in storeCache.
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_tool_cache (
        id            SERIAL PRIMARY KEY,
        tool          TEXT NOT NULL,
        version       TEXT NOT NULL,
        args_hash     TEXT NOT NULL UNIQUE,
        output_jsonb  JSONB NOT NULL,
        asset_paths   TEXT[] NOT NULL DEFAULT '{}',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        hit_count     INTEGER NOT NULL DEFAULT 0
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cgtc_tool ON content_gen_tool_cache(tool, version, last_used_at DESC)`).catch(() => {});

    // Runtime version overrides for the tool cache. When a row exists for a
    // tool, the cache lookup uses (static_version + ":" + suffix) as the
    // version segment of args_hash — so changing the suffix is a namespace
    // bump. Old cache rows under the previous suffix stay on disk (good:
    // rollback = DELETE the override); a fresh render repopulates the new
    // namespace. The admin GUI's "Bump version" button writes here.
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_tool_version_overrides (
        tool       TEXT PRIMARY KEY,
        suffix     TEXT NOT NULL,
        bumped_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});

    // Execution graph — per-render node + edge log for the live "Execution"
    // tab in the producer admin. Nodes are appended as the producer runs;
    // the UI fetches them via /api/admin/content-gen/producer/graph and
    // renders a top-to-bottom DAG.
    //
    // node_type: writer | slot | gem | tool_call | cache_hit | db_save | compose
    // status:    pending | running | done | failed | cached
    // payload:   freeform per-type metadata (writer beats, gem args summary,
    //            cache origin row_id, asset paths, error message, etc.)
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_producer_graph_nodes (
        id          SERIAL PRIMARY KEY,
        job_id      INTEGER NOT NULL REFERENCES content_gen_producer_jobs(id) ON DELETE CASCADE,
        node_key    TEXT NOT NULL,          -- stable per-(job,role) id used for upserts (e.g. "gem:slot_1:main")
        node_type   TEXT NOT NULL,
        label       TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        payload     JSONB,
        started_at  TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (job_id, node_key)
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cgpgn_job ON content_gen_producer_graph_nodes(job_id, id ASC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cgpgn_updated ON content_gen_producer_graph_nodes(job_id, updated_at DESC)`).catch(() => {});

    // Edges: from_node_key → to_node_key. kind = 'depends_on' | 'output_of' | 'sequence' | 'compose_input'
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_gen_producer_graph_edges (
        id          SERIAL PRIMARY KEY,
        job_id      INTEGER NOT NULL REFERENCES content_gen_producer_jobs(id) ON DELETE CASCADE,
        from_key    TEXT NOT NULL,
        to_key      TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'sequence',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (job_id, from_key, to_key, kind)
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cgpge_job ON content_gen_producer_graph_edges(job_id, id ASC)`).catch(() => {});

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
