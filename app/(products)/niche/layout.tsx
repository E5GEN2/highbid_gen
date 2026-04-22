'use client';

import React from 'react';
import ProductSidebar, { NavItem } from '@/components/ProductSidebar';
import TopBar from '@/components/TopBar';
import { NicheProvider, useNiche } from '@/components/NicheProvider';
import { SimilarModalProvider } from '@/components/SimilarModal';
import { FavouritesProvider } from '@/components/FavouritesProvider';
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
    {
      // Dedicated outliers surface — peer-bucket-scored channels with their
      // best videos shown as a Nexlev-style grid. Distinct from the all-DB
      // Videos tab below because it only shows videos where the channel has
      // a computed peer_outlier_score.
      label: 'Outliers',
      href: '/niche/outliers',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
        </svg>
      ),
    },
    {
      // All-DB videos view (no niche filter). Useful for outlier discovery
      // across the whole corpus — many rows aren't tagged to any niche yet
      // but still have view/subs/score data worth searching.
      label: 'Videos',
      href: '/niche/videos',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      // All-DB channels view (no niche filter). Same table as niche-scoped
      // Channels but the grouping spans every keyword, so a single channel
      // surfaces once even if it appears in multiple niches.
      label: 'Channels',
      href: '/niche/channels',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      ),
    },
    {
      label: 'Favourites',
      href: '/niche/favourites',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
        </svg>
      ),
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
  } else if (pathname.startsWith('/niche/favourites')) {
    segments.push({ label: 'Favourites' });
  } else if (pathname.startsWith('/niche/videos')) {
    segments.push({ label: 'Videos' });
  } else if (pathname.startsWith('/niche/channels')) {
    segments.push({ label: 'Channels' });
  } else if (pathname.startsWith('/niche/outliers')) {
    segments.push({ label: 'Outliers' });
  } else if (pathname.startsWith('/niche/similar/') && similarVideoId) {
    segments.push({ label: 'Niches', href: '/niche/niches' });
    segments.push({ label: 'Similar video', href: `/niche/similar/${similarVideoId}/videos` });
    if (pathname.includes('/videos')) segments.push({ label: 'Videos' });
    else if (pathname.includes('/insights')) segments.push({ label: 'Insights' });
  } else {
    segments.push({ label: 'Overview' });
  }

  return (
    // `overflow-x-hidden` on the outermost wrapper is belt-and-braces: if any
    // descendant (hover tooltip, popover, modal) accidentally extends past
    // the viewport's right edge, the browser would otherwise enable
    // horizontal scrolling on <body>. That shifts the page left while the
    // fixed sidebar stays put, so the leftmost column of content appears to
    // slide behind the sidebar. Clipping overflow-x here guarantees the
    // page can never horizontally scroll, regardless of what any nested
    // absolute-positioned element does.
    <div className="min-h-screen bg-[#0a0a0a] flex overflow-x-hidden">
      <ProductSidebar
        productName="Niche Finder"
        accentColor="amber"
        navItems={navItems}
        backHref="/"
      />
      {/* min-w-0 is critical: flex items default to min-width: auto, which
          expands to their content's intrinsic width. Without it, any wide
          child (card grid, wide table, long unbroken text) pushes this flex
          child past the viewport, the ml-60 gets "absorbed" by the overflow,
          and the left side of the content gets clipped behind the fixed
          sidebar. min-w-0 lets the flex child shrink and forces overflow to
          be handled inside, not by the page itself. */}
      <div className="ml-60 flex-1 min-w-0 flex flex-col min-h-screen">
        <TopBar segments={segments} />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}

export default function NicheLayout({ children }: { children: React.ReactNode }) {
  return (
    <NicheProvider>
      <FavouritesProvider>
        <SimilarModalProvider>
          {/* Suspense boundary required because NicheLayoutInner uses
              useSearchParams() — without this, Next.js bails out of static
              generation for every child page. */}
          <React.Suspense fallback={null}>
            <NicheLayoutInner>{children}</NicheLayoutInner>
          </React.Suspense>
        </SimilarModalProvider>
      </FavouritesProvider>
    </NicheProvider>
  );
}
