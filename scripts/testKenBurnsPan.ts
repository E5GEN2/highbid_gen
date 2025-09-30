import {
  generateKenBurnsPan,
  generatePanAnimationsForStoryboard,
  exportPanAnimations,
  validatePanAnimation,
  visualizePanAnimations,
  PanOptions
} from '../lib/kenBurnsPan';
import { composeStoryboard } from '../lib/storyboardCompositor';
import { createPagePlan } from '../lib/pagePlanner';
import { createTestImages } from './createTestImages';
import { getFrameManifest } from '../lib/frameScanner';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';

async function main() {
  console.log('🎬 Testing Ken Burns Pan Generation\n');

  // Step 1: Prepare test environment
  console.log('📋 Step 1: Setting up test environment');

  const testImageDir = join(process.cwd(), 'tmp', 'test-images');
  let imagePaths: string[];

  if (!existsSync(testImageDir)) {
    console.log('Creating test images...');
    imagePaths = await createTestImages();
  } else {
    const imageFiles = readdirSync(testImageDir)
      .filter(file => file.endsWith('.jpg'))
      .sort()
      .slice(0, 8);
    imagePaths = imageFiles.map(file => join(testImageDir, file));
    console.log(`✅ Found ${imagePaths.length} existing test images`);
  }

  const manifest = getFrameManifest();
  console.log('✅ Loaded frame manifest\n');

  // Step 2: Test basic Ken Burns generation
  console.log('🎯 Step 2: Testing basic Ken Burns generation');

  const basicTests = [
    { imageCount: 1, description: 'Single image - splash frame' },
    { imageCount: 3, description: 'Three images - standard layout' },
    { imageCount: 5, description: 'Five images - complex layout' }
  ];

  for (const test of basicTests) {
    console.log(`📐 Testing ${test.description}:`);

    try {
      // Create page plan and compose storyboard
      const plan = createPagePlan(test.imageCount);
      const testImages = imagePaths.slice(0, test.imageCount);
      const storyboard = await composeStoryboard(plan, testImages, {
        outputDir: join(process.cwd(), 'tmp', 'ken-burns-test'),
        format: 'jpg'
      });

      // Generate pan animations
      const animations = generatePanAnimationsForStoryboard(
        storyboard.pages,
        manifest
      );

      console.log(`  ✅ Generated ${animations.length} pan animations`);

      // Validate each animation
      let allValid = true;
      animations.forEach((animation, index) => {
        const errors = validatePanAnimation(animation);
        if (errors.length > 0) {
          console.log(`  ❌ Page ${index + 1} validation errors: ${errors.join(', ')}`);
          allValid = false;
        }
      });

      if (allValid) {
        console.log(`  ✅ All animations valid`);
      }

      // Show first animation details
      if (animations.length > 0) {
        const first = animations[0];
        const start = first.keyframes[0].rect;
        const end = first.keyframes[1].rect;
        const scale = end.w / start.w;
        console.log(`  📊 First animation: ${scale.toFixed(2)}x scale, ${first.durationMs}ms`);
      }

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    console.log('');
  }

  // Step 3: Test different pan options
  console.log('🎛️ Step 3: Testing pan option variations');

  const optionTests: { name: string; options: PanOptions }[] = [
    { name: 'No pan (magnitude 0)', options: { magnitude: 0 } },
    { name: 'Subtle pan (magnitude 0.3)', options: { magnitude: 0.3 } },
    { name: 'Maximum pan (magnitude 1.0)', options: { magnitude: 1.0 } },
    { name: 'Fast duration (1 second)', options: { durationMs: 1000 } },
    { name: 'Slow duration (5 seconds)', options: { durationMs: 5000 } },
    { name: 'Linear ease', options: { ease: 'linear' } },
    { name: 'Ease-in-out', options: { ease: 'ease-in-out' } },
    { name: 'Force center direction', options: { direction: 'center' } },
    { name: 'Force top-left direction', options: { direction: 'top-left' } },
    { name: 'Disable dominant panel', options: { targetDominantPanel: false } }
  ];

  // Create a single page for testing options
  const plan = createPagePlan(3);
  const testImages = imagePaths.slice(0, 3);
  const storyboard = await composeStoryboard(plan, testImages, {
    outputDir: join(process.cwd(), 'tmp', 'ken-burns-options'),
    format: 'jpg'
  });

  for (const optionTest of optionTests) {
    console.log(`⚙️  Testing ${optionTest.name}:`);

    try {
      const animations = generatePanAnimationsForStoryboard(
        storyboard.pages,
        manifest,
        optionTest.options
      );

      const first = animations[0];
      const start = first.keyframes[0].rect;
      const end = first.keyframes[1].rect;
      const scale = start.w > 0 ? end.w / start.w : 1;

      console.log(`  Duration: ${first.durationMs}ms, Ease: ${first.ease}, Scale: ${scale.toFixed(2)}x`);
      console.log(`  Start rect: (${start.x},${start.y}) ${start.w}×${start.h}`);

      // Validate
      const errors = validatePanAnimation(first);
      console.log(`  Validation: ${errors.length === 0 ? '✅' : '❌'}`);

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    console.log('');
  }

  // Step 4: Test specific frame types with dominant panels
  console.log('🎯 Step 4: Testing frame types with dominant panel targeting');

  const frameTests = [
    { frameId: '1_full_splash', imageCount: 1, description: 'Full splash (no dominant panel)' },
    { frameId: '2_two_horizontal', imageCount: 2, description: 'Two horizontal (panel 1 dominant)' },
    { frameId: '5_four_grid', imageCount: 4, description: 'Four grid (panel 2 dominant)' },
    { frameId: '8_windowpane', imageCount: 5, description: 'Windowpane (panel 0 dominant)' },
    { frameId: '9_hero_four', imageCount: 5, description: 'Hero four (panel 0 dominant)' }
  ];

  for (const frameTest of frameTests) {
    console.log(`📐 Testing ${frameTest.description}:`);

    try {
      // Create specific page plan
      const specificPlan = {
        pages: [{
          frameId: frameTest.frameId,
          panelCount: frameTest.imageCount,
          imageIndexes: Array.from({ length: frameTest.imageCount }, (_, i) => i)
        }],
        totalImages: frameTest.imageCount,
        totalPages: 1,
        efficiency: 100,
        unusedPanels: 0
      };

      const testImages = imagePaths.slice(0, frameTest.imageCount);
      const storyboard = await composeStoryboard(specificPlan, testImages, {
        outputDir: join(process.cwd(), 'tmp', 'ken-burns-frames'),
        format: 'jpg'
      });

      // Test with and without dominant panel targeting
      const withDominant = generatePanAnimationsForStoryboard(
        storyboard.pages,
        manifest,
        { targetDominantPanel: true }
      );

      const withoutDominant = generatePanAnimationsForStoryboard(
        storyboard.pages,
        manifest,
        { targetDominantPanel: false }
      );

      const frameData = manifest.frames[frameTest.frameId];
      const hasDominant = frameData?.dominantPanel !== undefined;

      console.log(`  Frame has dominant panel: ${hasDominant ? '✅' : '❌'}`);

      if (hasDominant) {
        const withStart = withDominant[0].keyframes[0].rect;
        const withoutStart = withoutDominant[0].keyframes[0].rect;
        const different = withStart.x !== withoutStart.x || withStart.y !== withoutStart.y;
        console.log(`  Dominant targeting changes pan: ${different ? '✅' : '❌'}`);
      }

      console.log(`  Pan validation: ${validatePanAnimation(withDominant[0]).length === 0 ? '✅' : '❌'}`);

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    console.log('');
  }

  // Step 5: Test directional alternation
  console.log('🔄 Step 5: Testing directional alternation patterns');

  // Create a multi-page scenario
  const multiPagePlan = createPagePlan(15);
  const multiPageImages = Array.from({ length: 15 }, (_, i) => imagePaths[i % imagePaths.length]);
  const multiPageStoryboard = await composeStoryboard(multiPagePlan, multiPageImages, {
    outputDir: join(process.cwd(), 'tmp', 'ken-burns-alternation'),
    format: 'jpg'
  });

  const multiPageAnimations = generatePanAnimationsForStoryboard(
    multiPageStoryboard.pages,
    manifest,
    { targetDominantPanel: false, direction: 'auto' } // Force alternation
  );

  console.log(`📊 Generated ${multiPageAnimations.length} pages with alternating directions:`);

  multiPageAnimations.slice(0, 8).forEach((animation, index) => {
    const start = animation.keyframes[0].rect;
    const centerX = start.x + start.w / 2;
    const centerY = start.y + start.h / 2;

    let direction = 'center';
    if (centerX < 300 && centerY < 500) direction = 'top-left';
    else if (centerX > 800 && centerY < 500) direction = 'top-right';
    else if (centerX > 800 && centerY > 1400) direction = 'bottom-right';
    else if (centerX < 300 && centerY > 1400) direction = 'bottom-left';

    console.log(`  Page ${index + 1}: ${direction} (center: ${centerX.toFixed(0)}, ${centerY.toFixed(0)})`);
  });

  // Step 6: Export and visualization test
  console.log('\n📤 Step 6: Testing export and visualization');

  try {
    // Export to JSON
    const exportPath = join(process.cwd(), 'tmp', 'ken-burns-export.json');
    const jsonOutput = exportPanAnimations(multiPageAnimations, exportPath);
    console.log(`✅ Exported ${multiPageAnimations.length} animations to JSON`);

    // Test visualization
    const visualization = visualizePanAnimations(multiPageAnimations.slice(0, 3));
    console.log('\n📊 Sample visualization:');
    console.log(visualization);

  } catch (error) {
    console.log(`❌ Export error: ${error.message}`);
  }

  console.log('\n🎉 Phase 5 — Ken Burns Pan testing complete!');
  console.log('\n📁 Output locations:');
  console.log('  • Basic tests: tmp/ken-burns-test/');
  console.log('  • Option tests: tmp/ken-burns-options/');
  console.log('  • Frame tests: tmp/ken-burns-frames/');
  console.log('  • Alternation test: tmp/ken-burns-alternation/');
  console.log('  • JSON export: tmp/ken-burns-export.json');
}

main().catch(console.error);