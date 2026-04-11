'use client';

import React from 'react';
import { useParams } from 'next/navigation';

export default function NicheInsights() {
  const { keyword } = useParams<{ keyword: string }>();
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-4">Insights — {decodeURIComponent(keyword)}</h1>
      <p className="text-[#888]">Timeline + saturation — coming soon.</p>
    </div>
  );
}
