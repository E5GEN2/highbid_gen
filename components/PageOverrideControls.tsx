'use client';

import React, { useState, useEffect } from 'react';
import {
  StoryboardWithOverrides,
  PageOverride,
  OverrideContext,
  getFrameAlternatives,
  createOverrideContext,
  applyPageOverride,
  removePageOverride,
  getOverrideStatus
} from '../lib/storyboardOverrides';
import { MergedFrameData } from '../lib/frameSettings';
import { FramePreview } from './FramePreview';
import { FrameTemplate } from '../lib/settingsContext';

interface PageOverrideControlsProps {
  storyboardWithOverrides: StoryboardWithOverrides;
  onStoryboardChange: (newStoryboard: StoryboardWithOverrides) => void;
  loading?: boolean;
}

interface PageOverrideRowProps {
  pageIndex: number;
  currentFrameId: string;
  hasOverride: boolean;
  overrideFrameId?: string;
  panelCount: number;
  alternatives: MergedFrameData[];
  onApplyOverride: (pageIndex: number, frameId: string) => Promise<void>;
  onRemoveOverride: (pageIndex: number) => Promise<void>;
  loading: boolean;
}

function PageOverrideRow({
  pageIndex,
  currentFrameId,
  hasOverride,
  overrideFrameId,
  panelCount,
  alternatives,
  onApplyOverride,
  onRemoveOverride,
  loading
}: PageOverrideRowProps) {
  const [selectedFrameId, setSelectedFrameId] = useState(currentFrameId);
  const [isChanging, setIsChanging] = useState(false);

  useEffect(() => {
    setSelectedFrameId(currentFrameId);
  }, [currentFrameId]);

  const handleApplyOverride = async () => {
    if (selectedFrameId === currentFrameId || isChanging) return;

    setIsChanging(true);
    try {
      await onApplyOverride(pageIndex, selectedFrameId);
    } catch (error) {
      console.error('Failed to apply override:', error);
      setSelectedFrameId(currentFrameId); // Reset on error
    } finally {
      setIsChanging(false);
    }
  };

  const handleRemoveOverride = async () => {
    if (!hasOverride || isChanging) return;

    setIsChanging(true);
    try {
      await onRemoveOverride(pageIndex);
    } catch (error) {
      console.error('Failed to remove override:', error);
    } finally {
      setIsChanging(false);
    }
  };

  // Convert MergedFrameData to FrameTemplate for preview
  const currentFrameTemplate: FrameTemplate | undefined = alternatives.find(alt => alt.id === currentFrameId) ?
    {
      id: currentFrameId,
      name: alternatives.find(alt => alt.id === currentFrameId)?.customName || currentFrameId,
      panelCount,
      grid: 'custom',
      description: `${panelCount} panel layout`,
      edges: 'rounded',
      enabled: true,
      filename: alternatives.find(alt => alt.id === currentFrameId)?.filename || `${currentFrameId}.png`
    } : undefined;

  return (
    <tr className={`border-b border-gray-700 ${hasOverride ? 'bg-blue-900/20' : 'bg-transparent'}`}>
      <td className="px-4 py-3 text-center">
        <span className="font-medium text-white">#{pageIndex + 1}</span>
      </td>

      <td className="px-4 py-3 text-center">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
          {panelCount}
        </span>
      </td>

      <td className="px-4 py-3">
        <div className="flex items-center space-x-3">
          {currentFrameTemplate && (
            <FramePreview
              template={currentFrameTemplate}
              size={40}
              showPanels={false}
            />
          )}
          <div>
            <div className="font-medium text-white">{currentFrameId}</div>
            {hasOverride && (
              <div className="text-xs text-blue-400">Override applied</div>
            )}
          </div>
        </div>
      </td>

      <td className="px-4 py-3">
        <select
          value={selectedFrameId}
          onChange={(e) => setSelectedFrameId(e.target.value)}
          disabled={loading || isChanging}
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
        >
          <option value={currentFrameId}>
            {currentFrameId} {hasOverride ? '(current override)' : '(current)'}
          </option>
          {alternatives.map((frame) => (
            <option key={frame.id} value={frame.id}>
              {frame.customName || frame.id} ({frame.panelCount}p, priority: {frame.priority})
            </option>
          ))}
        </select>
      </td>

      <td className="px-4 py-3">
        <div className="flex space-x-2">
          {selectedFrameId !== currentFrameId && (
            <button
              onClick={handleApplyOverride}
              disabled={loading || isChanging}
              className="px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 transition"
            >
              {isChanging ? '...' : 'Apply'}
            </button>
          )}

          {hasOverride && (
            <button
              onClick={handleRemoveOverride}
              disabled={loading || isChanging}
              className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 transition"
            >
              {isChanging ? '...' : 'Reset'}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export function PageOverrideControls({
  storyboardWithOverrides,
  onStoryboardChange,
  loading = false
}: PageOverrideControlsProps) {
  const [processingPage, setProcessingPage] = useState<number | null>(null);

  const overrideStatus = getOverrideStatus(storyboardWithOverrides);

  const handleApplyOverride = async (pageIndex: number, frameId: string) => {
    setProcessingPage(pageIndex);
    try {
      const newStoryboard = await applyPageOverride(
        storyboardWithOverrides,
        pageIndex,
        frameId,
        storyboardWithOverrides.imagePaths
      );
      onStoryboardChange(newStoryboard);
    } finally {
      setProcessingPage(null);
    }
  };

  const handleRemoveOverride = async (pageIndex: number) => {
    setProcessingPage(pageIndex);
    try {
      const newStoryboard = await removePageOverride(
        storyboardWithOverrides,
        pageIndex,
        storyboardWithOverrides.imagePaths
      );
      onStoryboardChange(newStoryboard);
    } finally {
      setProcessingPage(null);
    }
  };

  const totalOverrides = overrideStatus.filter(page => page.hasOverride).length;
  const totalPages = overrideStatus.length;

  if (totalPages === 0) {
    return (
      <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-700">
        <h4 className="text-lg font-bold text-white mb-3">📝 Page Overrides</h4>
        <p className="text-gray-400">No storyboard pages available for override.</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h4 className="text-lg font-bold text-white">📝 Page Template Overrides</h4>
          <p className="text-sm text-gray-400">
            {totalOverrides} of {totalPages} pages have custom frame templates
          </p>
        </div>

        {totalOverrides > 0 && (
          <div className="text-sm text-blue-400">
            {totalOverrides} override{totalOverrides !== 1 ? 's' : ''} active
          </div>
        )}
      </div>

      <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 rounded-lg">
        <table className="min-w-full divide-y divide-gray-700">
          <thead className="bg-gray-800">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wide">
                Page
              </th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-300 uppercase tracking-wide">
                Panels
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wide">
                Current Template
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wide">
                Override Template
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wide">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-gray-900 divide-y divide-gray-700">
            {overrideStatus.map((page) => {
              const alternatives = getFrameAlternatives(page.pageIndex, storyboardWithOverrides.originalPlanningResult);
              const isProcessing = processingPage === page.pageIndex;

              return (
                <PageOverrideRow
                  key={page.pageIndex}
                  pageIndex={page.pageIndex}
                  currentFrameId={page.currentFrameId}
                  hasOverride={page.hasOverride}
                  overrideFrameId={page.overrideFrameId}
                  panelCount={storyboardWithOverrides.originalPlanningResult.pages[page.pageIndex].panelCount}
                  alternatives={alternatives}
                  onApplyOverride={handleApplyOverride}
                  onRemoveOverride={handleRemoveOverride}
                  loading={loading || isProcessing}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {loading && (
        <div className="mt-4 text-center">
          <div className="inline-flex items-center text-sm text-gray-400">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500 mr-2"></div>
            Processing override changes...
          </div>
        </div>
      )}
    </div>
  );
}