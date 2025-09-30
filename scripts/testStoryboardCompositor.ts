import { composeStoryboard, previewStoryboard, getStoryboardInfo } from '../lib/storyboardCompositor';
import { createPagePlan } from '../lib/pagePlanner';
import { createTestImages } from './createTestImages';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';

async function main() {
  console.log('🎬 Testing Storyboard Compositor\n');

  // Step 1: Create test images if they don't exist
  console.log('📋 Step 1: Preparing test images');
  const testImageDir = join(process.cwd(), 'tmp', 'test-images');
  let imagePaths: string[];

  if (!existsSync(testImageDir)) {
    console.log('Creating test images...');
    imagePaths = await createTestImages();
  } else {
    // Load existing test images
    const imageFiles = readdirSync(testImageDir)
      .filter(file => file.endsWith('.jpg'))
      .sort()
      .slice(0, 10); // Take first 10

    imagePaths = imageFiles.map(file => join(testImageDir, file));
    console.log(`✅ Found ${imagePaths.length} existing test images`);
  }

  console.log('');

  // Test cases for different numbers of images
  const testCases = [
    { imageCount: 3, description: '3 images - single page test' },
    { imageCount: 5, description: '5 images - exact fit test' },
    { imageCount: 7, description: '7 images - multi-page test' },
    { imageCount: 10, description: '10 images - full test set' }
  ];

  for (const testCase of testCases) {
    console.log(`🖼️  Step: Testing ${testCase.description}`);

    // Create page plan
    const plan = createPagePlan(testCase.imageCount);
    console.log(`  📋 Plan: ${plan.totalPages} pages, ${plan.efficiency.toFixed(1)}% efficiency`);

    // Select images for this test
    const testImages = imagePaths.slice(0, testCase.imageCount);

    try {
      // Compose storyboard
      const result = await composeStoryboard(plan, testImages, {
        format: 'jpg',
        quality: 85,
        borderOverlay: false
      });

      console.log(`  ✅ Composed ${result.totalPages} pages`);

      result.pages.forEach((page, index) => {
        console.log(`    Page ${index + 1}: ${page.frameId} → ${page.panelsFilled} panels filled`);
      });

      // Test with border overlay
      const resultWithBorders = await composeStoryboard(plan, testImages, {
        format: 'png',
        borderOverlay: true,
        borderWidth: 3,
        borderColor: '#000000',
        outputDir: join(process.cwd(), 'tmp', 'storyboard', 'with-borders')
      });

      console.log(`  🔲 Created border version: ${resultWithBorders.totalPages} pages`);

      // Create previews
      const previews = await previewStoryboard(result, {
        maxPages: 2,
        thumbnailSize: 150
      });

      console.log(`  👁️  Generated ${previews.length} preview thumbnails`);

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }

    console.log('');
  }

  // Test individual frame types
  console.log('🎯 Step: Testing specific frame types');

  const frameTests = [
    { frameId: '1_full_splash', imageCount: 1, description: 'Single panel splash' },
    { frameId: '2_two_horizontal', imageCount: 2, description: 'Two panel horizontal' },
    { frameId: '5_four_grid', imageCount: 4, description: 'Four panel grid' },
    { frameId: '8_windowpane', imageCount: 5, description: 'Five panel windowpane' }
  ];

  for (const frameTest of frameTests) {
    console.log(`📐 Testing ${frameTest.description}:`);

    // Create a plan with just one page using the specific frame
    const singlePagePlan = {
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

    try {
      const testImages = imagePaths.slice(0, frameTest.imageCount);
      const result = await composeStoryboard(singlePagePlan, testImages, {
        format: 'jpg',
        outputDir: join(process.cwd(), 'tmp', 'storyboard', 'frame-tests')
      });

      console.log(`  ✅ ${result.pages[0].frameId}: ${result.pages[0].panelsFilled} panels`);

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }
  }

  console.log('');

  // Test edge cases
  console.log('🧪 Step: Testing edge cases');

  const edgeCases = [
    { imageCount: 0, description: 'Zero images' },
    { imageCount: 1, description: 'Single image' },
    { imageCount: 15, description: 'Large collection' }
  ];

  for (const edgeCase of edgeCases) {
    console.log(`🔬 Testing ${edgeCase.description}:`);

    try {
      if (edgeCase.imageCount === 0) {
        const emptyPlan = createPagePlan(0);
        console.log(`  📋 Empty plan: ${emptyPlan.totalPages} pages (expected: 0)`);
        continue;
      }

      const plan = createPagePlan(edgeCase.imageCount);
      const testImages = imagePaths.slice(0, Math.min(edgeCase.imageCount, imagePaths.length));

      // Repeat images if we need more than we have
      while (testImages.length < edgeCase.imageCount) {
        testImages.push(...imagePaths.slice(0, Math.min(edgeCase.imageCount - testImages.length, imagePaths.length)));
      }

      const result = await composeStoryboard(plan, testImages, {
        format: 'jpg',
        outputDir: join(process.cwd(), 'tmp', 'storyboard', 'edge-cases')
      });

      console.log(`  ✅ ${result.totalPages} pages, using ${testImages.length} images`);

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }
  }

  console.log('');

  // Final summary
  console.log('📊 Step: Testing complete summary');

  // Test the info function
  const finalPlan = createPagePlan(5);
  const finalImages = imagePaths.slice(0, 5);
  const finalResult = await composeStoryboard(finalPlan, finalImages);

  console.log('\n' + getStoryboardInfo(finalResult));

  console.log('\n🎉 Phase 4 — Storyboard Composition testing complete!');
  console.log('\n📁 Output locations:');
  console.log('  • Main storyboards: tmp/storyboard/');
  console.log('  • Border versions: tmp/storyboard/with-borders/');
  console.log('  • Frame tests: tmp/storyboard/frame-tests/');
  console.log('  • Edge cases: tmp/storyboard/edge-cases/');
}

main().catch(console.error);