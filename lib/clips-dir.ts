/**
 * Central clips directory config.
 * Uses CLIPS_DIR env var if set (Railway Volume), falls back to /tmp/clips.
 */
export const CLIPS_DIR = process.env.CLIPS_DIR || '/tmp/clips';
