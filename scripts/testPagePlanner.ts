import { createPagePlan, optimizePagePlan, visualizePlan, validatePagePlan } from '../lib/pagePlanner';

async function main() {
  console.log('🚀 Testing Page Planning System\n');

  // Test cases for different image counts
  const testCases = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 18, 20];

  console.log('📋 Step 1: Basic page planning tests');

  for (const imageCount of testCases) {
    console.log(`\n🖼️  Planning for ${imageCount} images:`);

    try {
      const plan = createPagePlan(imageCount);
      console.log(`  Pages: ${plan.totalPages}, Efficiency: ${plan.efficiency.toFixed(1)}%, Unused: ${plan.unusedPanels}`);

      // Show page breakdown
      plan.pages.forEach((page, index) => {
        console.log(`    Page ${index + 1}: ${page.frameId} (${page.panelCount} panels) → images [${page.imageIndexes.join(', ')}]`);
      });

      // Validate the plan
      const errors = validatePagePlan(plan);
      if (errors.length > 0) {
        console.log(`    ❌ Validation errors: ${errors.join(', ')}`);
      } else {
        console.log(`    ✅ Plan is valid`);
      }
    } catch (error) {
      console.log(`    ❌ Error: ${error.message}`);
    }
  }

  // Test with different preferences
  console.log('\n🎯 Step 2: Testing preference variations');

  const testImageCount = 7;
  const preferenceTests = [
    { name: 'Default', options: {} },
    { name: 'Prefer Dominant Panel', options: { preferDominantPanel: true } },
    { name: 'No Non-Uniform', options: { allowNonUniform: false } },
    { name: 'Strict + Dominant', options: { allowNonUniform: false, preferDominantPanel: true } },
    { name: 'Max 3 per page', options: { maxImagesPerPage: 3 } }
  ];

  for (const test of preferenceTests) {
    console.log(`\n📐 ${test.name}:`);
    try {
      const plan = createPagePlan(testImageCount, test.options);
      console.log(`  ${plan.totalPages} pages, ${plan.efficiency.toFixed(1)}% efficiency`);
      plan.pages.forEach((page, index) => {
        console.log(`    Page ${index + 1}: ${page.frameId} → [${page.imageIndexes.join(', ')}]`);
      });
    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }
  }

  // Test optimization
  console.log('\n🔧 Step 3: Testing plan optimization');

  const originalPlan = createPagePlan(8);
  console.log(`\nOriginal plan for 8 images:`);
  console.log(`  ${originalPlan.totalPages} pages, ${originalPlan.efficiency.toFixed(1)}% efficiency`);

  const optimizedPlan = optimizePagePlan(originalPlan);
  console.log(`\nOptimized plan:`);
  console.log(`  ${optimizedPlan.totalPages} pages, ${optimizedPlan.efficiency.toFixed(1)}% efficiency`);

  // Test visualization
  console.log('\n📊 Step 4: Plan visualization');
  const visualPlan = createPagePlan(5);
  console.log(visualizePlan(visualPlan));

  // Edge cases
  console.log('\n🧪 Step 5: Edge cases');

  // Zero images
  try {
    const zeroPlan = createPagePlan(0);
    console.log(`Zero images: ${zeroPlan.totalPages} pages (expected: 0)`);
  } catch (error) {
    console.log(`Zero images error: ${error.message}`);
  }

  // Very high count
  try {
    const highPlan = createPagePlan(100);
    console.log(`100 images: ${highPlan.totalPages} pages, ${highPlan.efficiency.toFixed(1)}% efficiency`);
  } catch (error) {
    console.log(`100 images error: ${error.message}`);
  }

  console.log('\n✅ Page Planning tests completed!');
}

main().catch(console.error);