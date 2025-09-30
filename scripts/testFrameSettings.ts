import {
  initializeFrameSettings,
  logFrameSettings,
  updateTemplateSettings,
  updateAutoSelectPreferences,
  updatePanPreferences,
  selectBestFrame,
  getMergedFrameData,
  getFramesByPanelCount
} from '../lib/frameSettings';

async function main() {
  console.log('🚀 Testing Frame Settings System\n');

  // Initialize and show current settings
  console.log('📋 Step 1: Initialize frame settings');
  const settings = initializeFrameSettings();
  logFrameSettings();

  // Test auto-select functionality
  console.log('🎯 Step 2: Testing auto-select functionality');

  // Test selecting frames for different panel counts
  const testCases = [1, 2, 3, 4, 5];

  for (const panelCount of testCases) {
    const bestFrame = selectBestFrame(panelCount);
    if (bestFrame) {
      console.log(`  ${panelCount} panels → ${bestFrame.id} (${bestFrame.gridSize}, priority: ${bestFrame.priority})`);
    } else {
      console.log(`  ${panelCount} panels → No suitable frame found`);
    }
  }

  // Test with strict mode (no non-uniform)
  console.log('\n🔒 Step 3: Testing strict mode (allowNonUniform: false)');
  const strictFrame = selectBestFrame(6, { allowNonUniform: false });
  console.log(`  6 panels (strict) → ${strictFrame ? strictFrame.id : 'No frame found'}`);

  const flexFrame = selectBestFrame(6, { allowNonUniform: true });
  console.log(`  6 panels (flexible) → ${flexFrame ? flexFrame.id : 'No frame found'}`);

  // Test template customization
  console.log('\n⚙️  Step 4: Testing template customization');

  // Disable a frame and test
  updateTemplateSettings('8_windowpane', {
    enabled: false,
    customName: 'Complex Window (Disabled)'
  });

  // Change priorities
  updateTemplateSettings('5_four_grid', { priority: 200 });
  updateTemplateSettings('2_two_horizontal', { priority: 150 });

  console.log('  Updated templates, checking new selection:');
  const newBestFrame = selectBestFrame(4);
  console.log(`  4 panels → ${newBestFrame ? newBestFrame.id : 'No frame found'}`);

  // Test preference updates
  console.log('\n🎛️  Step 5: Testing preference updates');

  updateAutoSelectPreferences({
    allowNonUniform: false,
    preferDominantPanel: false
  });

  updatePanPreferences({
    durationMsPerPage: 4000,
    ease: 'ease-in',
    magnitude: 0.25
  });

  console.log('  Updated preferences');

  // Show frame counts by panel count
  console.log('\n📊 Step 6: Frame distribution by panel count');

  for (let i = 1; i <= 5; i++) {
    const framesForCount = getFramesByPanelCount(i);
    const enabledCount = framesForCount.filter(f => f.enabled).length;
    console.log(`  ${i} panels: ${enabledCount}/${framesForCount.length} enabled frames`);

    framesForCount.forEach(frame => {
      const status = frame.enabled ? '✅' : '❌';
      const name = frame.customName || frame.id;
      console.log(`    ${status} ${name} (priority: ${frame.priority})`);
    });
  }

  // Final summary
  console.log('\n📈 Step 7: Final summary');
  logFrameSettings();

  // Test edge cases
  console.log('🧪 Step 8: Testing edge cases');

  // Re-enable all frames
  const allFrames = getMergedFrameData();
  for (const frame of allFrames) {
    updateTemplateSettings(frame.id, { enabled: true });
  }

  console.log(`  Re-enabled all ${allFrames.length} frames`);

  // Test very high panel count
  const impossibleFrame = selectBestFrame(20);
  console.log(`  20 panels → ${impossibleFrame ? impossibleFrame.id : 'No suitable frame (expected)'}`);

  console.log('\n✅ Frame Settings test completed successfully!');
}

main().catch(console.error);