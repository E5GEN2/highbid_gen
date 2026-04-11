'use client';

import React from 'react';
import ProductSidebar from '@/components/ProductSidebar';
import TopBar from '@/components/TopBar';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  {
    label: 'Overview',
    href: '/shorts-spy',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    label: 'Feed',
    href: '/shorts-spy/feed',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    label: 'Channels',
    href: '/shorts-spy/channels',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

function getBreadcrumbs(pathname: string): Array<{ label: string; href?: string }> {
  const segments: Array<{ label: string; href?: string }> = [{ label: 'Shorts Feed Spy', href: '/shorts-spy' }];
  if (pathname.includes('/feed')) segments.push({ label: 'Feed' });
  else if (pathname.includes('/channels')) segments.push({ label: 'Channels' });
  else segments.push({ label: 'Overview' });
  return segments;
}

export default function ShortSpyLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex">
      <ProductSidebar
        productName="Shorts Feed Spy"
        accentColor="red"
        navItems={NAV_ITEMS}
        backHref="/"
        collapsible={pathname.includes('/feed')}
      />
      <div className="ml-60 flex-1 flex flex-col min-h-screen max-md:ml-0">
        <TopBar segments={getBreadcrumbs(pathname)} />
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}
