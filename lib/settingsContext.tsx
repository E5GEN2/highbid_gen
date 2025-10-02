'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export interface FrameTemplate {
  id: string;
  name: string;
  panelCount: number;
  grid: string;
  description: string;
  edges: string;
  enabled: boolean;
  filename: string;
  dominantPanel?: number;
}

export interface AutoSelectPreferences {
  allowNonUniform: boolean;
  preferDominantPanel: boolean;
  maxImagesPerPage: number;
}

export interface PanSettings {
  durationMsPerPage: number;
  ease: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'inOutSine';
  magnitude: number;
  targetDominantPanel: boolean;
}

export interface SettingsState {
  frameTemplates: FrameTemplate[];
  autoSelectPreferences: AutoSelectPreferences;
  panSettings: PanSettings;
}

interface SettingsContextType {
  settings: SettingsState;
  updateFrameTemplate: (id: string, updates: Partial<FrameTemplate>) => void;
  updateAutoSelectPreferences: (updates: Partial<AutoSelectPreferences>) => void;
  updatePanSettings: (updates: Partial<PanSettings>) => void;
  resetToDefaults: () => void;
  getEnabledFrames: () => FrameTemplate[];
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

// Default templates to use before API loads or if API fails
const DEFAULT_TEMPLATES: FrameTemplate[] = [
  {
    id: '1_full_splash',
    name: 'Full Splash',
    panelCount: 1,
    grid: '1x1',
    description: 'Single panel layout',
    edges: 'top, bottom, left, right',
    enabled: true,
    filename: '1_full_splash.png',
    dominantPanel: 0
  },
  {
    id: '2_two_horizontal',
    name: 'Two Horizontal',
    panelCount: 2,
    grid: '2x1',
    description: '2 panel horizontal layout',
    edges: 'top, bottom, left, right',
    enabled: true,
    filename: '2_two_horizontal.png',
    dominantPanel: 0
  },
  {
    id: '3_three_horizontal',
    name: 'Three Horizontal',
    panelCount: 3,
    grid: 'custom',
    description: '3 panel horizontal layout',
    edges: 'top, bottom, left, right',
    enabled: true,
    filename: '3_three_horizontal.png',
    dominantPanel: 0
  }
];

async function loadFrameTemplatesFromAPI(): Promise<FrameTemplate[]> {
  try {
    const response = await fetch('/api/frame-settings');
    if (!response.ok) {
      throw new Error('Failed to fetch frame templates');
    }
    const data = await response.json();
    return data.frameTemplates;
  } catch (error) {
    console.error('Error loading frame templates:', error);
    // Return default templates if API fails
    return DEFAULT_TEMPLATES;
  }
}

function getDefaultSettings(): SettingsState {
  return {
    frameTemplates: DEFAULT_TEMPLATES,
    autoSelectPreferences: {
      allowNonUniform: true,
      preferDominantPanel: true,
      maxImagesPerPage: 5
    },
    panSettings: {
      durationMsPerPage: 4000,
      ease: 'inOutSine',
      magnitude: 0.5,
      targetDominantPanel: true
    }
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingsState>(getDefaultSettings);

  useEffect(() => {
    async function loadTemplates() {
      try {
        const templates = await loadFrameTemplatesFromAPI();
        setSettings(prev => ({
          ...prev,
          frameTemplates: templates
        }));
      } catch (error) {
        console.error('Failed to load frame templates:', error);
      }
    }
    loadTemplates();
  }, []);

  const updateFrameTemplate = (id: string, updates: Partial<FrameTemplate>) => {
    setSettings(prev => ({
      ...prev,
      frameTemplates: prev.frameTemplates.map(template =>
        template.id === id ? { ...template, ...updates } : template
      )
    }));
  };

  const updateAutoSelectPreferences = (updates: Partial<AutoSelectPreferences>) => {
    setSettings(prev => ({
      ...prev,
      autoSelectPreferences: { ...prev.autoSelectPreferences, ...updates }
    }));
  };

  const updatePanSettings = (updates: Partial<PanSettings>) => {
    setSettings(prev => ({
      ...prev,
      panSettings: { ...prev.panSettings, ...updates }
    }));
  };

  const resetToDefaults = async () => {
    try {
      const templates = await loadFrameTemplatesFromAPI();
      setSettings({
        ...getDefaultSettings(),
        frameTemplates: templates
      });
    } catch (error) {
      console.error('Failed to reload frame templates:', error);
      setSettings(getDefaultSettings());
    }
  };

  const getEnabledFrames = () => {
    return settings.frameTemplates.filter(template => template.enabled);
  };

  const value: SettingsContextType = {
    settings,
    updateFrameTemplate,
    updateAutoSelectPreferences,
    updatePanSettings,
    resetToDefaults,
    getEnabledFrames
  };

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}