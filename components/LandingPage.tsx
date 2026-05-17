'use client';

import React from 'react';
import { signIn } from 'next-auth/react';

/**
 * Marketing landing page shown to signed-out visitors at the bare
 * domain. Signed-in users hit either the dashboard (default) or
 * /niche (if the admin `homepage_to_niche` flag is on) — both
 * decided server-side in app/page.tsx before this component renders.
 *
 * Copy is built around the five "value prop" questions documented
 * in MEMORY.md (rising channels, growth speed, working niches/styles,
 * whether the user could do it, whether AI content is winning) —
 * those questions sell the data, the data sells the platform.
 */
export function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Top nav — sticky so the Sign-in CTA is always one click away
          regardless of how far down the user has scrolled. */}
      <header className="sticky top-0 z-50 bg-[#0a0a0a]/85 backdrop-blur-md border-b border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center font-bold text-sm">
              H
            </div>
            <span className="font-semibold tracking-tight">rofe.ai</span>
          </div>
          <button
            type="button"
            onClick={() => signIn('google')}
            className="px-4 py-1.5 rounded-full text-sm font-medium bg-white text-black hover:bg-white/90 transition"
          >
            Sign in
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Soft amber glow behind the headline so the page reads as
            "energetic" without going full neon. Position absolute so
            it doesn't push layout. */}
        <div
          aria-hidden
          className="absolute inset-x-0 -top-24 h-[480px] bg-gradient-to-b from-amber-500/20 via-amber-500/5 to-transparent blur-3xl pointer-events-none"
        />
        <div className="relative max-w-5xl mx-auto px-6 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-white/70 mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            New channels indexed every hour
          </div>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight leading-[1.05] mb-6">
            Find what&apos;s <span className="text-amber-400">exploding</span> on YouTube
            <br className="hidden sm:block" />
            before everyone else does.
          </h1>
          <p className="text-lg sm:text-xl text-white/70 max-w-2xl mx-auto mb-10 leading-relaxed">
            Track rising Shorts channels, discover ground-floor niches, and produce
            videos with AI — all from one dashboard.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => signIn('google')}
              className="group inline-flex items-center gap-2 px-6 py-3 rounded-full bg-white text-black font-semibold hover:bg-white/90 transition"
            >
              {/* Google "G" mark inline so we don't have to ship an
                  external asset. Just the recognizable colored G. */}
              <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden>
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A10.99 10.99 0 0012 23z"/>
                <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 015.5 12c0-.73.13-1.45.34-2.1V7.07H2.18A11 11 0 001 12c0 1.77.42 3.45 1.18 4.93l3.66-2.83z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z"/>
              </svg>
              Sign in with Google
              <svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </button>
          </div>
          <p className="text-xs text-white/40 mt-6">
            Free to try · No credit card required
          </p>
        </div>
      </section>

      {/* Value-prop questions — the five hooks operators ask about
          their next channel idea. Each one lands on the same answer:
          "rofe.ai shows you." */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <h2 className="text-xs uppercase tracking-[0.2em] text-white/40 text-center mb-3">
          Answer the five questions that decide your next channel
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-8">
          {[
            { q: 'What new Shorts channels are blowing up right now that I haven’t heard of?', accent: 'from-red-500/15 to-transparent border-red-500/20' },
            { q: 'How fast can a brand-new channel actually grow on Shorts?',                       accent: 'from-amber-500/15 to-transparent border-amber-500/20' },
            { q: 'What niches and content styles are actually working right now?',                   accent: 'from-emerald-500/15 to-transparent border-emerald-500/20' },
            { q: 'Could I do this? What would it take?',                                             accent: 'from-blue-500/15 to-transparent border-blue-500/20' },
            { q: 'Is AI-generated content actually working on Shorts?',                              accent: 'from-purple-500/15 to-transparent border-purple-500/20' },
            { q: 'Which channels punch way above their subscriber count?',                           accent: 'from-pink-500/15 to-transparent border-pink-500/20' },
          ].map((item, i) => (
            <div
              key={i}
              className={`p-5 rounded-2xl border bg-gradient-to-br ${item.accent} hover:bg-white/[0.04] transition`}
            >
              <div className="text-2xl mb-2 text-white/30 font-bold">{String(i + 1).padStart(2, '0')}</div>
              <p className="text-sm text-white/85 leading-relaxed">{item.q}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Product showcase */}
      <section className="border-t border-white/5 bg-[#070707]">
        <div className="max-w-6xl mx-auto px-6 py-24">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-center mb-3">
            Three tools. One unfair advantage.
          </h2>
          <p className="text-white/60 text-center max-w-2xl mx-auto mb-16">
            Built for creators who&apos;d rather see the data than guess at it.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <ProductFeature
              accent="red"
              name="Shorts Feed Spy"
              tagline="Track trending channels & rising stars"
              bullets={[
                'New channels indexed hourly',
                'TikTok-style full-screen feed',
                'Growth analytics & velocity',
              ]}
              icon={
                <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              }
            />
            <ProductFeature
              accent="amber"
              name="Niche Finder"
              tagline="Discover what's working before it's saturated"
              bullets={[
                '4,000+ auto-clustered niches',
                'Opportunity scoring per niche',
                'Cosine search across signatures',
              ]}
              icon={
                <svg className="w-6 h-6 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              }
            />
            <ProductFeature
              accent="purple"
              name="Video Generator"
              tagline="Script to render with AI at every step"
              bullets={[
                '7-step production pipeline',
                'Project library & versioning',
                'Auto-clip long videos to Shorts',
              ]}
              icon={
                <svg className="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              }
            />
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="max-w-3xl mx-auto px-6 py-24 text-center">
        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
          Stop guessing.
          <br />
          Start shipping what works.
        </h2>
        <p className="text-white/60 mb-8">
          Sign in once with Google. Everything else is one click away.
        </p>
        <button
          type="button"
          onClick={() => signIn('google')}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-white text-black font-semibold hover:bg-white/90 transition"
        >
          Get started — free
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </button>
      </section>

      <footer className="border-t border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between text-xs text-white/40">
          <span>© {new Date().getFullYear()} rofe.ai</span>
          <span>Built for creators</span>
        </div>
      </footer>
    </div>
  );
}

/**
 * One column in the "three tools" showcase. Kept as a local helper
 * because the landing page is the only consumer — pulling it into
 * /components proper would just be ceremony.
 */
function ProductFeature({
  name, tagline, bullets, icon, accent,
}: {
  name: string;
  tagline: string;
  bullets: string[];
  icon: React.ReactNode;
  accent: 'red' | 'amber' | 'purple';
}) {
  const ring = {
    red:    'hover:border-red-500/30',
    amber:  'hover:border-amber-500/30',
    purple: 'hover:border-purple-500/30',
  }[accent];
  return (
    <div className={`p-7 rounded-2xl bg-[#0f0f0f] border border-white/5 ${ring} transition group`}>
      <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center mb-5 group-hover:bg-white/10 transition">
        {icon}
      </div>
      <h3 className="text-lg font-semibold mb-1">{name}</h3>
      <p className="text-sm text-white/60 mb-5 leading-relaxed">{tagline}</p>
      <ul className="space-y-2">
        {bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-white/80">
            <svg className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            {b}
          </li>
        ))}
      </ul>
    </div>
  );
}
