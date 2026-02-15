import path from 'path';
import fs from 'fs';

const RENDERS_DIR = path.join(process.cwd(), 'tmp', 'renders');

let bundleLocationPromise: Promise<string> | null = null;

function ensureRendersDir() {
  if (!fs.existsSync(RENDERS_DIR)) {
    fs.mkdirSync(RENDERS_DIR, { recursive: true });
  }
}

export async function getBundleLocation(): Promise<string> {
  if (!bundleLocationPromise) {
    bundleLocationPromise = (async () => {
      const { bundle } = await import('@remotion/bundler');
      const entryPoint = path.join(process.cwd(), 'remotion', 'Root.tsx');

      if (!fs.existsSync(entryPoint)) {
        throw new Error(`Remotion entry point not found: ${entryPoint}`);
      }

      console.log(`Bundling Remotion from ${entryPoint}...`);
      const bundled = await bundle({
        entryPoint,
        webpackOverride: (config) => config,
      });
      console.log('Remotion bundle ready:', bundled);
      return bundled;
    })().catch((err) => {
      // Reset so next attempt can retry
      bundleLocationPromise = null;
      throw err;
    });
  }
  return bundleLocationPromise;
}

export function invalidateBundle() {
  bundleLocationPromise = null;
}

export async function renderComposition(
  compositionId: string,
  inputProps: Record<string, unknown>,
  jobId: string,
  onProgress?: (progress: number) => void,
): Promise<string> {
  ensureRendersDir();

  const outputPath = path.join(RENDERS_DIR, `${jobId}.mp4`);

  console.log(`[render ${jobId}] Starting bundle...`);
  const bundleLocation = await getBundleLocation();
  console.log(`[render ${jobId}] Bundle ready, selecting composition ${compositionId}...`);

  const { selectComposition, renderMedia } = await import('@remotion/renderer');

  const browserExecutable = process.env.REMOTION_CHROME_EXECUTABLE || null;

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: compositionId,
    inputProps,
  });

  console.log(`[render ${jobId}] Composition selected, rendering ${composition.durationInFrames} frames...`);

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps,
    browserExecutable,
    chromiumOptions: {
      disableWebSecurity: true,
      gl: 'angle',
    },
    onProgress: ({ progress }) => {
      onProgress?.(Math.round(progress * 100));
    },
  });

  console.log(`[render ${jobId}] Done: ${outputPath}`);
  return outputPath;
}

export function getRenderedVideoPath(jobId: string): string | null {
  const outputPath = path.join(RENDERS_DIR, `${jobId}.mp4`);
  if (fs.existsSync(outputPath)) {
    return outputPath;
  }
  return null;
}
