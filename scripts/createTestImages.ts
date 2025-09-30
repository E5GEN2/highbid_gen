import sharp from 'sharp';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

async function createTestImages() {
  const testDir = join(process.cwd(), 'tmp', 'test-images');

  // Ensure test directory exists
  if (!existsSync(testDir)) {
    mkdirSync(testDir, { recursive: true });
  }

  console.log('🎨 Creating test images for storyboard composition...\n');

  const colors = [
    { name: 'Red', color: '#FF4444', text: '#FFFFFF' },
    { name: 'Blue', color: '#4444FF', text: '#FFFFFF' },
    { name: 'Green', color: '#44FF44', text: '#000000' },
    { name: 'Orange', color: '#FF8844', text: '#000000' },
    { name: 'Purple', color: '#8844FF', text: '#FFFFFF' },
    { name: 'Yellow', color: '#FFFF44', text: '#000000' },
    { name: 'Cyan', color: '#44FFFF', text: '#000000' },
    { name: 'Pink', color: '#FF44FF', text: '#000000' },
    { name: 'Lime', color: '#88FF44', text: '#000000' },
    { name: 'Teal', color: '#44FF88', text: '#000000' }
  ];

  const imagePaths: string[] = [];

  for (let i = 0; i < colors.length; i++) {
    const color = colors[i];
    const filename = `test_image_${String(i + 1).padStart(2, '0')}_${color.name.toLowerCase()}.jpg`;
    const filepath = join(testDir, filename);

    // Create SVG with number and color name
    const svg = `
      <svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="${color.color}"/>
        <text x="50%" y="40%" text-anchor="middle" font-family="Arial, sans-serif" font-size="120" font-weight="bold" fill="${color.text}">${i + 1}</text>
        <text x="50%" y="70%" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="normal" fill="${color.text}">${color.name}</text>
      </svg>
    `;

    // Convert SVG to JPEG
    await sharp(Buffer.from(svg))
      .jpeg({ quality: 90 })
      .toFile(filepath);

    imagePaths.push(filepath);
    console.log(`✅ Created: ${filename}`);
  }

  console.log(`\n📁 Test images saved to: ${testDir}`);
  console.log(`🖼️  Generated ${imagePaths.length} test images`);

  return imagePaths;
}

export { createTestImages };

if (require.main === module) {
  createTestImages().catch(console.error);
}