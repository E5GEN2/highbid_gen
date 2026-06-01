/**
 * Where xg vid download writes its mp4s.
 *
 * The Railway volume is mounted at /data/clips on this service (env:
 * RAILWAY_VOLUME_MOUNT_PATH), so we nest under it instead of trying to
 * write to /data directly — anything outside the mount disappears on
 * redeploy. Override via XG_VIDEOS_DIR if you mount a dedicated volume.
 */
export const XG_VIDEOS_DIR = process.env.XG_VIDEOS_DIR || '/data/clips/xg_videos';
