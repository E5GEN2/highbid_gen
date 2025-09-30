import { CompositionResult, CompositionOptions, composeStoryboard } from './storyboardCompositor';
import { PagePlan, PlanningResult, createPagePlan } from './pagePlanner';
import { getEnabledFrames, MergedFrameData } from './frameSettings';

export interface PageOverride {
  pageIndex: number;
  originalFrameId: string;
  overrideFrameId: string;
  panelCount: number;
  appliedAt: string;
}

export interface StoryboardWithOverrides {
  originalPlanningResult: PlanningResult;
  compositionResults: CompositionResult[];
  overrides: PageOverride[];
  imagePaths: string[];
}

export interface OverrideContext {
  pageIndex: number;
  currentFrameId: string;
  panelCount: number;
  imageIndexes: number[];
  availableAlternatives: MergedFrameData[];
}

/**
 * Get available frame templates that match the panel count of a specific page
 */
export function getFrameAlternatives(pageIndex: number, planningResult: PlanningResult): MergedFrameData[] {
  if (pageIndex >= planningResult.pages.length) {
    return [];
  }

  const currentPage = planningResult.pages[pageIndex];
  const requiredPanelCount = currentPage.panelCount;

  // Get all enabled frames with matching panel count
  const enabledFrames = getEnabledFrames();
  const alternatives = enabledFrames.filter(frame =>
    frame.panelCount === requiredPanelCount &&
    frame.id !== currentPage.frameId
  );

  // Sort by priority (highest first)
  return alternatives.sort((a, b) => b.priority - a.priority);
}

/**
 * Create override context for a specific page
 */
export function createOverrideContext(
  pageIndex: number,
  planningResult: PlanningResult
): OverrideContext | null {
  if (pageIndex >= planningResult.pages.length) {
    return null;
  }

  const currentPage = planningResult.pages[pageIndex];
  const alternatives = getFrameAlternatives(pageIndex, planningResult);

  return {
    pageIndex,
    currentFrameId: currentPage.frameId,
    panelCount: currentPage.panelCount,
    imageIndexes: currentPage.imageIndexes,
    availableAlternatives: alternatives
  };
}

/**
 * Apply a frame template override to a specific page
 */
export async function applyPageOverride(
  storyboardWithOverrides: StoryboardWithOverrides,
  pageIndex: number,
  newFrameId: string,
  imagePaths: string[],
  options?: CompositionOptions
): Promise<StoryboardWithOverrides> {
  const { originalPlanningResult, compositionResults, overrides } = storyboardWithOverrides;

  if (pageIndex >= originalPlanningResult.pages.length) {
    throw new Error(`Invalid page index: ${pageIndex}`);
  }

  const currentPage = originalPlanningResult.pages[pageIndex];

  // Validate that the new frame has the same panel count
  const enabledFrames = getEnabledFrames();
  const newFrame = enabledFrames.find(frame => frame.id === newFrameId);

  if (!newFrame) {
    throw new Error(`Frame template '${newFrameId}' not found or not enabled`);
  }

  if (newFrame.panelCount !== currentPage.panelCount) {
    throw new Error(`Frame template '${newFrameId}' has ${newFrame.panelCount} panels, but page requires ${currentPage.panelCount} panels`);
  }

  // Create modified planning result for the single page
  const modifiedPlanningResult: PlanningResult = {
    ...originalPlanningResult,
    pages: originalPlanningResult.pages.map((page, index) =>
      index === pageIndex
        ? { ...page, frameId: newFrameId, frameData: newFrame }
        : page
    )
  };

  // Recompose just the affected page
  const singlePagePlanningResult: PlanningResult = {
    pages: [modifiedPlanningResult.pages[pageIndex]],
    totalImages: modifiedPlanningResult.pages[pageIndex].imageIndexes.length,
    totalPages: 1,
    efficiency: modifiedPlanningResult.efficiency,
    unusedPanels: 0
  };

  const recomposedResults = await composeStoryboard(
    singlePagePlanningResult,
    imagePaths,
    options
  );

  if (recomposedResults.pages.length === 0) {
    throw new Error('Failed to recompose page');
  }

  // Update the composition results array
  const newCompositionResults = [...compositionResults];
  const recomposedPage = recomposedResults.pages[0];
  newCompositionResults[pageIndex] = {
    ...recomposedPage,
    pageIndex // Ensure correct page index
  };

  // Add or update the override record
  const newOverride: PageOverride = {
    pageIndex,
    originalFrameId: currentPage.frameId,
    overrideFrameId: newFrameId,
    panelCount: currentPage.panelCount,
    appliedAt: new Date().toISOString()
  };

  const newOverrides = overrides.filter(override => override.pageIndex !== pageIndex);
  newOverrides.push(newOverride);

  return {
    originalPlanningResult: modifiedPlanningResult,
    compositionResults: newCompositionResults,
    overrides: newOverrides,
    imagePaths
  };
}

/**
 * Remove an override and restore the original frame for a page
 */
export async function removePageOverride(
  storyboardWithOverrides: StoryboardWithOverrides,
  pageIndex: number,
  imagePaths: string[],
  options?: CompositionOptions
): Promise<StoryboardWithOverrides> {
  const { overrides } = storyboardWithOverrides;

  const existingOverride = overrides.find(override => override.pageIndex === pageIndex);
  if (!existingOverride) {
    return storyboardWithOverrides; // No override to remove
  }

  // Apply the original frame as an override (which will restore it)
  const restoredStoryboard = await applyPageOverride(
    storyboardWithOverrides,
    pageIndex,
    existingOverride.originalFrameId,
    imagePaths,
    options
  );

  // Remove the override record
  const newOverrides = restoredStoryboard.overrides.filter(
    override => override.pageIndex !== pageIndex
  );

  return {
    ...restoredStoryboard,
    overrides: newOverrides
  };
}

/**
 * Get override status for all pages
 */
export function getOverrideStatus(storyboardWithOverrides: StoryboardWithOverrides): {
  pageIndex: number;
  hasOverride: boolean;
  originalFrameId: string;
  currentFrameId: string;
  overrideFrameId?: string;
  appliedAt?: string;
}[] {
  const { originalPlanningResult, overrides } = storyboardWithOverrides;

  return originalPlanningResult.pages.map((page, index) => {
    const override = overrides.find(o => o.pageIndex === index);

    return {
      pageIndex: index,
      hasOverride: !!override,
      originalFrameId: page.frameId,
      currentFrameId: override ? override.overrideFrameId : page.frameId,
      overrideFrameId: override?.overrideFrameId,
      appliedAt: override?.appliedAt
    };
  });
}

/**
 * Create initial storyboard with overrides from planning and composition results
 */
export function createStoryboardWithOverrides(
  planningResult: PlanningResult,
  compositionResults: CompositionResult[],
  imagePaths: string[]
): StoryboardWithOverrides {
  return {
    originalPlanningResult: planningResult,
    compositionResults,
    overrides: [],
    imagePaths
  };
}

/**
 * Export override configuration as JSON
 */
export function exportOverrides(storyboardWithOverrides: StoryboardWithOverrides): string {
  const exportData = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    overrides: storyboardWithOverrides.overrides,
    pageCount: storyboardWithOverrides.originalPlanningResult.pages.length,
    totalImages: storyboardWithOverrides.originalPlanningResult.totalImages
  };

  return JSON.stringify(exportData, null, 2);
}

/**
 * Import override configuration from JSON
 */
export function importOverrides(
  storyboardWithOverrides: StoryboardWithOverrides,
  overridesJson: string
): PageOverride[] {
  try {
    const importData = JSON.parse(overridesJson);

    if (!importData.overrides || !Array.isArray(importData.overrides)) {
      throw new Error('Invalid overrides format');
    }

    // Validate that overrides are compatible with current storyboard
    const maxPageIndex = storyboardWithOverrides.originalPlanningResult.pages.length - 1;
    const validOverrides = importData.overrides.filter((override: any) =>
      override.pageIndex >= 0 &&
      override.pageIndex <= maxPageIndex &&
      override.originalFrameId &&
      override.overrideFrameId &&
      override.panelCount
    );

    return validOverrides;
  } catch (error) {
    throw new Error(`Failed to import overrides: ${error}`);
  }
}