import { getFrameSettings } from './frameSettings';
import { CompositionResult } from './storyboardCompositor';

export interface PanRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanKeyframe {
  t: number; // Time normalized 0.0 to 1.0
  rect: PanRect;
}

export interface PanAnimation {
  durationMs: number;
  ease: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'inOutSine';
  keyframes: PanKeyframe[];
}

export interface PanOptions {
  durationMs?: number;
  ease?: PanAnimation['ease'];
  magnitude?: number; // 0.0 to 1.0, how much zoom/pan to apply
  targetDominantPanel?: boolean;
  direction?: 'auto' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
}

// Canvas dimensions
const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;

// Direction patterns for alternation
const DIRECTION_PATTERNS = [
  'top-left',
  'top-right',
  'bottom-right',
  'bottom-left',
  'center'
] as const;

export function generateKenBurnsPan(
  compositionResult: CompositionResult,
  frameData: any,
  pageIndex: number,
  options?: PanOptions
): PanAnimation {
  const settings = getFrameSettings();

  const finalOptions: Required<PanOptions> = {
    durationMs: options?.durationMs ?? settings.panAnimation.durationMsPerPage,
    ease: options?.ease ?? settings.panAnimation.ease as PanAnimation['ease'],
    magnitude: options?.magnitude ?? settings.panAnimation.magnitude,
    targetDominantPanel: options?.targetDominantPanel ?? true,
    direction: options?.direction ?? 'auto'
  };

  // End keyframe is always the full page
  const endRect: PanRect = {
    x: 0,
    y: 0,
    w: CANVAS_WIDTH,
    h: CANVAS_HEIGHT
  };

  // Calculate start rect based on options
  const startRect = calculateStartRect(
    frameData,
    compositionResult,
    pageIndex,
    finalOptions
  );

  const keyframes: PanKeyframe[] = [
    { t: 0.0, rect: startRect },
    { t: 1.0, rect: endRect }
  ];

  return {
    durationMs: finalOptions.durationMs,
    ease: finalOptions.ease,
    keyframes
  };
}

function calculateStartRect(
  frameData: any,
  compositionResult: CompositionResult,
  pageIndex: number,
  options: Required<PanOptions>
): PanRect {
  // If magnitude is 0, no pan effect (start = end)
  if (options.magnitude === 0) {
    return {
      x: 0,
      y: 0,
      w: CANVAS_WIDTH,
      h: CANVAS_HEIGHT
    };
  }

  let targetCenter: { x: number; y: number };

  // Determine target center point
  if (options.targetDominantPanel && frameData.dominantPanel !== undefined) {
    // Target the dominant panel center
    const dominantPanel = frameData.panels[frameData.dominantPanel];
    if (dominantPanel) {
      targetCenter = {
        x: dominantPanel.bounds.x + dominantPanel.bounds.width / 2,
        y: dominantPanel.bounds.y + dominantPanel.bounds.height / 2
      };
    } else {
      targetCenter = getAlternatingDirection(pageIndex);
    }
  } else {
    // Use alternating directions or specified direction
    if (options.direction === 'auto') {
      targetCenter = getAlternatingDirection(pageIndex);
    } else {
      targetCenter = getDirectionCenter(options.direction);
    }
  }

  // Calculate scale factor based on magnitude
  // magnitude 0.0 = no zoom (scale = 1.0)
  // magnitude 1.0 = maximum zoom (scale = 1.5)
  const minScale = 1.0;
  const maxScale = 1.5;
  const scale = minScale + (options.magnitude * (maxScale - minScale));

  // Calculate start rect dimensions
  const startWidth = Math.round(CANVAS_WIDTH / scale);
  const startHeight = Math.round(CANVAS_HEIGHT / scale);

  // Calculate start position to center on target
  let startX = Math.round(targetCenter.x - startWidth / 2);
  let startY = Math.round(targetCenter.y - startHeight / 2);

  // Ensure start rect stays within canvas bounds
  startX = Math.max(0, Math.min(startX, CANVAS_WIDTH - startWidth));
  startY = Math.max(0, Math.min(startY, CANVAS_HEIGHT - startHeight));

  return {
    x: startX,
    y: startY,
    w: startWidth,
    h: startHeight
  };
}

function getAlternatingDirection(pageIndex: number): { x: number; y: number } {
  const directionIndex = pageIndex % DIRECTION_PATTERNS.length;
  const direction = DIRECTION_PATTERNS[directionIndex];
  return getDirectionCenter(direction);
}

function getDirectionCenter(direction: string): { x: number; y: number } {
  const margin = 100; // Pixels from edge for off-center positions

  switch (direction) {
    case 'top-left':
      return { x: margin, y: margin };

    case 'top-right':
      return { x: CANVAS_WIDTH - margin, y: margin };

    case 'bottom-left':
      return { x: margin, y: CANVAS_HEIGHT - margin };

    case 'bottom-right':
      return { x: CANVAS_WIDTH - margin, y: CANVAS_HEIGHT - margin };

    case 'center':
    default:
      return { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
  }
}

export function generatePanAnimationsForStoryboard(
  compositionResults: CompositionResult[],
  frameManifest: any,
  options?: PanOptions
): PanAnimation[] {
  const animations: PanAnimation[] = [];

  for (let i = 0; i < compositionResults.length; i++) {
    const result = compositionResults[i];
    const frameData = frameManifest.frames[result.frameId];

    if (!frameData) {
      console.warn(`Frame data not found for ${result.frameId}, using default pan`);
      // Create default pan animation
      animations.push(createDefaultPanAnimation(options));
      continue;
    }

    const animation = generateKenBurnsPan(result, frameData, i, options);
    animations.push(animation);
  }

  return animations;
}

function createDefaultPanAnimation(options?: PanOptions): PanAnimation {
  const settings = getFrameSettings();

  return {
    durationMs: options?.durationMs ?? settings.panAnimation.durationMsPerPage,
    ease: options?.ease ?? settings.panAnimation.ease as PanAnimation['ease'],
    keyframes: [
      { t: 0.0, rect: { x: 0, y: 0, w: CANVAS_WIDTH, h: CANVAS_HEIGHT } },
      { t: 1.0, rect: { x: 0, y: 0, w: CANVAS_WIDTH, h: CANVAS_HEIGHT } }
    ]
  };
}

export function exportPanAnimations(
  animations: PanAnimation[],
  outputPath?: string
): string {
  const data = {
    version: '1.0',
    generated: new Date().toISOString(),
    canvasSize: {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT
    },
    totalPages: animations.length,
    animations: animations.map((anim, index) => ({
      pageIndex: index,
      ...anim
    }))
  };

  if (outputPath) {
    const fs = require('fs');
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
    console.log(`✅ Pan animations exported to: ${outputPath}`);
  }

  return JSON.stringify(data, null, 2);
}

export function validatePanAnimation(animation: PanAnimation): string[] {
  const errors: string[] = [];

  // Validate duration
  if (animation.durationMs <= 0) {
    errors.push('Duration must be positive');
  }

  // Validate keyframes
  if (animation.keyframes.length !== 2) {
    errors.push('Must have exactly 2 keyframes');
  }

  // Validate keyframe timing
  if (animation.keyframes.length >= 2) {
    const first = animation.keyframes[0];
    const last = animation.keyframes[animation.keyframes.length - 1];

    if (first.t !== 0.0) {
      errors.push('First keyframe must have t=0.0');
    }

    if (last.t !== 1.0) {
      errors.push('Last keyframe must have t=1.0');
    }
  }

  // Validate rect bounds
  animation.keyframes.forEach((keyframe, index) => {
    const rect = keyframe.rect;

    if (rect.x < 0 || rect.y < 0) {
      errors.push(`Keyframe ${index}: rect position cannot be negative`);
    }

    if (rect.w <= 0 || rect.h <= 0) {
      errors.push(`Keyframe ${index}: rect dimensions must be positive`);
    }

    if (rect.x + rect.w > CANVAS_WIDTH || rect.y + rect.h > CANVAS_HEIGHT) {
      errors.push(`Keyframe ${index}: rect extends beyond canvas bounds`);
    }
  });

  return errors;
}

export function visualizePanAnimations(animations: PanAnimation[]): string {
  const lines: string[] = [];

  lines.push(`🎬 Ken Burns Pan Animations Summary`);
  lines.push(`Total pages: ${animations.length}`);
  lines.push('');

  animations.forEach((animation, index) => {
    const start = animation.keyframes[0].rect;
    const end = animation.keyframes[1].rect;

    const scaleX = end.w / start.w;
    const scaleY = end.h / start.h;
    const avgScale = (scaleX + scaleY) / 2;

    lines.push(`📄 Page ${index + 1}:`);
    lines.push(`  Duration: ${animation.durationMs}ms`);
    lines.push(`  Ease: ${animation.ease}`);
    lines.push(`  Scale factor: ${avgScale.toFixed(2)}x`);
    lines.push(`  Start rect: (${start.x}, ${start.y}) ${start.w}×${start.h}`);
    lines.push(`  End rect: (${end.x}, ${end.y}) ${end.w}×${end.h}`);

    // Validate animation
    const errors = validatePanAnimation(animation);
    if (errors.length > 0) {
      lines.push(`  ❌ Validation errors: ${errors.join(', ')}`);
    } else {
      lines.push(`  ✅ Valid animation`);
    }
  });

  return lines.join('\n');
}