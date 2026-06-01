/**
 * Where xg vid download writes its mp4s.
 *
 * In production this points at the Railway volume (/data/xg_videos) so
 * files survive redeploys; on a dev box it falls back to /tmp/xg_videos
 * which is good enough for poking the pipeline locally. Mirrors the
 * CLIPS_DIR pattern in lib/clips-dir.ts.
 */
export const XG_VIDEOS_DIR = process.env.XG_VIDEOS_DIR || '/data/xg_videos';
