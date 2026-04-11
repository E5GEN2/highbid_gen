'use client';

import React from 'react';

export default function ClippingPage() {
  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-1">Clipping</h1>
        <p className="text-sm text-[#888]">Upload long videos and auto-extract the best clips</p>
      </div>

      <div className="bg-[#141414] border border-[#1f1f1f] rounded-2xl p-8 text-center">
        <div className="text-5xl mb-4">✂️</div>
        <h2 className="text-xl font-semibold text-white mb-2">Video Clipping Tool</h2>
        <p className="text-[#888] max-w-md mx-auto">
          Upload &rarr; AI Analysis &rarr; Clip Selection &rarr; Face Detection &rarr; Smart Cutting
        </p>
        <p className="text-xs text-[#666] mt-4">Migration in progress — this page is being extracted from the legacy codebase.</p>
      </div>
    </div>
  );
}
