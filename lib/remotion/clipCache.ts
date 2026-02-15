import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'tmp', 'clip-cache');
const MAX_CACHE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

export function getCachedClip(videoId: string): string | null {
  const filePath = path.join(CACHE_DIR, `${videoId}.mp4`);
  if (fs.existsSync(filePath)) {
    // Touch mtime for LRU
    const now = new Date();
    fs.utimesSync(filePath, now, now);
    return filePath;
  }
  return null;
}

export function getCachePath(videoId: string): string {
  ensureCacheDir();
  return path.join(CACHE_DIR, `${videoId}.mp4`);
}

export function getThumbnailFallback(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

export async function evictIfNeeded(): Promise<void> {
  ensureCacheDir();

  const files = fs.readdirSync(CACHE_DIR)
    .map(name => {
      const filePath = path.join(CACHE_DIR, name);
      const stat = fs.statSync(filePath);
      return { name, filePath, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime); // oldest first

  let totalSize = files.reduce((sum, f) => sum + f.size, 0);

  // Evict oldest files until under limit
  for (const file of files) {
    if (totalSize <= MAX_CACHE_SIZE_BYTES) break;
    try {
      fs.unlinkSync(file.filePath);
      totalSize -= file.size;
      console.log(`Evicted cached clip: ${file.name}`);
    } catch {
      // ignore
    }
  }
}
