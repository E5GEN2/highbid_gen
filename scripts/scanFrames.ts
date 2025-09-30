import { scanFrames } from '../lib/frameScanner.js';

async function main() {
  try {
    await scanFrames();
    console.log('✅ Frame scanning completed successfully');
  } catch (error) {
    console.error('❌ Frame scanning failed:', error);
    process.exit(1);
  }
}

main();