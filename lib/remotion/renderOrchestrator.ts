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
      console.log('Bundling Remotion compositions...');
      const bundled = await bundle({
        entryPoint,
        webpackOverride: (config) => config,
      });
      console.log('Remotion bundle ready:', bundled);
      return bundled;
    })();
  }
  return bundleLocationPromise;
}

// Invalidate cached bundle (e.g. after code changes)
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

  const bundleLocation = await getBundleLocation();

  const { selectComposition, renderMedia } = await import('@remotion/renderer');

  const chromiumExecutable = process.env.REMOTION_CHROME_EXECUTABLE || undefined;

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: compositionId,
    inputProps,
  });

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps,
    chromiumExecutable,
    onProgress: ({ progress }) => {
      onProgress?.(Math.round(progress * 100));
    },
  });

  return outputPath;
}

export function getRenderedVideoPath(jobId: string): string | null {
  const outputPath = path.join(RENDERS_DIR, `${jobId}.mp4`);
  if (fs.existsSync(outputPath)) {
    return outputPath;
  }
  return null;
}
