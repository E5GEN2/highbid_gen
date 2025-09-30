import { getEnabledFrames, getFrameSettings, MergedFrameData } from './frameSettings';

export interface PagePlan {
  frameId: string;
  panelCount: number;
  imageIndexes: number[];
  frameData?: MergedFrameData;
}

export interface PlanningOptions {
  preferDominantPanel?: boolean;
  allowNonUniform?: boolean;
  maxImagesPerPage?: number;
}

export interface PlanningResult {
  pages: PagePlan[];
  totalImages: number;
  totalPages: number;
  efficiency: number; // Percentage of panel slots filled
  unusedPanels: number;
}

export function createPagePlan(
  imageCount: number,
  options?: PlanningOptions
): PlanningResult {
  const settings = getFrameSettings();
  const finalOptions: Required<PlanningOptions> = {
    preferDominantPanel: options?.preferDominantPanel ?? settings.autoSelect.preferDominantPanel,
    allowNonUniform: options?.allowNonUniform ?? settings.autoSelect.allowNonUniform,
    maxImagesPerPage: options?.maxImagesPerPage ?? 5
  };

  if (imageCount <= 0) {
    return {
      pages: [],
      totalImages: 0,
      totalPages: 0,
      efficiency: 0,
      unusedPanels: 0
    };
  }

  const availableFrames = getEnabledFrames();
  if (availableFrames.length === 0) {
    throw new Error('No enabled frame templates available');
  }

  const pages = planPagesGreedy(imageCount, availableFrames, finalOptions);
  const stats = calculatePlanStats(pages, imageCount);

  return {
    pages,
    totalImages: imageCount,
    totalPages: pages.length,
    efficiency: stats.efficiency,
    unusedPanels: stats.unusedPanels
  };
}

function planPagesGreedy(
  remainingImages: number,
  availableFrames: MergedFrameData[],
  options: Required<PlanningOptions>
): PagePlan[] {
  const pages: PagePlan[] = [];
  let currentImageIndex = 0;

  // Sort frames by panel count (descending) and priority
  const sortedFrames = [...availableFrames].sort((a, b) => {
    // Primary sort: panel count (prefer higher capacity: 5,4,3,2,1)
    if (a.panelCount !== b.panelCount) {
      return b.panelCount - a.panelCount;
    }

    // Secondary sort: priority (higher priority first)
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }

    // Tertiary sort: deterministic by ID
    return a.id.localeCompare(b.id);
  });

  while (remainingImages > 0) {
    const bestFrame = selectBestFrameForRemaining(
      remainingImages,
      sortedFrames,
      options
    );

    const imagesToTake = Math.min(remainingImages, bestFrame.panelCount);

    pages.push({
      frameId: bestFrame.id,
      panelCount: bestFrame.panelCount,
      imageIndexes: Array.from(
        { length: imagesToTake },
        (_, i) => currentImageIndex + i
      ),
      frameData: bestFrame
    });

    currentImageIndex += imagesToTake;
    remainingImages -= imagesToTake;
  }

  return pages;
}

function selectBestFrameForRemaining(
  remainingImages: number,
  sortedFrames: MergedFrameData[],
  options: Required<PlanningOptions>
): MergedFrameData {
  // Filter frames within maxImagesPerPage limit
  const viableFrames = sortedFrames.filter(frame =>
    frame.panelCount <= options.maxImagesPerPage
  );

  if (viableFrames.length === 0) {
    // Fallback: use any frame if no viable frames
    return sortedFrames[sortedFrames.length - 1];
  }

  // Find exact matches first (highest priority)
  const exactMatches = viableFrames.filter(frame =>
    frame.panelCount === remainingImages
  );

  if (exactMatches.length > 0) {
    return selectWithDominantPanelBias(exactMatches, options.preferDominantPanel);
  }

  // If allowNonUniform is false, try oversized frames only
  if (!options.allowNonUniform) {
    const oversizedFrames = viableFrames.filter(frame =>
      frame.panelCount > remainingImages
    );

    if (oversizedFrames.length > 0) {
      // Prefer the smallest oversized frame to minimize waste
      const minOversize = oversizedFrames.reduce((min, frame) =>
        frame.panelCount < min.panelCount ? frame : min
      );
      return minOversize;
    }

    // If no exact or oversized matches, use largest viable frame
    return viableFrames[0];
  }

  // Greedy approach: select largest viable frame (preferring 5,4,3,2,1)
  // This maximizes capacity utilization
  return selectWithDominantPanelBias([viableFrames[0]], options.preferDominantPanel);
}

function selectWithDominantPanelBias(
  candidates: MergedFrameData[],
  preferDominantPanel: boolean
): MergedFrameData {
  if (!preferDominantPanel || candidates.length === 1) {
    return candidates[0];
  }

  // Score frames based on dominant panel characteristics
  const scoredFrames = candidates.map(frame => ({
    frame,
    score: calculateDominantPanelScore(frame)
  }));

  // Sort by score (higher is better), then by priority, then by ID for determinism
  scoredFrames.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    if (a.frame.priority !== b.frame.priority) {
      return b.frame.priority - a.frame.priority;
    }
    return a.frame.id.localeCompare(b.frame.id);
  });

  return scoredFrames[0].frame;
}

function calculateDominantPanelScore(frame: MergedFrameData): number {
  let score = 0;

  // Base score from area
  if (frame.area) {
    const areaRatio = frame.area / (1080 * 1920); // Normalize to canvas size
    score += areaRatio * 100;
  }

  // Bonus for dominant panel being the first panel (index 0)
  if (frame.dominantPanel === 0) {
    score += 50;
  }

  // Bonus for panels that touch certain edges (hero positioning)
  if (frame.edgeTouch) {
    if (frame.edgeTouch.top) score += 20;
    if (frame.edgeTouch.left) score += 10;
    if (frame.edgeTouch.right) score += 10;
  }

  // Bonus for certain grid layouts that work well for hero content
  switch (frame.gridSize) {
    case '1x1': score += 100; break; // Full splash is always hero
    case 'custom': score += 30; break; // Custom layouts often have hero panels
    case '2x1':
    case '1x2': score += 20; break; // Simple splits can work for hero
    default: score += 0; break;
  }

  return score;
}

function calculatePlanStats(pages: PagePlan[], totalImages: number) {
  const totalPanels = pages.reduce((sum, page) => sum + page.panelCount, 0);
  const usedPanels = totalImages;
  const unusedPanels = totalPanels - usedPanels;
  const efficiency = totalPanels > 0 ? (usedPanels / totalPanels) * 100 : 0;

  return { efficiency, unusedPanels };
}

export function optimizePagePlan(plan: PlanningResult): PlanningResult {
  // Try different strategies and pick the best one
  const strategies = [
    { preferDominantPanel: true, allowNonUniform: true },
    { preferDominantPanel: false, allowNonUniform: true },
    { preferDominantPanel: true, allowNonUniform: false },
    { preferDominantPanel: false, allowNonUniform: false }
  ];

  const candidates = strategies.map(options =>
    createPagePlan(plan.totalImages, options)
  );

  // Score each candidate (prefer higher efficiency, fewer pages)
  const scoredCandidates = candidates.map(candidate => ({
    plan: candidate,
    score: calculatePlanScore(candidate)
  }));

  // Sort by score (higher is better)
  scoredCandidates.sort((a, b) => b.score - a.score);

  return scoredCandidates[0].plan;
}

function calculatePlanScore(plan: PlanningResult): number {
  let score = 0;

  // Primary factor: efficiency (0-100)
  score += plan.efficiency * 2;

  // Secondary factor: fewer pages is better
  score -= plan.totalPages * 5;

  // Tertiary factor: prefer plans that use higher-capacity frames
  const avgPanelsPerPage = plan.pages.reduce((sum, page) => sum + page.panelCount, 0) / plan.totalPages;
  score += avgPanelsPerPage * 3;

  return score;
}

export function visualizePlan(plan: PlanningResult): string {
  const lines: string[] = [];

  lines.push(`📋 Page Plan Summary (${plan.totalImages} images → ${plan.totalPages} pages)`);
  lines.push(`📊 Efficiency: ${plan.efficiency.toFixed(1)}% (${plan.unusedPanels} unused panels)`);
  lines.push('');

  plan.pages.forEach((page, index) => {
    const frameInfo = page.frameData ?
      `${page.frameData.gridSize}, priority: ${page.frameData.priority}` :
      'unknown frame';

    lines.push(`📄 Page ${index + 1}: ${page.frameId} (${page.panelCount} panels, ${frameInfo})`);
    lines.push(`   Images: [${page.imageIndexes.join(', ')}]`);
  });

  return lines.join('\n');
}

export function validatePagePlan(plan: PlanningResult): string[] {
  const errors: string[] = [];

  // Check that all images are assigned exactly once
  const allAssignedImages = plan.pages.flatMap(page => page.imageIndexes);
  const expectedImages = Array.from({ length: plan.totalImages }, (_, i) => i);

  const missingImages = expectedImages.filter(img => !allAssignedImages.includes(img));
  const duplicateImages = allAssignedImages.filter((img, index) =>
    allAssignedImages.indexOf(img) !== index
  );

  if (missingImages.length > 0) {
    errors.push(`Missing images: [${missingImages.join(', ')}]`);
  }

  if (duplicateImages.length > 0) {
    errors.push(`Duplicate images: [${duplicateImages.join(', ')}]`);
  }

  // Check that no page exceeds its frame's panel count
  plan.pages.forEach((page, index) => {
    if (page.imageIndexes.length > page.panelCount) {
      errors.push(`Page ${index + 1}: ${page.imageIndexes.length} images exceed ${page.panelCount} panels`);
    }
  });

  return errors;
}