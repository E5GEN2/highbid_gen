"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanFrames = scanFrames;
exports.getFrameManifest = getFrameManifest;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const pngjs_1 = require("pngjs");
const FRAMES_DIR = '/Users/rofeevgenii/Desktop/lab/highbidgen/frames';
const MANIFEST_PATH = (0, path_1.join)(FRAMES_DIR, 'manifest.json');
function rgbToHex(r, g, b) {
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}
function analyzeFrame(filename) {
    const filepath = (0, path_1.join)(FRAMES_DIR, filename);
    const buffer = (0, fs_1.readFileSync)(filepath);
    const stats = (0, fs_1.statSync)(filepath);
    const hash = (0, crypto_1.createHash)('md5').update(buffer).digest('hex');
    const png = pngjs_1.PNG.sync.read(buffer);
    const { width, height, data } = png;
    const colorMap = {};
    const pixelColors = [];
    // First pass: extract all colors and build pixel map
    for (let y = 0; y < height; y++) {
        pixelColors[y] = [];
        for (let x = 0; x < width; x++) {
            const idx = (width * y + x) << 2;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const a = data[idx + 3];
            if (a > 0) { // Only consider non-transparent pixels
                const color = rgbToHex(r, g, b);
                pixelColors[y][x] = color;
                colorMap[color] = (colorMap[color] || 0) + 1;
            }
            else {
                pixelColors[y][x] = 'transparent';
            }
        }
    }
    // Remove transparent from color map
    delete colorMap['transparent'];
    const uniqueColors = Object.keys(colorMap);
    const panels = [];
    // For each unique color, find connected regions (panels)
    uniqueColors.forEach((color, colorIndex) => {
        const visited = new Set();
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const key = `${x},${y}`;
                if (pixelColors[y][x] === color && !visited.has(key)) {
                    // Found a new region of this color - flood fill to get bounds
                    const region = floodFill(pixelColors, x, y, color, width, height, visited);
                    if (region.length > 100) { // Ignore small noise regions
                        const bounds = calculateBounds(region);
                        const area = region.length;
                        const centroid = calculateCentroid(region);
                        const edgeTouch = calculateEdgeTouch(bounds, width, height);
                        panels.push({
                            id: panels.length,
                            color,
                            bounds,
                            area,
                            centroid,
                            edgeTouch
                        });
                    }
                }
            }
        }
    });
    // Sort panels by area (largest first)
    panels.sort((a, b) => b.area - a.area);
    const dominantPanel = panels.length > 0 ? 0 : -1;
    // Determine grid size
    const gridSize = inferGridSize(panels, width, height);
    const frameId = filename.replace('.png', '');
    return {
        id: frameId,
        filename,
        panelCount: panels.length,
        gridSize,
        colorMap,
        panels,
        dominantPanel,
        hash,
        mtime: stats.mtimeMs
    };
}
function floodFill(pixelColors, startX, startY, targetColor, width, height, visited) {
    const stack = [{ x: startX, y: startY }];
    const region = [];
    while (stack.length > 0) {
        const { x, y } = stack.pop();
        const key = `${x},${y}`;
        if (visited.has(key) || x < 0 || x >= width || y < 0 || y >= height) {
            continue;
        }
        if (pixelColors[y][x] !== targetColor) {
            continue;
        }
        visited.add(key);
        region.push({ x, y });
        // Add neighbors
        stack.push({ x: x + 1, y });
        stack.push({ x: x - 1, y });
        stack.push({ x, y: y + 1 });
        stack.push({ x, y: y - 1 });
    }
    return region;
}
function calculateBounds(region) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const { x, y } of region) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    return {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1
    };
}
function calculateCentroid(region) {
    const sumX = region.reduce((sum, p) => sum + p.x, 0);
    const sumY = region.reduce((sum, p) => sum + p.y, 0);
    return {
        x: Math.round(sumX / region.length),
        y: Math.round(sumY / region.length)
    };
}
function calculateEdgeTouch(bounds, canvasWidth, canvasHeight) {
    const tolerance = 5; // pixels
    return {
        top: bounds.y <= tolerance,
        bottom: bounds.y + bounds.height >= canvasHeight - tolerance,
        left: bounds.x <= tolerance,
        right: bounds.x + bounds.width >= canvasWidth - tolerance
    };
}
function inferGridSize(panels, width, height) {
    if (panels.length === 1)
        return '1x1';
    if (panels.length === 2) {
        // Check if it's horizontal or vertical split
        const avgY = panels.reduce((sum, p) => sum + p.centroid.y, 0) / panels.length;
        const isHorizontalSplit = Math.abs(panels[0].centroid.y - panels[1].centroid.y) < height * 0.3;
        return isHorizontalSplit ? '1x2' : '2x1';
    }
    if (panels.length === 3)
        return 'custom';
    if (panels.length === 4) {
        // Check if it's a 2x2 grid
        const centroids = panels.map(p => p.centroid);
        const avgX = centroids.reduce((sum, c) => sum + c.x, 0) / centroids.length;
        const avgY = centroids.reduce((sum, c) => sum + c.y, 0) / centroids.length;
        let topLeft = 0, topRight = 0, bottomLeft = 0, bottomRight = 0;
        centroids.forEach((c) => {
            if (c.x < avgX && c.y < avgY)
                topLeft++;
            else if (c.x >= avgX && c.y < avgY)
                topRight++;
            else if (c.x < avgX && c.y >= avgY)
                bottomLeft++;
            else
                bottomRight++;
        });
        return (topLeft === 1 && topRight === 1 && bottomLeft === 1 && bottomRight === 1) ? '2x2' : 'custom';
    }
    return 'custom';
}
async function scanFrames() {
    console.log('🔍 Scanning frame masks for panel data...');
    // Load existing manifest if it exists
    let manifest;
    try {
        const existingManifest = JSON.parse((0, fs_1.readFileSync)(MANIFEST_PATH, 'utf8'));
        manifest = existingManifest;
    }
    catch {
        manifest = {
            version: '1.0',
            generated: new Date().toISOString(),
            canvas: { width: 1080, height: 1920 },
            frames: {}
        };
    }
    const frameFiles = [
        '1_full_splash.png',
        '2_two_horizontal.png',
        '3_three_horizontal.png',
        '4_two_vertical.png',
        '5_four_grid.png',
        '6_big_top_two_bottom.png',
        '7_l_shape.png',
        '8_windowpane.png',
        '9_diagonal_split.png',
        '10_inset.png'
    ];
    let scannedCount = 0;
    let updatedCount = 0;
    for (const filename of frameFiles) {
        const frameId = filename.replace('.png', '');
        try {
            const filepath = (0, path_1.join)(FRAMES_DIR, filename);
            const stats = (0, fs_1.statSync)(filepath);
            // Check if we need to rescan (file changed or not in manifest)
            const existing = manifest.frames[frameId];
            const needsRescan = !existing || existing.mtime !== stats.mtimeMs;
            if (needsRescan) {
                console.log(`📊 Analyzing ${filename}...`);
                const frameData = analyzeFrame(filename);
                manifest.frames[frameId] = frameData;
                updatedCount++;
                console.log(`   ${frameData.panelCount} panels, ${frameData.gridSize} grid, dominant: ${frameData.dominantPanel >= 0 ? frameData.panels[frameData.dominantPanel].color : 'none'}`);
            }
            else {
                console.log(`✅ ${filename} - cached (${existing.panelCount} panels)`);
            }
            scannedCount++;
        }
        catch (error) {
            console.error(`❌ Error analyzing ${filename}:`, error);
        }
    }
    // Update manifest metadata
    manifest.generated = new Date().toISOString();
    // Save updated manifest
    (0, fs_1.writeFileSync)(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log(`✅ Frame scan complete: ${scannedCount} scanned, ${updatedCount} updated`);
    console.log(`📝 Manifest saved to ${MANIFEST_PATH}`);
}
function getFrameManifest() {
    try {
        return JSON.parse((0, fs_1.readFileSync)(MANIFEST_PATH, 'utf8'));
    }
    catch {
        throw new Error('Frame manifest not found. Run scanFrames() first.');
    }
}
