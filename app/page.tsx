'use client';

import React, { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import ProductSidebar from '@/components/ProductSidebar';
import ProductCard from '@/components/ProductCard';
import AuthButton from '@/components/AuthButton';

export default function Dashboard() {
  const { data: session } = useSession();
  const [visibleTabs, setVisibleTabs] = useState<string[]>([]);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(data => {
      if (data.visibleTabs) setVisibleTabs(data.visibleTabs);
    }).catch(() => {});
  }, []);

  const userName = session?.user?.name || session?.user?.email?.split('@')[0] || 'User';

  // Show product if any of its constituent tabs are visible (or show all if config not loaded yet)
  const showSpy = visibleTabs.length === 0 || visibleTabs.includes('spy') || visibleTabs.includes('feed');
  const showNiche = visibleTabs.length === 0 || visibleTabs.includes('niche');
  const showGenerator = visibleTabs.length === 0 || visibleTabs.includes('creator') || visibleTabs.includes('library') || visibleTabs.includes('clipping');

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex">
      {/* Dashboard Sidebar */}
      <ProductSidebar
        navItems={[
          {
            label: 'Dashboard',
            href: '/',
            icon: (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            ),
          },
        ]}
      />

      {/* Main content */}
      <main className="ml-60 flex-1 min-h-screen">
        {/* Welcome header */}
        <div className="px-8 pt-10 pb-6">
          <h1 className="text-2xl font-bold text-white">
            Welcome {userName}!
          </h1>
        </div>

        {/* Product cards heading */}
        <div className="px-8 pb-6">
          <h2 className="text-lg font-semibold text-white">Explore our most popular products</h2>
        </div>

        {/* Product cards grid */}
        <div className="px-8 pb-12 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {showSpy && (
            <ProductCard
              name="Shorts Feed Spy"
              subtitle="Track Trending YouTube Shorts & Rising Channels"
              href="/shorts-spy"
              accentColor="red"
              icon={
                <svg className="w-7 h-7 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              }
              features={[
                { title: 'Track rising channels', desc: 'Discover new Shorts channels blowing up right now' },
                { title: 'Full-screen feed viewer', desc: 'Browse Shorts in an immersive TikTok-style feed' },
                { title: 'Growth analytics', desc: 'See subscriber growth, view velocity, and channel age' },
              ]}
            />
          )}

          {showNiche && (
            <ProductCard
              name="Niche Finder"
              subtitle="Easily Find Exploding Niches"
              href="/niche"
              accentColor="amber"
              icon={
                <svg className="w-7 h-7 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              }
              features={[
                { title: 'Explore niche keywords', desc: 'Search and sort through hundreds of researched niches' },
                { title: 'Analyze channels & videos', desc: 'Deep-dive into what content performs best per niche' },
                { title: 'Saturation insights', desc: 'Know how saturated a niche is before committing' },
              ]}
            />
          )}

          {showGenerator && (
            <ProductCard
              name="Video Generator"
              subtitle="AI-Powered Video Production Pipeline"
              href="/generator"
              accentColor="purple"
              icon={
                <svg className="w-7 h-7 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              }
              features={[
                { title: '7-step production pipeline', desc: 'From script to final video with AI at every step' },
                { title: 'Project library', desc: 'Save, load, and manage all your video projects' },
                { title: 'Video clipping tool', desc: 'Upload long videos and auto-extract the best clips' },
              ]}
            />
          )}
        </div>
      </main>
    </div>
  );
}
