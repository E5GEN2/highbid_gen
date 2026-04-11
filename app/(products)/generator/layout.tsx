'use client';

import React from 'react';
import { SettingsProvider } from '@/lib/settingsContext';
import ProductSidebar from '@/components/ProductSidebar';
import TopBar from '@/components/TopBar';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  {
    label: 'Create',
    href: '/generator/create',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </svg>
    ),
  },
  {
    label: 'Library',
    href: '/generator/library',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    ),
  },
  {
    label: 'Clipping',
    href: '/generator/clipping',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
      </svg>
    ),
  },
];

function getBreadcrumbs(pathname: string): Array<{ label: string; href?: string }> {
  const segments: Array<{ label: string; href?: string }> = [{ label: 'Video Generator', href: '/generator' }];
  if (pathname.includes('/create')) segments.push({ label: 'Create' });
  else if (pathname.includes('/library')) segments.push({ label: 'Library' });
  else if (pathname.includes('/clipping')) segments.push({ label: 'Clipping' });
  return segments;
}

export default function GeneratorLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <SettingsProvider>
      <div className="min-h-screen bg-[#0a0a0a] flex">
        <ProductSidebar
          productName="Video Generator"
          accentColor="purple"
          navItems={NAV_ITEMS}
          backHref="/"
          showApiToken
        />
        <div className="ml-60 flex-1 flex flex-col min-h-screen">
          <TopBar segments={getBreadcrumbs(pathname)} />
          <div className="flex-1">{children}</div>
        </div>
      </div>
    </SettingsProvider>
  );
}
