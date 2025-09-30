import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getFrameManifest } from './frameScanner';

export interface AutoSelectPreferences {
  allowNonUniform: boolean;
  preferDominantPanel: boolean;
}

export interface PanPreferences {
  durationMsPerPage: number;
  ease: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  magnitude: number; // 0.0 to 1.0, how much pan/zoom to apply
}

export interface FrameTemplateSettings {
  enabled: boolean;
  priority: number; // Higher priority frames are preferred for auto-selection
  customName?: string; // User-friendly override name
}

export interface FrameSettings {
  version: string;
  lastUpdated: string;
  autoSelect: AutoSelectPreferences;
  panAnimation: PanPreferences;
  templates: Record<string, FrameTemplateSettings>;
}

export interface MergedFrameData {
  id: string;
  filename: string;
  panelCount: number;
  gridSize: string;
  dominantPanel: number;
  enabled: boolean;
  priority: number;
  customName?: string;
  panels: any[];
  colorMap: Record<string, number>;
  bounds?: any;
  area?: number;
  centroid?: any;
  edgeTouch?: any;
}

const SETTINGS_PATH = join(process.cwd(), 'frames', 'settings.json');

export const DEFAULT_SETTINGS: FrameSettings = {
  version: '1.0',
  lastUpdated: new Date().toISOString(),
  autoSelect: {
    allowNonUniform: true,
    preferDominantPanel: true
  },
  panAnimation: {
    durationMsPerPage: 3000,
    ease: 'ease-in-out',
    magnitude: 0.15
  },
  templates: {}
};

export function getFrameSettings(): FrameSettings {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));

      // Merge with defaults to ensure all properties exist
      return {
        ...DEFAULT_SETTINGS,
        ...settings,
        autoSelect: { ...DEFAULT_SETTINGS.autoSelect, ...settings.autoSelect },
        panAnimation: { ...DEFAULT_SETTINGS.panAnimation, ...settings.panAnimation }
      };
    }
  } catch (error) {
    console.error('Error loading frame settings:', error);
  }

  return DEFAULT_SETTINGS;
}

export function saveFrameSettings(settings: FrameSettings): void {
  try {
    settings.lastUpdated = new Date().toISOString();
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log('✅ Frame settings saved successfully');
  } catch (error) {
    console.error('❌ Error saving frame settings:', error);
    throw error;
  }
}

export function initializeFrameSettings(): FrameSettings {
  const manifest = getFrameManifest();
  let settings = getFrameSettings();
  let hasChanges = false;

  // Auto-detect new frames from manifest and add them to settings
  for (const frameId of Object.keys(manifest.frames)) {
    if (!settings.templates[frameId]) {
      settings.templates[frameId] = {
        enabled: true,
        priority: getPriorityForFrame(manifest.frames[frameId])
      };
      hasChanges = true;
      console.log(`📝 Auto-detected new frame: ${frameId}`);
    }
  }

  // Remove settings for frames that no longer exist
  for (const frameId of Object.keys(settings.templates)) {
    if (!manifest.frames[frameId]) {
      delete settings.templates[frameId];
      hasChanges = true;
      console.log(`🗑️  Removed settings for deleted frame: ${frameId}`);
    }
  }

  if (hasChanges) {
    saveFrameSettings(settings);
  }

  return settings;
}

function getPriorityForFrame(frameData: any): number {
  // Auto-assign priorities based on frame characteristics
  const { panelCount, gridSize } = frameData;

  // Standard grid layouts get higher priority
  if (gridSize === '1x1') return 100; // Single panel - highest priority
  if (gridSize === '2x1' || gridSize === '1x2') return 90; // Simple splits
  if (gridSize === '2x2') return 80; // Four grid

  // Custom layouts get priority based on panel count
  if (panelCount === 2) return 70;
  if (panelCount === 3) return 60;
  if (panelCount === 4) return 50;
  if (panelCount >= 5) return 40; // Complex layouts

  return 30; // Default fallback
}

export function updateTemplateSettings(frameId: string, updates: Partial<FrameTemplateSettings>): void {
  const settings = getFrameSettings();

  if (!settings.templates[frameId]) {
    throw new Error(`Frame template ${frameId} not found in settings`);
  }

  settings.templates[frameId] = { ...settings.templates[frameId], ...updates };
  saveFrameSettings(settings);
}

export function updateAutoSelectPreferences(preferences: Partial<AutoSelectPreferences>): void {
  const settings = getFrameSettings();
  settings.autoSelect = { ...settings.autoSelect, ...preferences };
  saveFrameSettings(settings);
}

export function updatePanPreferences(preferences: Partial<PanPreferences>): void {
  const settings = getFrameSettings();
  settings.panAnimation = { ...settings.panAnimation, ...preferences };
  saveFrameSettings(settings);
}

export function getMergedFrameData(): MergedFrameData[] {
  const manifest = getFrameManifest();
  const settings = initializeFrameSettings(); // This will auto-detect new frames

  const mergedFrames: MergedFrameData[] = [];

  for (const [frameId, frameData] of Object.entries(manifest.frames)) {
    const templateSettings = settings.templates[frameId];

    if (templateSettings) {
      mergedFrames.push({
        id: frameData.id,
        filename: frameData.filename,
        panelCount: frameData.panelCount,
        gridSize: frameData.gridSize,
        dominantPanel: frameData.dominantPanel,
        enabled: templateSettings.enabled,
        priority: templateSettings.priority,
        customName: templateSettings.customName,
        panels: frameData.panels,
        colorMap: frameData.colorMap,
        bounds: frameData.panels[frameData.dominantPanel]?.bounds,
        area: frameData.panels[frameData.dominantPanel]?.area,
        centroid: frameData.panels[frameData.dominantPanel]?.centroid,
        edgeTouch: frameData.panels[frameData.dominantPanel]?.edgeTouch
      });
    }
  }

  // Sort by priority (highest first), then by panel count (simpler first)
  return mergedFrames.sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    return a.panelCount - b.panelCount;
  });
}

export function getEnabledFrames(): MergedFrameData[] {
  return getMergedFrameData().filter(frame => frame.enabled);
}

export function getFramesByPanelCount(panelCount: number): MergedFrameData[] {
  return getEnabledFrames().filter(frame => frame.panelCount === panelCount);
}

export function selectBestFrame(
  requiredPanelCount: number,
  preferences?: Partial<AutoSelectPreferences>
): MergedFrameData | null {
  const settings = getFrameSettings();
  const finalPreferences = { ...settings.autoSelect, ...preferences };

  let candidates = getFramesByPanelCount(requiredPanelCount);

  // If no exact matches and non-uniform is allowed, expand search
  if (candidates.length === 0 && finalPreferences.allowNonUniform) {
    // Try frames with more panels first (can leave some empty)
    candidates = getEnabledFrames().filter(frame => frame.panelCount >= requiredPanelCount);

    if (candidates.length === 0) {
      // If still no matches, try frames with fewer panels (some content will be grouped)
      candidates = getEnabledFrames().filter(frame => frame.panelCount < requiredPanelCount);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // If preferDominantPanel is true, prefer frames where the dominant panel is well-positioned
  if (finalPreferences.preferDominantPanel) {
    candidates.sort((a, b) => {
      const aHasCenteredDominant = a.dominantPanel === 0 && a.panels[0]?.edgeTouch?.top;
      const bHasCenteredDominant = b.dominantPanel === 0 && b.panels[0]?.edgeTouch?.top;

      if (aHasCenteredDominant !== bHasCenteredDominant) {
        return bHasCenteredDominant ? 1 : -1;
      }

      // Secondary sort by dominant panel area
      const aArea = a.area || 0;
      const bArea = b.area || 0;
      return bArea - aArea;
    });
  }

  return candidates[0];
}

export function logFrameSettings(): void {
  const settings = getFrameSettings();
  const mergedData = getMergedFrameData();

  console.log('\n📊 Frame Settings Summary:');
  console.log(`Auto-select: allowNonUniform=${settings.autoSelect.allowNonUniform}, preferDominantPanel=${settings.autoSelect.preferDominantPanel}`);
  console.log(`Pan animation: ${settings.panAnimation.durationMsPerPage}ms, ${settings.panAnimation.ease}, magnitude=${settings.panAnimation.magnitude}`);
  console.log(`\n📋 Frame Templates (${mergedData.length} total):`);

  mergedData.forEach(frame => {
    const status = frame.enabled ? '✅' : '❌';
    const name = frame.customName || frame.id;
    console.log(`  ${status} ${name} (${frame.panelCount} panels, ${frame.gridSize}, priority: ${frame.priority})`);
  });

  const enabledCount = mergedData.filter(f => f.enabled).length;
  console.log(`\n🎯 ${enabledCount}/${mergedData.length} templates enabled\n`);
}