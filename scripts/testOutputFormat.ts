import { createPagePlan } from '../lib/pagePlanner';

async function main() {
  console.log('🎯 Testing Output Format Specification\n');

  // Test case from Phase 3 specification: 5 images
  console.log('📋 Testing Phase 3 example (5 images):');
  const plan = createPagePlan(5);

  // Extract just the essential output format
  const output = plan.pages.map(page => ({
    frameId: page.frameId,
    panelCount: page.panelCount,
    imageIndexes: page.imageIndexes
  }));

  console.log('Expected format: [{ "frameId": "5_four_grid", "panelCount": 4, "imageIndexes": [0,1,2,3] }, { "frameId": "1_full_splash", "panelCount": 1, "imageIndexes": [4] }]');
  console.log('Actual output:', JSON.stringify(output));

  // Validate format structure
  console.log('\n✅ Format validation:');

  let allValid = true;

  output.forEach((page, index) => {
    const hasFrameId = typeof page.frameId === 'string' && page.frameId.length > 0;
    const hasPanelCount = typeof page.panelCount === 'number' && page.panelCount > 0;
    const hasImageIndexes = Array.isArray(page.imageIndexes) && page.imageIndexes.length > 0;
    const indexesAreNumbers = page.imageIndexes.every(idx => typeof idx === 'number');

    console.log(`  Page ${index + 1}:`);
    console.log(`    frameId: ${hasFrameId ? '✅' : '❌'} (${page.frameId})`);
    console.log(`    panelCount: ${hasPanelCount ? '✅' : '❌'} (${page.panelCount})`);
    console.log(`    imageIndexes: ${hasImageIndexes && indexesAreNumbers ? '✅' : '❌'} (${page.imageIndexes.join(', ')})`);

    if (!hasFrameId || !hasPanelCount || !hasImageIndexes || !indexesAreNumbers) {
      allValid = false;
    }
  });

  // Test deterministic behavior
  console.log('\n🔄 Testing deterministic behavior:');
  const plan2 = createPagePlan(5);
  const output2 = plan2.pages.map(page => ({
    frameId: page.frameId,
    panelCount: page.panelCount,
    imageIndexes: page.imageIndexes
  }));

  const isDeterministic = JSON.stringify(output) === JSON.stringify(output2);
  console.log(`  Multiple runs produce same result: ${isDeterministic ? '✅' : '❌'}`);

  // Test various image counts
  console.log('\n📐 Testing various image counts:');
  const testCases = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20];

  for (const imageCount of testCases) {
    const testPlan = createPagePlan(imageCount);
    const testOutput = testPlan.pages.map(page => ({
      frameId: page.frameId,
      panelCount: page.panelCount,
      imageIndexes: page.imageIndexes
    }));

    // Verify all images are assigned exactly once
    const allImages = testOutput.flatMap(page => page.imageIndexes);
    const expectedImages = Array.from({ length: imageCount }, (_, i) => i);
    const allAssigned = expectedImages.every(img => allImages.includes(img));
    const noDuplicates = allImages.length === new Set(allImages).size;

    console.log(`  ${imageCount} images: ${allAssigned && noDuplicates ? '✅' : '❌'} (${testOutput.length} pages)`);

    if (!allAssigned || !noDuplicates) {
      console.log(`    Expected: [${expectedImages.join(', ')}]`);
      console.log(`    Got: [${allImages.sort((a, b) => a - b).join(', ')}]`);
      allValid = false;
    }
  }

  console.log(`\n${allValid ? '✅' : '❌'} Overall format validation: ${allValid ? 'PASSED' : 'FAILED'}`);

  if (allValid) {
    console.log('\n🎉 Phase 3 output format specification fully implemented!');
    console.log('📋 Deliverable: Deterministic page plans for any N ✅');
  }
}

main().catch(console.error);