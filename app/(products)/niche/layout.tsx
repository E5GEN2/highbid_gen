'use client';

import React from 'react';
import ProductSidebar, { NavItem } from '@/components/ProductSidebar';
import TopBar from '@/components/TopBar';
import { NicheProvider, useNiche } from '@/components/NicheProvider';
import { SimilarModalProvider } from '@/components/SimilarModal';
import { usePathname, useSearchParams } from 'next/navigation';

function NicheLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { selectedKeyword } = useNiche();

  // Similar route → show Similar + Videos/Insights tabs under Niches
  const similarMatch = pathname.match(/^\/niche\/similar\/([^/]+)/);
  const similarVideoId = similarMatch ? similarMatch[1] : null;

  // Preserve ?cluster=X when switching between Videos/Insights tabs so the
  // sub-niche filter doesn't get dropped on tab navigation.
  const clusterParam = searchParams.get('cluster');
  const clusterQuery = clusterParam ? `?cluster=${clusterParam}` : '';

  // Build nav items — "Niches" gets dynamic children when a keyword is selected
  // OR when we're inside a /niche/similar/[id] route
  const navItems: NavItem[] = [
    {
      label: 'Overview',
      href: '/niche',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      ),
    },
    {
      label: 'Niches',
      href: '/niche/niches',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
        </svg>
      ),
      dynamicChildren: true,
      activeLabel: similarVideoId
        ? `Similar video`
        : selectedKeyword ? decodeURIComponent(selectedKeyword) : undefined,
      activeChildren: similarVideoId ? [
        { label: 'Videos', href: `/niche/similar/${similarVideoId}/videos` },
        { label: 'Insights', href: `/niche/similar/${similarVideoId}/insights` },
      ] : selectedKeyword ? [
        { label: 'Videos', href: `/niche/niches/${encodeURIComponent(selectedKeyword)}/videos${clusterQuery}` },
        { label: 'Channels', href: `/niche/niches/${encodeURIComponent(selectedKeyword)}/channels` },
        { label: 'Insights', href: `/niche/niches/${encodeURIComponent(selectedKeyword)}/insights${clusterQuery}` },
      ] : undefined,
    },
  ];

  // Build breadcrumbs from pathname
  const segments: Array<{ label: string; href?: string }> = [{ label: 'Niche Finder', href: '/niche' }];
  if (pathname.startsWith('/niche/niches')) {
    segments.push({ label: 'Niches', href: '/niche/niches' });
    // Extract keyword from URL if present
    const match = pathname.match(/\/niche\/niches\/([^/]+)/);
    if (match) {
      const kw = decodeURIComponent(match[1]);
      segments.push({ label: kw, href: `/niche/niches/${match[1]}/videos` });
      if (pathname.includes('/videos')) segments.push({ label: 'Videos' });
      else if (pathname.includes('/channels')) segments.push({ label: 'Channels' });
      else if (pathname.includes('/insights')) segments.push({ label: 'Insights' });
    }
  } else if (pathname.startsWith('/niche/similar/') && similarVideoId) {
    segments.push({ label: 'Niches', href: '/niche/niches' });
    segments.push({ label: 'Similar video', href: `/niche/similar/${similarVideoId}/videos` });
    if (pathname.includes('/videos')) segments.push({ label: 'Videos' });
    else if (pathname.includes('/insights')) segments.push({ label: 'Insights' });
  } else {
    segments.push({ label: 'Overview' });
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex">
      <ProductSidebar
        productName="Niche Finder"
        accentColor="amber"
        navItems={navItems}
        backHref="/"
      />
      <div className="ml-60 flex-1 flex flex-col min-h-screen">
        <TopBar segments={segments} />
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}

export default function NicheLayout({ children }: { children: React.ReactNode }) {
  return (
    <NicheProvider>
      <SimilarModalProvider>
        <NicheLayoutInner>{children}</NicheLayoutInner>
      </SimilarModalProvider>
    </NicheProvider>
  );
}
