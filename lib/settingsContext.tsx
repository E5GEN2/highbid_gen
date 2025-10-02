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
    // Return fallback templates if API fails
    return [
      {
        id: 'single_panel',
        name: 'Single Panel',
        panelCount: 1,
        grid: 'single',
        description: '1 panel layout',
        edges: 'rounded',
        enabled: true,
        filename: 'single_panel.png'
      }
    ];
  }
}

function getDefaultSettings(): SettingsState {
  return {
    frameTemplates: [],
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