'use client';

import React, { useState } from 'react';
import { useSettings, FrameTemplate } from '../lib/settingsContext';
import { FramePreview } from './FramePreview';

interface FrameTemplateRowProps {
  template: FrameTemplate;
  onToggle: (id: string, enabled: boolean) => void;
}

function FrameTemplateRow({ template, onToggle }: FrameTemplateRowProps) {
  return (
    <tr className={`border-b border-gray-600 ${template.enabled ? 'bg-gray-800/50' : 'bg-gray-900/30'}`}>
      <td className="px-4 py-3">
        <label className="flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={template.enabled}
            onChange={(e) => onToggle(template.id, e.target.checked)}
            className="w-4 h-4 text-blue-400 bg-gray-700 border-gray-500 rounded focus:ring-blue-400 focus:ring-offset-gray-800"
          />
          <span className="ml-2 text-sm font-medium text-white">
            {template.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
      </td>
      <td className="px-4 py-3">
        <div className="font-medium text-white">{template.name}</div>
      </td>
      <td className="px-4 py-3 text-center">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-900/50 text-blue-300">
          {template.panelCount}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-300">{template.grid}</span>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-300">{template.description}</span>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-300">{template.edges}</span>
      </td>
      <td className="px-4 py-3">
        <FramePreview template={template} size={60} showPanels={true} />
      </td>
    </tr>
  );
}

function FrameTemplatesSection() {
  const { settings, updateFrameTemplate } = useSettings();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterEnabled, setFilterEnabled] = useState<'all' | 'enabled' | 'disabled'>('all');

  const handleToggleAll = (enabled: boolean) => {
    settings.frameTemplates.forEach(template => {
      updateFrameTemplate(template.id, { enabled });
    });
  };

  const filteredTemplates = settings.frameTemplates.filter(template => {
    const matchesSearch = template.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         template.description.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesFilter = filterEnabled === 'all' ||
                         (filterEnabled === 'enabled' && template.enabled) ||
                         (filterEnabled === 'disabled' && !template.enabled);

    return matchesSearch && matchesFilter;
  });

  const enabledCount = settings.frameTemplates.filter(t => t.enabled).length;
  const totalCount = settings.frameTemplates.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-white">Frame Templates</h3>
          <p className="text-sm text-gray-300">
            {enabledCount} of {totalCount} templates enabled
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleToggleAll(true)}
            className="px-3 py-1 text-sm bg-green-900/50 text-green-300 rounded hover:bg-green-800/70"
          >
            Enable All
          </button>
          <button
            onClick={() => handleToggleAll(false)}
            className="px-3 py-1 text-sm bg-red-900/50 text-red-300 rounded hover:bg-red-800/70"
          >
            Disable All
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4 items-center">
        <input
          type="text"
          placeholder="Search templates..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="flex-1 px-3 py-2 bg-gray-700 border border-gray-500 rounded-md text-white placeholder-gray-400 focus:ring-blue-400 focus:border-blue-400"
        />
        <select
          value={filterEnabled}
          onChange={(e) => setFilterEnabled(e.target.value as 'all' | 'enabled' | 'disabled')}
          className="px-3 py-2 bg-gray-700 border border-gray-500 rounded-md text-white focus:ring-blue-400 focus:border-blue-400"
        >
          <option value="all">All Templates</option>
          <option value="enabled">Enabled Only</option>
          <option value="disabled">Disabled Only</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-hidden shadow ring-1 ring-gray-600 ring-opacity-50 md:rounded-lg">
        <table className="min-w-full divide-y divide-gray-600">
          <thead className="bg-gray-800/70">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wide">
                Enabled
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wide">
                Name
              </th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-400 uppercase tracking-wide">
                Panels
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wide">
                Grid
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wide">
                Description
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wide">
                Edges
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wide">
                Preview
              </th>
            </tr>
          </thead>
          <tbody className="bg-gray-900/50 divide-y divide-gray-600">
            {filteredTemplates.map((template) => (
              <FrameTemplateRow
                key={template.id}
                template={template}
                onToggle={(id, enabled) => updateFrameTemplate(id, { enabled })}
              />
            ))}
          </tbody>
        </table>
      </div>

      {filteredTemplates.length === 0 && (
        <div className="text-center py-8 text-gray-400">
          No templates match your search criteria.
        </div>
      )}
    </div>
  );
}

function AutoSelectPreferencesSection() {
  const { settings, updateAutoSelectPreferences } = useSettings();
  const prefs = settings.autoSelectPreferences;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white">Auto-Selection Preferences</h3>
        <p className="text-sm text-gray-300">
          Configure how the system automatically selects frame templates
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div className="flex items-center">
            <input
              id="allowNonUniform"
              type="checkbox"
              checked={prefs.allowNonUniform}
              onChange={(e) => updateAutoSelectPreferences({ allowNonUniform: e.target.checked })}
              className="h-4 w-4 text-blue-600 border-gray-500 rounded focus:ring-blue-500"
            />
            <label htmlFor="allowNonUniform" className="ml-3 text-sm font-medium text-white">
              Allow Non-Uniform Layouts
            </label>
          </div>
          <p className="text-xs text-gray-400 ml-7">
            Enables mixing different frame types (e.g., 5-panel + 3-panel + 1-panel)
          </p>

          <div className="flex items-center">
            <input
              id="preferDominant"
              type="checkbox"
              checked={prefs.preferDominantPanel}
              onChange={(e) => updateAutoSelectPreferences({ preferDominantPanel: e.target.checked })}
              className="h-4 w-4 text-blue-600 border-gray-500 rounded focus:ring-blue-500"
            />
            <label htmlFor="preferDominant" className="ml-3 text-sm font-medium text-white">
              Prefer Dominant Panel Frames
            </label>
          </div>
          <p className="text-xs text-gray-400 ml-7">
            Prioritizes frames with designated hero/dominant panels
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="maxImages" className="block text-sm font-medium text-white">
              Max Images Per Page
            </label>
            <input
              id="maxImages"
              type="number"
              min="1"
              max="5"
              value={prefs.maxImagesPerPage}
              onChange={(e) => updateAutoSelectPreferences({
                maxImagesPerPage: Math.max(1, Math.min(5, parseInt(e.target.value) || 5))
              })}
              className="mt-1 block w-full px-3 py-2 border border-gray-500 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              Limits the maximum number of images per storyboard page
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function PanSettingsSection() {
  const { settings, updatePanSettings } = useSettings();
  const panSettings = settings.panSettings;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white">Camera Pan Settings</h3>
        <p className="text-sm text-gray-300">
          Configure Ken Burns camera movement animations
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div>
            <label htmlFor="duration" className="block text-sm font-medium text-white">
              Duration per Page (ms)
            </label>
            <input
              id="duration"
              type="number"
              min="500"
              max="10000"
              step="100"
              value={panSettings.durationMsPerPage}
              onChange={(e) => updatePanSettings({
                durationMsPerPage: Math.max(500, Math.min(10000, parseInt(e.target.value) || 4000))
              })}
              className="mt-1 block w-full px-3 py-2 border border-gray-500 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              How long each page animation takes (500-10000ms)
            </p>
          </div>

          <div>
            <label htmlFor="ease" className="block text-sm font-medium text-white">
              Easing Function
            </label>
            <select
              id="ease"
              value={panSettings.ease}
              onChange={(e) => updatePanSettings({ ease: e.target.value as 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'inOutSine' })}
              className="mt-1 block w-full px-3 py-2 border border-gray-500 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="linear">Linear</option>
              <option value="ease-in">Ease In</option>
              <option value="ease-out">Ease Out</option>
              <option value="ease-in-out">Ease In-Out</option>
              <option value="inOutSine">In-Out Sine</option>
            </select>
            <p className="text-xs text-gray-400 mt-1">
              Animation timing curve for pan motion
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="magnitude" className="block text-sm font-medium text-white">
              Pan Magnitude: {(panSettings.magnitude * 100).toFixed(0)}%
            </label>
            <input
              id="magnitude"
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={panSettings.magnitude}
              onChange={(e) => updatePanSettings({ magnitude: parseFloat(e.target.value) })}
              className="mt-1 block w-full"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>No zoom (0%)</span>
              <span>Max zoom (100%)</span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Controls how much zoom/pan effect is applied
            </p>
          </div>

          <div className="flex items-center">
            <input
              id="targetDominant"
              type="checkbox"
              checked={panSettings.targetDominantPanel}
              onChange={(e) => updatePanSettings({ targetDominantPanel: e.target.checked })}
              className="h-4 w-4 text-blue-600 border-gray-500 rounded focus:ring-blue-500"
            />
            <label htmlFor="targetDominant" className="ml-3 text-sm font-medium text-white">
              Target Dominant Panels
            </label>
          </div>
          <p className="text-xs text-gray-400 ml-7">
            Centers pan animation on dominant panels when available
          </p>
        </div>
      </div>
    </div>
  );
}

export function SettingsTab() {
  const { resetToDefaults } = useSettings();
  const [activeSection, setActiveSection] = useState('templates');

  const sections = [
    { id: 'templates', name: 'Frame Templates', icon: '🖼️' },
    { id: 'autoselect', name: 'Auto-Selection', icon: '🎯' },
    { id: 'pan', name: 'Camera Pan', icon: '🎬' }
  ];

  const handleResetDefaults = () => {
    if (window.confirm('Reset all settings to defaults? This cannot be undone.')) {
      resetToDefaults();
    }
  };

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-64 bg-gray-800/50 border-r border-gray-200 p-4">
        <div className="space-y-2">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
                activeSection === section.id
                  ? 'bg-blue-100 text-blue-700 font-medium'
                  : 'text-white hover:bg-gray-100'
              }`}
            >
              <span className="mr-2">{section.icon}</span>
              {section.name}
            </button>
          ))}
        </div>

        <div className="mt-8 pt-4 border-t border-gray-200">
          <button
            onClick={handleResetDefaults}
            className="w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-md transition-colors"
          >
            Reset to Defaults
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-6 overflow-y-auto">
        {activeSection === 'templates' && <FrameTemplatesSection />}
        {activeSection === 'autoselect' && <AutoSelectPreferencesSection />}
        {activeSection === 'pan' && <PanSettingsSection />}
      </div>
    </div>
  );
}