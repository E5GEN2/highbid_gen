import { CompositionResult, composeStoryboard } from './storyboardCompositor';
import { generateKenBurnsPan, PanAnimation, PanOptions } from './kenBurnsPan';
import { processEnhancedVideo, RenderRequest } from './enhancedVideoProcessor';
import { getEnabledFrames } from './frameSettings';
import { StoryboardWithOverrides } from './storyboardOverrides';

export interface FinalRenderOptions {
  useKenBurns?: boolean;
  panOptions?: PanOptions;
  videoQuality?: 'standard' | 'high' | 'ultra';
  outputFormat?: 'mp4' | 'mov' | 'webm';
}

export interface RenderPipelineInput {
  jobId: string;
  storyboardData: any[];
  imagePaths: string[];
  storyboardWithOverrides?: StoryboardWithOverrides;
  planningResult?: any;
  options?: FinalRenderOptions;
}

export interface RenderPipelineResult {
  success: boolean;
  jobId: string;
  composedPages?: CompositionResult[];
  panAnimations?: PanAnimation[];
  error?: string;
}

/**
 * Generate Ken Burns pan animations for all composed pages
 */
async function generatePanAnimationsForPages(
  composedPages: CompositionResult[],
  planningResult: any,
  options?: PanOptions
): Promise<PanAnimation[]> {
  const panAnimations: PanAnimation[] = [];

  for (let i = 0; i < composedPages.length; i++) {
    const page = composedPages[i];
    const pageData = planningResult.pages[i];

    if (!pageData) {
      console.warn(`Warning: No page data found for composed page ${i}`);
      continue;
    }

    try {
      // Find the frame data for Ken Burns generation
      const enabledFrames = getEnabledFrames();
      const frameData = enabledFrames.find(frame => frame.id === pageData.frameId);

      if (!frameData) {
        console.warn(`Warning: Frame data not found for frameId ${pageData.frameId}`);
        continue;
      }

      // Generate Ken Burns pan for this page
      const panAnimation = generateKenBurnsPan(
        page,
        frameData,
        i, // pageIndex for directional alternation
        options
      );

      panAnimations.push(panAnimation);
      console.log(`✅ Generated Ken Burns animation for page ${i}: ${panAnimation.durationMs}ms, ${panAnimation.keyframes.length} keyframes`);

    } catch (error) {
      console.error(`❌ Failed to generate Ken Burns for page ${i}:`, error);

      // Create fallback static animation
      const fallbackAnimation: PanAnimation = {
        durationMs: options?.durationMs || 4000,
        ease: options?.ease || 'inOutSine',
        keyframes: [
          { t: 0.0, rect: { x: 0, y: 0, w: 1080, h: 1920 } },
          { t: 1.0, rect: { x: 0, y: 0, w: 1080, h: 1920 } }
        ]
      };
      panAnimations.push(fallbackAnimation);
    }
  }

  return panAnimations;
}

/**
 * Main final render pipeline that orchestrates the entire process
 */
export async function executeFinalRenderPipeline({
  jobId,
  storyboardData,
  imagePaths,
  storyboardWithOverrides,
  planningResult,
  options = {}
}: RenderPipelineInput): Promise<RenderPipelineResult> {
  try {
    console.log(`🚀 [${jobId}] Starting final render pipeline...`);

    // Default options
    const renderOptions: FinalRenderOptions = {
      useKenBurns: true,
      panOptions: {
        durationMs: 4000,
        ease: 'inOutSine',
        magnitude: 0.5,
        targetDominantPanel: true
      },
      videoQuality: 'high',
      outputFormat: 'mp4',
      ...options
    };

    console.log(`⚙️ [${jobId}] Render options:`, renderOptions);

    // Step 1: Compose storyboard pages
    console.log(`📐 [${jobId}] Step 1: Composing storyboard pages...`);

    let compositionResults: CompositionResult[];

    if (storyboardWithOverrides) {
      // Use existing composition results with overrides
      compositionResults = storyboardWithOverrides.compositionResults;
      console.log(`✅ [${jobId}] Using ${compositionResults.length} pre-composed pages with overrides`);
    } else if (planningResult) {
      // Compose from planning result
      const compositionResult = await composeStoryboard(planningResult, imagePaths);
      compositionResults = compositionResult.pages;
      console.log(`✅ [${jobId}] Composed ${compositionResults.length} pages from planning result`);
    } else {
      throw new Error('No valid storyboard composition source provided');
    }

    // Step 2: Generate Ken Burns pan animations
    let panAnimations: PanAnimation[] = [];

    if (renderOptions.useKenBurns) {
      console.log(`🎬 [${jobId}] Step 2: Generating Ken Burns pan animations...`);

      panAnimations = await generatePanAnimationsForPages(
        compositionResults,
        storyboardWithOverrides?.originalPlanningResult || planningResult,
        renderOptions.panOptions
      );

      console.log(`✅ [${jobId}] Generated ${panAnimations.length} Ken Burns animations`);
    } else {
      console.log(`⏭️ [${jobId}] Step 2: Skipping Ken Burns generation (disabled)`);
    }

    // Step 3: Package data for video processing
    console.log(`📦 [${jobId}] Step 3: Preparing data for video processing...`);

    // This would normally be called by the render API, but for testing we simulate it
    console.log(`🎥 [${jobId}] Ready for enhanced video processing with:`);
    console.log(`   - ${compositionResults.length} composed pages`);
    console.log(`   - ${panAnimations.length} pan animations`);
    console.log(`   - Ken Burns enabled: ${renderOptions.useKenBurns}`);

    return {
      success: true,
      jobId,
      composedPages: compositionResults,
      panAnimations
    };

  } catch (error) {
    console.error(`❌ [${jobId}] Final render pipeline error:`, error);

    return {
      success: false,
      jobId,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Process a render request with the full enhanced pipeline
 */
export async function processRenderWithPipeline(
  zipBuffer: Buffer,
  jobId: string,
  options?: FinalRenderOptions
): Promise<void> {
  try {
    // Extract basic storyboard data from ZIP
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(zipBuffer);

    const storyboardFile = zip.file('storyboard.json');
    const planningFile = zip.file('planning-result.json');
    const compositionFile = zip.file('composition-results.json');

    if (!storyboardFile) {
      throw new Error('No storyboard.json found in ZIP');
    }

    const storyboardData = JSON.parse(await storyboardFile.async('text'));

    // Check if we have enhanced data
    let planningResult;
    let compositionResults;

    if (planningFile) {
      planningResult = JSON.parse(await planningFile.async('text'));
      console.log(`📋 Found planning result with ${planningResult.pages?.length || 0} pages`);
    }

    if (compositionFile) {
      compositionResults = JSON.parse(await compositionFile.async('text'));
      console.log(`🎨 Found composition results with ${compositionResults.length || 0} pages`);
    }

    // Extract image paths from ZIP
    const imagePaths = Object.keys(zip.files)
      .filter(name => name.startsWith('images/'))
      .map(name => name.replace('images/', ''));

    if (planningResult && compositionResults) {
      // We have all the enhanced data - create a mock storyboard with overrides
      const mockStoryboardWithOverrides = {
        originalPlanningResult: planningResult,
        compositionResults: compositionResults,
        overrides: [],
        imagePaths: imagePaths
      };

      // Execute the full pipeline
      const pipelineResult = await executeFinalRenderPipeline({
        jobId,
        storyboardData,
        imagePaths,
        storyboardWithOverrides: mockStoryboardWithOverrides,
        options
      });

      if (pipelineResult.success && pipelineResult.composedPages && pipelineResult.panAnimations) {
        // Process with enhanced video processor
        await processEnhancedVideo({
          jobId,
          zipBuffer,
          composedPages: pipelineResult.composedPages,
          panAnimations: pipelineResult.panAnimations,
          useKenBurns: options?.useKenBurns !== false
        });
      } else {
        throw new Error(pipelineResult.error || 'Pipeline execution failed');
      }
    } else {
      // Fallback to standard processing
      console.log(`⚠️ [${jobId}] Missing enhanced data, falling back to standard processing`);

      await processEnhancedVideo({
        jobId,
        zipBuffer,
        useKenBurns: false
      });
    }

  } catch (error) {
    console.error(`❌ [${jobId}] Render pipeline processing error:`, error);
    throw error;
  }
}

/**
 * Generate a comprehensive rendering report
 */
export function generateRenderReport(
  composedPages: CompositionResult[],
  panAnimations: PanAnimation[],
  options: FinalRenderOptions
): string {
  const report = [
    '# Final Render Report',
    '',
    `## Overview`,
    `- Total Pages: ${composedPages.length}`,
    `- Ken Burns Animations: ${panAnimations.length}`,
    `- Ken Burns Enabled: ${options.useKenBurns ? 'Yes' : 'No'}`,
    `- Video Quality: ${options.videoQuality}`,
    `- Output Format: ${options.outputFormat}`,
    '',
    `## Page Details`,
    ...composedPages.map((page, i) => {
      const pan = panAnimations[i];
      return [
        `### Page ${i + 1}`,
        `- Page Index: ${page.pageIndex}`,
        `- Image Count: ${page.imageCount || 'unknown'}`,
        `- Composed Size: ${page.composedImageBase64?.length || 'unknown'} chars (base64)`,
        pan ? [
          `- Pan Duration: ${pan.durationMs}ms`,
          `- Pan Ease: ${pan.ease}`,
          `- Keyframes: ${pan.keyframes.length}`,
          `- Start Rect: ${JSON.stringify(pan.keyframes[0]?.rect)}`,
          `- End Rect: ${JSON.stringify(pan.keyframes[pan.keyframes.length - 1]?.rect)}`
        ].join('\n') : '- Pan: None',
        ''
      ].join('\n');
    }),
    '',
    `## Settings`,
    options.panOptions ? [
      `- Duration per Page: ${options.panOptions.durationMs}ms`,
      `- Easing: ${options.panOptions.ease}`,
      `- Magnitude: ${options.panOptions.magnitude}`,
      `- Target Dominant Panel: ${options.panOptions.targetDominantPanel}`
    ].join('\n') : '- Pan Options: Default',
    '',
    `Generated at: ${new Date().toISOString()}`
  ].join('\n');

  return report;
}