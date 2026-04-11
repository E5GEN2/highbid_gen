/**
 * Shared formatting utilities used across product pages.
 */

/** Format numbers YouTube-style: 1530000 → "1.5M", 23475 → "23K", 601 → "601" */
export const fmtYT = (n: number): string => {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
};

/** Check if a URL points to a video file */
export const isVideoFile = (url: string): boolean => {
  const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
  const lowerUrl = url.toLowerCase();
  return videoExtensions.some(ext => lowerUrl.includes(ext));
};

/** Calculate number of image columns needed based on audio duration */
export const calculateImageColumns = (durationSeconds: number): number => {
  if (!durationSeconds) return 1;
  return Math.max(1, Math.ceil(durationSeconds / 2));
};
