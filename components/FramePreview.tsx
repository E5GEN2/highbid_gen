'use client';

import React, { useState, useEffect } from 'react';
import { FrameTemplate } from '../lib/settingsContext';

interface FramePreviewProps {
  template: FrameTemplate;
  size?: number;
  showPanels?: boolean;
  className?: string;
}

export function FramePreview({
  template,
  size = 120,
  showPanels = true,
  className = ''
}: FramePreviewProps) {
  const [imageError, setImageError] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  // Reset states when template changes
  useEffect(() => {
    setImageError(false);
    setImageLoaded(false);
  }, [template.id]);

  const handleImageLoad = () => {
    setImageLoaded(true);
    setImageError(false);
  };

  const handleImageError = () => {
    setImageError(true);
    setImageLoaded(false);
  };

  // Fallback preview when image fails to load
  const FallbackPreview = () => (
    <div
      className={`flex items-center justify-center bg-gray-100 border-2 border-dashed border-gray-300 rounded ${className}`}
      style={{ width: size, height: size * (1920/1080) }}
    >
      <div className="text-center p-2">
        <div className="text-lg font-bold text-gray-500 mb-1">
          {template.panelCount}
        </div>
        <div className="text-xs text-gray-400">
          {template.grid}
        </div>
      </div>
    </div>
  );

  // Loading placeholder
  const LoadingPreview = () => (
    <div
      className={`flex items-center justify-center bg-gray-50 border border-gray-200 rounded animate-pulse ${className}`}
      style={{ width: size, height: size * (1920/1080) }}
    >
      <div className="text-gray-400">
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </div>
    </div>
  );

  if (imageError) {
    return <FallbackPreview />;
  }

  return (
    <div className="relative">
      {!imageLoaded && <LoadingPreview />}
      <img
        src={`/frames/${template.filename}`}
        alt={`${template.name} frame preview`}
        className={`${imageLoaded ? 'block' : 'hidden'} object-contain border border-gray-200 rounded ${className}`}
        style={{
          width: size,
          height: size * (1920/1080),
          imageRendering: 'crisp-edges'
        }}
        onLoad={handleImageLoad}
        onError={handleImageError}
      />

      {/* Panel overlay indicators */}
      {showPanels && imageLoaded && template.panelCount > 0 && (
        <div className="absolute top-1 right-1 bg-black bg-opacity-60 text-white text-xs px-1.5 py-0.5 rounded">
          {template.panelCount}
        </div>
      )}

      {/* Dominant panel indicator */}
      {showPanels && imageLoaded && template.dominantPanel !== undefined && (
        <div className="absolute top-1 left-1 bg-blue-500 text-white text-xs px-1.5 py-0.5 rounded">
          D{template.dominantPanel}
        </div>
      )}
    </div>
  );
}

interface FramePreviewGridProps {
  templates: FrameTemplate[];
  selectedTemplate?: string;
  onTemplateSelect?: (templateId: string) => void;
  previewSize?: number;
}

export function FramePreviewGrid({
  templates,
  selectedTemplate,
  onTemplateSelect,
  previewSize = 100
}: FramePreviewGridProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {templates.map((template) => (
        <div
          key={template.id}
          className={`cursor-pointer transition-all duration-200 ${
            selectedTemplate === template.id
              ? 'ring-2 ring-blue-500 shadow-lg'
              : 'hover:ring-2 hover:ring-gray-300 hover:shadow-md'
          }`}
          onClick={() => onTemplateSelect?.(template.id)}
        >
          <FramePreview
            template={template}
            size={previewSize}
            className="rounded-lg"
          />
          <div className="mt-1 text-xs text-center">
            <div className="font-medium truncate">{template.name}</div>
            <div className="text-gray-500">{template.panelCount} panels</div>
          </div>
        </div>
      ))}
    </div>
  );
}