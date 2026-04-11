'use client';

import React from 'react';
import Link from 'next/link';

interface ProductCardProps {
  name: string;
  subtitle: string;
  href: string;
  icon: React.ReactNode;
  accentColor: string;
  features: Array<{ title: string; desc: string }>;
  previewContent?: React.ReactNode;
}

export default function ProductCard({
  name,
  subtitle,
  href,
  icon,
  accentColor,
  features,
  previewContent,
}: ProductCardProps) {
  const borderHoverColor =
    accentColor === 'red' ? 'hover:border-red-600/40' :
    accentColor === 'amber' ? 'hover:border-amber-600/40' :
    accentColor === 'purple' ? 'hover:border-purple-600/40' :
    'hover:border-[#333]';

  return (
    <Link
      href={href}
      className={`block bg-[#141414] border border-[#1f1f1f] rounded-2xl p-6 ${borderHoverColor} transition-all cursor-pointer group`}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 flex items-center justify-center flex-shrink-0">
          {icon}
        </div>
        <h3 className="text-lg font-bold text-white">{name}</h3>
      </div>

      {/* Subtitle */}
      <p className="text-sm text-[#888] mt-2">{subtitle}</p>

      {/* Preview area */}
      <div className="mt-4 rounded-xl bg-[#0a0a0a] border border-[#1a1a1a] h-48 overflow-hidden flex items-center justify-center">
        {previewContent || (
          <div className="text-[#333] text-sm">Preview</div>
        )}
      </div>

      {/* Feature list */}
      <div className="mt-5 space-y-3">
        {features.map((f, i) => (
          <div key={i} className="flex items-start gap-3">
            <div className="w-5 h-5 rounded flex-shrink-0 flex items-center justify-center bg-white/10 mt-0.5">
              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-medium text-white">{f.title}</div>
              <div className="text-xs text-[#666] mt-0.5">{f.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </Link>
  );
}
