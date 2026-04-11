'use client';

import React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';

export interface BreadcrumbSegment {
  label: string;
  href?: string;
}

interface TopBarProps {
  segments: BreadcrumbSegment[];
}

export default function TopBar({ segments }: TopBarProps) {
  const { data: session } = useSession();
  const initial = session?.user?.name?.[0]?.toUpperCase() || session?.user?.email?.[0]?.toUpperCase() || '?';

  return (
    <div className="h-14 px-6 flex items-center justify-between border-b border-[#1a1a1a] bg-[#0a0a0a]">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <Link href="/" className="text-[#888] hover:text-white transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
        </Link>
        {segments.map((seg, i) => (
          <React.Fragment key={i}>
            <span className="text-[#444]">·</span>
            {seg.href && i < segments.length - 1 ? (
              <Link href={seg.href} className="text-[#888] hover:text-white transition-colors">
                {seg.label}
              </Link>
            ) : (
              <span className={i === segments.length - 1 ? 'text-white font-medium' : 'text-[#888]'}>
                {seg.label}
              </span>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* User avatar */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-orange-600 flex items-center justify-center text-white text-sm font-bold">
          {initial}
        </div>
      </div>
    </div>
  );
}
