import { PNG } from 'pngjs';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PagePlan, PlanningResult } from './pagePlanner';
import { getFrameManifest } from './frameScanner';
import sharp from 'sharp';

export interface CompositionOptions {
  outputDir?: string;
  borderOverlay?: boolean;
  borderWidth?: number;
  borderColor?: string;
  quality?: number; // 1-100 for JPEG quality
  format?: 'png' | 'jpg';
  cacheImages?: boolean;
}

export interface CompositionResult {
  pageIndex: number;
  frameId: string;
  outputPath: string;
  width: number;
  height: number;
  panelsFilled: number;
  imagesUsed: number[];
  composedImageBase64?: string;
  imageCount?: number;
}

export interface StoryboardResult {
  pages: CompositionResult[];
  totalPages: number;
  outputDirectory: string;
  format: string;
}

// Canvas dimensions from requirements
const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;

// Default output directory
const DEFAULT_OUTPUT_DIR = join(process.cwd(), 'tmp', 'storyboard');

// Image cache for better performance
const imageCache = new Map<string, Buffer>();

export async function composeStoryboard(
  planningResult: PlanningResult,
  imagePaths: string[],
  options?: CompositionOptions
): Promise<StoryboardResult> {
  const finalOptions: Required<CompositionOptions> = {
    outputDir: options?.outputDir ?? DEFAULT_OUTPUT_DIR,
    borderOverlay: options?.borderOverlay ?? false,
    borderWidth: options?.borderWidth ?? 2,
    borderColor: options?.borderColor ?? '#000000',
    quality: options?.quality ?? 90,
    format: options?.format ?? 'jpg',
    cacheImages: options?.cacheImages ?? true
  };

  // Ensure output directory exists
  if (!existsSync(finalOptions.outputDir)) {
    mkdirSync(finalOptions.outputDir, { recursive: true });
  }

  const results: CompositionResult[] = [];
  const manifest = getFrameManifest();

  // Process each page in the plan
  for (let pageIndex = 0; pageIndex < planningResult.pages.length; pageIndex++) {
    const page = planningResult.pages[pageIndex];
    const result = await composePage(
      page,
      pageIndex,
      imagePaths,
      manifest,
      finalOptions
    );
    results.push(result);
  }

  // Clear cache if enabled
  if (finalOptions.cacheImages) {
    imageCache.clear();
  }

  return {
    pages: results,
    totalPages: results.length,
    outputDirectory: finalOptions.outputDir,
    format: finalOptions.format
  };
}

async function composePage(
  page: PagePlan,
  pageIndex: number,
  imagePaths: string[],
  manifest: any,
  options: Required<CompositionOptions>
): Promise<CompositionResult> {
  const frameData = manifest.frames[page.frameId];
  if (!frameData) {
    throw new Error(`Frame ${page.frameId} not found in manifest`);
  }

  // Load the mask PNG
  const maskPath = join(process.cwd(), 'frames', frameData.filename);
  const mask = await loadPNG(maskPath);

  // Create a new canvas for composition
  const canvas = sharp({
    create: {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  });

  // Composite layers for each panel
  const composites: sharp.OverlayOptions[] = [];

  for (let panelIndex = 0; panelIndex < page.imageIndexes.length; panelIndex++) {
    const imageIndex = page.imageIndexes[panelIndex];
    const imagePath = imagePaths[imageIndex];

    if (!imagePath || !existsSync(imagePath)) {
      console.warn(`Image not found: ${imagePath} (index ${imageIndex})`);
      continue;
    }

    const panel = frameData.panels[panelIndex];
    if (!panel) {
      console.warn(`Panel ${panelIndex} not found in frame ${page.frameId}`);
      continue;
    }

    // Load and process the image for this panel
    const processedImage = await processImageForPanel(
      imagePath,
      panel,
      options
    );

    composites.push({
      input: processedImage,
      left: panel.bounds.x,
      top: panel.bounds.y
    });
  }

  // Apply all composites
  let finalImage = canvas;
  if (composites.length > 0) {
    finalImage = canvas.composite(composites);
  }

  // Apply border overlay if requested
  if (options.borderOverlay) {
    const borderOverlay = await createBorderOverlay(frameData, options);
    finalImage = finalImage.composite([{
      input: borderOverlay,
      blend: 'over'
    }]);
  }

  // Generate output filename
  const outputFilename = `storyboard_${String(pageIndex + 1).padStart(3, '0')}.${options.format}`;
  const outputPath = join(options.outputDir, outputFilename);

  // Save the composed image
  if (options.format === 'jpg') {
    await finalImage.jpeg({ quality: options.quality }).toFile(outputPath);
  } else {
    await finalImage.png().toFile(outputPath);
  }

  console.log(`✅ Composed page ${pageIndex + 1}: ${outputFilename}`);

  return {
    pageIndex,
    frameId: page.frameId,
    outputPath,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    panelsFilled: page.imageIndexes.length,
    imagesUsed: page.imageIndexes
  };
}

async function processImageForPanel(
  imagePath: string,
  panel: any,
  options: Required<CompositionOptions>
): Promise<Buffer> {
  // Check cache first
  const cacheKey = `${imagePath}_${panel.bounds.x}_${panel.bounds.y}_${panel.bounds.width}_${panel.bounds.height}`;
  if (options.cacheImages && imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey)!;
  }

  const panelWidth = panel.bounds.width;
  const panelHeight = panel.bounds.height;

  // Load and resize image to fit panel using cover strategy
  const processedImage = await sharp(imagePath)
    .resize(panelWidth, panelHeight, {
      fit: 'cover', // Cover fit as specified
      position: 'center'
    })
    .toBuffer();

  // Cache if enabled
  if (options.cacheImages) {
    imageCache.set(cacheKey, processedImage);
  }

  return processedImage;
}

async function createBorderOverlay(
  frameData: any,
  options: Required<CompositionOptions>
): Promise<Buffer> {
  // Create a transparent canvas
  const borderCanvas = sharp({
    create: {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  });

  // Draw borders for each panel
  const borderElements: sharp.OverlayOptions[] = [];

  for (const panel of frameData.panels) {
    const { x, y, width, height } = panel.bounds;

    // Create border rectangle (hollow)
    const borderWidth = options.borderWidth;

    // Top border
    borderElements.push({
      input: {
        create: {
          width: width,
          height: borderWidth,
          channels: 4,
          background: hexToRgba(options.borderColor)
        }
      },
      left: x,
      top: y
    });

    // Bottom border
    borderElements.push({
      input: {
        create: {
          width: width,
          height: borderWidth,
          channels: 4,
          background: hexToRgba(options.borderColor)
        }
      },
      left: x,
      top: y + height - borderWidth
    });

    // Left border
    borderElements.push({
      input: {
        create: {
          width: borderWidth,
          height: height,
          channels: 4,
          background: hexToRgba(options.borderColor)
        }
      },
      left: x,
      top: y
    });

    // Right border
    borderElements.push({
      input: {
        create: {
          width: borderWidth,
          height: height,
          channels: 4,
          background: hexToRgba(options.borderColor)
        }
      },
      left: x + width - borderWidth,
      top: y
    });
  }

  return borderCanvas.composite(borderElements).png().toBuffer();
}

function hexToRgba(hex: string): { r: number; g: number; b: number; alpha: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
    alpha: 1
  } : { r: 0, g: 0, b: 0, alpha: 1 };
}

async function loadPNG(path: string): Promise<PNG> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    const png = new PNG();

    stream
      .pipe(png)
      .on('parsed', () => resolve(png))
      .on('error', reject);
  });
}

export async function previewStoryboard(
  storyboardResult: StoryboardResult,
  previewOptions?: {
    maxPages?: number;
    thumbnailSize?: number;
  }
): Promise<string[]> {
  const maxPages = previewOptions?.maxPages ?? 4;
  const thumbnailSize = previewOptions?.thumbnailSize ?? 200;

  const previews: string[] = [];

  for (let i = 0; i < Math.min(maxPages, storyboardResult.pages.length); i++) {
    const page = storyboardResult.pages[i];
    const previewPath = page.outputPath.replace(
      `.${storyboardResult.format}`,
      `_preview.${storyboardResult.format}`
    );

    // Create thumbnail
    await sharp(page.outputPath)
      .resize(thumbnailSize, Math.floor(thumbnailSize * (CANVAS_HEIGHT / CANVAS_WIDTH)), {
        fit: 'inside'
      })
      .toFile(previewPath);

    previews.push(previewPath);
  }

  return previews;
}

export function getStoryboardInfo(storyboardResult: StoryboardResult): string {
  const info: string[] = [];

  info.push(`📚 Storyboard Summary`);
  info.push(`Total pages: ${storyboardResult.totalPages}`);
  info.push(`Output directory: ${storyboardResult.outputDirectory}`);
  info.push(`Format: ${storyboardResult.format.toUpperCase()}`);
  info.push('');

  storyboardResult.pages.forEach((page, index) => {
    info.push(`📄 Page ${index + 1}:`);
    info.push(`  Frame: ${page.frameId}`);
    info.push(`  Panels filled: ${page.panelsFilled}`);
    info.push(`  Images: [${page.imagesUsed.join(', ')}]`);
    info.push(`  Output: ${page.outputPath}`);
  });

  return info.join('\n');
}