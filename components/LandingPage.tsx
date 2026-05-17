'use client';

import React from 'react';
import { signIn } from 'next-auth/react';

/**
 * Marketing landing page shown to signed-out visitors at the bare
 * domain. Dark-theme variant — matches the in-app surface
 * (#070707, white text, amber accent) so the visual language is
 * continuous from landing → product.
 *
 * Structure follows viewstats.com/info — sticky header, centered
 * hero with screenshot below, interstitial claim, 3×2 feature
 * grid with screenshot-style mockups, big stats panel, CTA bridge,
 * split-layout final CTA. No pricing section.
 *
 * Copy stays human. No "kNN", "HDBSCAN", "cosine similarity" —
 * those are mechanisms. We describe what the user does, not what
 * the code does.
 */
export function LandingPage() {
  return (
    <div className="min-h-screen bg-[#070707] text-white antialiased selection:bg-amber-400/30">
      <Header />
      <Hero />
      <DecodedSection />
      <FeatureGrid />
      <DataAdvantage />
      <CtaBridge />
      <FinalCta />
      <Footer />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Header
 * ──────────────────────────────────────────────────────────────── */

function Header() {
  return (
    <header className="sticky top-0 z-50 bg-[#070707]/85 backdrop-blur-xl border-b border-white/[0.06]">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-md bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-black font-bold text-sm">
            R
          </div>
          <span className="font-semibold text-[16px] tracking-tight">
            rofe<span className="text-white/40">.ai</span>
          </span>
        </a>

        <nav className="hidden md:flex items-center gap-7 text-[14px] text-white/70">
          <a href="#features"  className="hover:text-white transition">Features</a>
          <a href="#data"      className="hover:text-white transition">Data</a>
          <a href="#workflow"  className="hover:text-white transition">How it works</a>
        </nav>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => signIn('google')}
            className="hidden sm:inline px-3.5 py-2 text-[13px] text-white/70 hover:text-white transition"
          >
            Log in
          </button>
          <button
            type="button"
            onClick={() => signIn('google')}
            className="px-4 py-2 rounded-full text-[13px] font-semibold bg-amber-400 text-black hover:bg-amber-300 transition"
          >
            Sign up free
          </button>
        </div>
      </div>
    </header>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Hero — centered, big headline, two CTAs, screenshot below
 * ──────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Amber radial glow anchored to the top — single light source
          on an otherwise pitch-black page. Matches the in-app
          amber-hover accent so the brand stays consistent. */}
      <div
        aria-hidden
        className="absolute inset-x-0 -top-32 h-[700px] bg-[radial-gradient(ellipse_at_top,_rgba(251,191,36,0.18),_rgba(251,191,36,0.04)_40%,_transparent_70%)] pointer-events-none"
      />
      <div className="relative max-w-5xl mx-auto px-6 pt-16 sm:pt-24 pb-20 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-[12px] text-white/70 font-medium mb-8 backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          4,164 niches indexed · refreshed every hour
        </div>

        <h1 className="text-[44px] sm:text-[64px] lg:text-[76px] font-bold tracking-[-0.035em] leading-[1.02] mb-6">
          Find the videos and niches
          <br />
          <span className="text-amber-400">about to blow up.</span>
        </h1>

        <p className="text-[18px] sm:text-[20px] text-white/65 max-w-2xl mx-auto leading-[1.55] mb-10">
          See what&apos;s working on YouTube before everyone else does. Search by what you
          mean, drill into trending niches, and watch new channels break through —
          all from one map.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-4">
          <button
            type="button"
            onClick={() => signIn('google')}
            className="w-full sm:w-auto px-6 py-3.5 rounded-full bg-amber-400 text-black font-semibold text-[14.5px] hover:bg-amber-300 transition flex items-center justify-center gap-2"
          >
            <GoogleG />
            Sign up free with Google
          </button>
          <button
            type="button"
            onClick={() => signIn('google')}
            className="w-full sm:w-auto px-6 py-3.5 rounded-full bg-white/[0.06] border border-white/[0.1] text-white font-semibold text-[14.5px] hover:bg-white/[0.1] hover:border-white/20 transition"
          >
            See what&apos;s trending
          </button>
        </div>
        <p className="text-[12.5px] text-white/40">
          No credit card · Free to explore the whole platform
        </p>

        {/* Hero "screenshot" — the niches grid mock. The browser
            chrome makes the framing obvious. Soft glow behind it
            so it lifts off the page. */}
        <div className="relative mt-16 sm:mt-24">
          <div
            aria-hidden
            className="absolute -inset-x-6 -bottom-10 -top-6 bg-gradient-to-b from-amber-500/[0.04] via-transparent to-transparent rounded-[40px] blur-2xl pointer-events-none"
          />
          <div className="relative rounded-2xl overflow-hidden border border-white/[0.1] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)] ring-1 ring-white/[0.02]">
            <FauxNichesGrid />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Decoded section — viewstats has "We decoded the MrBeast formula"
 * ──────────────────────────────────────────────────────────────── */

function DecodedSection() {
  return (
    <section className="border-t border-white/[0.06] bg-white/[0.015]">
      <div className="max-w-4xl mx-auto px-6 py-24 sm:py-32 text-center">
        <div className="text-[12px] uppercase tracking-[0.18em] text-amber-400 font-semibold mb-4">
          The map nobody else has
        </div>
        <h2 className="text-[36px] sm:text-[48px] font-bold tracking-[-0.025em] leading-[1.08] mb-6">
          We decoded YouTube into a map
          <br />
          any creator can read.
        </h2>
        <p className="text-[17px] sm:text-[18px] text-white/65 leading-[1.6] max-w-2xl mx-auto">
          YouTube has millions of videos and thousands of unnamed niches. We sort
          every video into the niche it actually belongs to, score how easy it is
          for a new creator to break in, and give you the tools to find the next
          one before anyone else.
        </p>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Feature grid — 3×2, screenshot-style mockups per feature
 * ──────────────────────────────────────────────────────────────── */

function FeatureGrid() {
  return (
    <section id="features" className="border-t border-white/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-24 sm:py-32">
        <div className="text-center mb-16">
          <div className="text-[12px] uppercase tracking-[0.18em] text-amber-400 font-semibold mb-4">
            Everything you need
          </div>
          <h2 className="text-[36px] sm:text-[48px] font-bold tracking-[-0.025em] leading-[1.05]">
            The most powerful
            <br />
            YouTube research tools.
          </h2>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          <Feature
            title="Discover trending niches"
            body="Every video on YouTube, automatically sorted into 4,164 niches and sub-niches. No keyword lists to maintain — new videos drop into the right place on their own."
            visual={<MiniNicheCard />}
          />
          <Feature
            title="Find viral outlier videos"
            body="See which videos are pulling 5×, 10×, even 20× their channel's normal views. Filter to small channels, recent uploads, or any subscriber tier."
            visual={<MiniOutlierCard />}
          />
          <Feature
            title="Search by what you mean"
            body='Type "tired guy at desk, dramatic music" and find every niche about it. No more keyword guessing — search by the idea, not the words.'
            visual={<MiniSearchPanel />}
          />
          <Feature
            title="Find more like this"
            body="Click 'Similar' on any video or niche. We pull every video or niche that's close — by title, by thumbnail, or by both — so your inspiration list doesn't run dry."
            visual={<MiniSimilarPanel />}
          />
          <Feature
            title="Watch new channels grow"
            body="Filter to channels under 6 months old. See which newcomers are breaking through inside any niche, and what they're doing differently from the established players."
            visual={<MiniChannelCard />}
          />
          <Feature
            title="Score every niche"
            body="Four numbers tell you whether a niche has room for small creators or is locked up by giants. Green across the board means go. Red means find somewhere else."
            visual={<MiniOppPills />}
          />
        </div>
      </div>
    </section>
  );
}

function Feature({ title, body, visual }: { title: string; body: string; visual: React.ReactNode }) {
  return (
    <div className="group rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden hover:border-white/[0.12] hover:bg-white/[0.04] transition">
      {/* Visual panel — slightly darker so the mockup pops against
          the slightly-lighter card body below it. Subtle inner ring
          for definition. */}
      <div className="aspect-[4/3] bg-gradient-to-b from-black/40 to-black/10 p-6 flex items-center justify-center border-b border-white/[0.04]">
        {visual}
      </div>
      <div className="p-6">
        <h3 className="text-[17px] font-bold tracking-tight text-white mb-2">{title}</h3>
        <p className="text-[14px] text-white/55 leading-[1.6]">{body}</p>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Data advantage section — big stat panel
 * ──────────────────────────────────────────────────────────────── */

function DataAdvantage() {
  return (
    <section id="data" className="border-t border-white/[0.06] relative overflow-hidden">
      <div
        aria-hidden
        className="absolute -left-32 top-20 w-[500px] h-[500px] rounded-full bg-amber-500/[0.06] blur-3xl pointer-events-none"
      />
      <div className="relative max-w-5xl mx-auto px-6 py-24 sm:py-32 text-center">
        <div className="text-[12px] uppercase tracking-[0.18em] text-amber-400 font-semibold mb-5">
          The data behind it
        </div>
        <h2 className="text-[36px] sm:text-[48px] font-bold tracking-[-0.025em] leading-[1.05] mb-6">
          We see what&apos;s working before
          <br />
          everyone else does.
        </h2>
        <p className="text-[17px] sm:text-[18px] text-white/60 leading-[1.6] max-w-2xl mx-auto mb-16">
          Every hour we pull new videos, score how they&apos;re performing, and update the
          map. By the time a niche is on someone&apos;s radar, you&apos;ve already explored it.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-white/[0.06] rounded-2xl overflow-hidden max-w-3xl mx-auto border border-white/[0.06]">
          <DarkStat value="4,164" label="Niches mapped" />
          <DarkStat value="Hourly" label="Refresh cycle" />
          <DarkStat value="5" label="Ways to research" />
          <DarkStat value="0" label="Keyword lists" />
        </div>
      </div>
    </section>
  );
}

function DarkStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-[#070707] px-5 py-7">
      <div className="text-[28px] sm:text-[34px] font-bold tracking-tight text-white font-mono">{value}</div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-white/45 mt-1 font-semibold">{label}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  CTA bridge
 * ──────────────────────────────────────────────────────────────── */

function CtaBridge() {
  return (
    <section id="workflow" className="border-t border-white/[0.06]">
      <div className="max-w-4xl mx-auto px-6 py-24 sm:py-28 text-center">
        <h2 className="text-[36px] sm:text-[48px] font-bold tracking-[-0.025em] leading-[1.05] mb-8">
          Your next channel niche is
          <br />
          <span className="text-amber-400">hiding in our map.</span>
        </h2>
        <button
          type="button"
          onClick={() => signIn('google')}
          className="inline-flex items-center gap-2 px-6 py-3.5 rounded-full bg-amber-400 text-black font-semibold text-[14.5px] hover:bg-amber-300 transition"
        >
          <GoogleG />
          Get started for free
        </button>
        <p className="text-[12.5px] text-white/45 mt-4">
          One Google sign-in. No credit card.
        </p>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Final CTA — split layout
 * ──────────────────────────────────────────────────────────────── */

function FinalCta() {
  return (
    <section className="border-t border-white/[0.06] relative overflow-hidden">
      <div
        aria-hidden
        className="absolute -right-32 top-20 w-[600px] h-[600px] rounded-full bg-amber-500/[0.08] blur-3xl pointer-events-none"
      />
      <div className="relative max-w-6xl mx-auto px-6 py-24 sm:py-32 grid lg:grid-cols-2 gap-14 items-center">
        <div>
          <h2 className="text-[36px] sm:text-[52px] font-bold tracking-[-0.025em] leading-[1.05] mb-6">
            Start finding niches
            <br />
            that <span className="text-amber-400">work.</span>
          </h2>
          <p className="text-[17px] text-white/65 leading-[1.6] mb-9 max-w-md">
            Free to explore. Sign in with Google and the whole map opens up — every
            niche, every video, every sort, every filter.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => signIn('google')}
              className="px-6 py-3.5 rounded-full bg-amber-400 text-black font-semibold text-[14.5px] hover:bg-amber-300 transition flex items-center gap-2"
            >
              <GoogleG />
              Get started
            </button>
            <span className="text-[13px] text-white/45">2 minutes to first niche</span>
          </div>
        </div>

        <div className="relative">
          <div
            aria-hidden
            className="absolute inset-0 -m-3 bg-amber-500/[0.04] rounded-3xl blur-2xl pointer-events-none"
          />
          <div className="relative rounded-2xl overflow-hidden border border-white/[0.1] shadow-2xl shadow-black/40 ring-1 ring-white/[0.02]">
            <FauxNicheCard light />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Footer
 * ──────────────────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer className="border-t border-white/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-14">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-black font-bold text-sm">
              R
            </div>
            <span className="font-semibold text-[15px] tracking-tight">
              rofe<span className="text-white/40">.ai</span>
            </span>
          </div>
          <p className="text-[13px] text-white/40">
            YouTube research, mapped. © {new Date().getFullYear()} rofe.ai
          </p>
        </div>
      </div>
    </footer>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Google G — white on dark amber button
 * ──────────────────────────────────────────────────────────────── */

function GoogleG() {
  // Monochrome black-on-amber so the button reads as a single unit
  // instead of a rainbow logo on a colored field.
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden>
      <path fill="#000" opacity="0.9" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#000" opacity="0.9" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A10.99 10.99 0 0012 23z"/>
      <path fill="#000" opacity="0.9" d="M5.84 14.1A6.6 6.6 0 015.5 12c0-.73.13-1.45.34-2.1V7.07H2.18A11 11 0 001 12c0 1.77.42 3.45 1.18 4.93l3.66-2.83z"/>
      <path fill="#000" opacity="0.9" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Hero mockup — faux niches grid (browser chrome + 3 cluster rows)
 * ──────────────────────────────────────────────────────────────── */

function FauxNichesGrid() {
  return (
    <div className="bg-[#0a0a0a] text-white">
      <div className="flex items-center gap-1.5 px-4 py-2.5 bg-[#0f0f0f] border-b border-white/[0.06]">
        <div className="w-2.5 h-2.5 rounded-full bg-red-400/60" />
        <div className="w-2.5 h-2.5 rounded-full bg-amber-400/60" />
        <div className="w-2.5 h-2.5 rounded-full bg-emerald-400/60" />
        <div className="ml-3 px-3 py-0.5 bg-black/40 rounded-full text-[10px] text-white/40 font-mono">
          rofe.ai/niche/niches
        </div>
      </div>
      <div className="px-6 pt-6 pb-3 flex items-center justify-between">
        <div>
          <h3 className="text-[15px] font-semibold text-white">Niches</h3>
          <p className="text-[11px] text-white/40">Auto-discovered niche clusters · refreshed hourly</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] px-2.5 py-1 rounded-full bg-white text-black font-medium">Most Videos</span>
          <span className="text-[10px] px-2.5 py-1 rounded-full text-white/60 border border-white/15">Most Views</span>
          <span className="text-[10px] px-2.5 py-1 rounded-full text-white/60 border border-white/15">Highest Score</span>
        </div>
      </div>
      <div className="px-6 pb-6 space-y-2.5">
        <FauxNicheCard label="Solo woodworking · workshop builds"          videos="1,247" />
        <FauxNicheCard label="Family vlogs · daily life clips"              videos="2,103" />
        <FauxNicheCard label="AI-generated horror short films"              videos="884"   trim />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Faux niche card — used in hero grid + final CTA right panel
 * ──────────────────────────────────────────────────────────────── */

function FauxNicheCard({
  label = 'Solo woodworking · workshop builds',
  videos = '1,247',
  trim = false,
  light = false,
}: { label?: string; videos?: string; trim?: boolean; light?: boolean }) {
  const bgCard = light ? 'bg-[#0a0a0a]' : 'bg-[#0f0f0f]';
  return (
    <div className={`${bgCard} border border-white/[0.08] rounded-xl ${light ? 'p-5' : 'px-4 py-3.5'}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
            <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full px-2 py-0.5 font-medium">
              {videos} videos
            </span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-black/60 text-white/60 border border-white/10">L1</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
              3 sub-niches
            </span>
          </div>
          <h4 className={`${light ? 'text-[14px]' : 'text-[13px]'} font-medium text-white truncate`}>{label}</h4>
        </div>
        <div className="flex items-stretch gap-1 flex-shrink-0">
          <MiniPill label="OPP"  value="72"   />
          <MiniPill label="TOP"  value="34%"  />
          <MiniPill label="NEW"  value="88%"  />
          <MiniPill label="CEIL" value="1.4M" />
        </div>
      </div>

      {!trim && (
        <div className="grid grid-cols-4 gap-2">
          {[
            'from-amber-500/30 to-orange-700/30',
            'from-rose-500/30 to-purple-700/30',
            'from-sky-500/30 to-indigo-700/30',
            'from-emerald-500/30 to-teal-700/30',
          ].map((g, i) => (
            <div key={i} className="aspect-video rounded-md overflow-hidden border border-white/[0.06]">
              <div className={`w-full h-full bg-gradient-to-br ${g}`} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-emerald-500/25 bg-emerald-500/10 text-emerald-300 px-1.5 py-0.5 min-w-[36px]">
      <span className="text-[7px] uppercase tracking-[0.08em] opacity-80 leading-none font-semibold">{label}</span>
      <span className="text-[9.5px] font-bold leading-tight mt-px font-mono">{value}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Feature-card visuals — small dark mockups
 *  Designed to read at the small size + sit against the dark
 *  panel inside each Feature card.
 * ──────────────────────────────────────────────────────────────── */

function MiniNicheCard() {
  return (
    <div className="w-full max-w-[280px] bg-[#0a0a0a] text-white rounded-lg p-3 border border-white/[0.1] shadow-2xl shadow-black/40">
      <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
        <span className="text-[8px] bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full px-1.5 py-0.5 font-medium">
          1,247 videos
        </span>
        <span className="text-[8px] px-1 py-0.5 rounded-full bg-black/60 text-white/60 border border-white/10">L1</span>
      </div>
      <div className="text-[11px] font-medium text-white truncate mb-2">Solo woodworking · workshop builds</div>
      <div className="grid grid-cols-4 gap-1">
        {[
          'from-amber-500/30 to-orange-700/30',
          'from-rose-500/30 to-purple-700/30',
          'from-sky-500/30 to-indigo-700/30',
          'from-emerald-500/30 to-teal-700/30',
        ].map((g, i) => (
          <div key={i} className="aspect-video rounded-sm overflow-hidden">
            <div className={`w-full h-full bg-gradient-to-br ${g}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniOutlierCard() {
  return (
    <div className="w-full max-w-[260px] bg-[#0a0a0a] rounded-lg overflow-hidden border border-white/[0.1] shadow-2xl shadow-black/40">
      <div className="aspect-video relative bg-gradient-to-br from-rose-400 to-purple-600">
        <div className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-bold font-mono shadow">
          9.4×
        </div>
        <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/70 text-white text-[9px] font-semibold">
          0:54
        </div>
      </div>
      <div className="p-2.5">
        <div className="text-[11px] font-semibold text-white leading-tight line-clamp-2 mb-1">
          I built a workshop in my garage and changed my life
        </div>
        <div className="flex items-center justify-between text-[9.5px] text-white/45">
          <span className="text-emerald-400 font-semibold">2.4M views</span>
          <span>4.8K subs</span>
        </div>
      </div>
    </div>
  );
}

function MiniSearchPanel() {
  return (
    <div className="w-full max-w-[280px] bg-[#0a0a0a] rounded-lg border border-white/[0.1] shadow-2xl shadow-black/40 p-3">
      <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-black/40 border border-white/[0.08]">
        <svg className="w-3.5 h-3.5 text-white/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="7" />
          <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
        </svg>
        <span className="text-[11px] text-white/80 font-mono truncate">tired guy at desk</span>
      </div>
      <div className="mt-2.5 space-y-1.5">
        {[
          ['Office burnout · dramatic edits', '91%'],
          ['9-to-5 grind compilations',       '84%'],
          ['Corporate satire · dark humor',    '72%'],
        ].map(([t, p]) => (
          <div key={t} className="flex items-center gap-2 p-1.5 rounded bg-black/30 border border-white/[0.04]">
            <div className="w-6 h-6 rounded bg-gradient-to-br from-amber-400 to-orange-500 flex-shrink-0" />
            <span className="text-[10px] text-white/85 truncate flex-1">{t}</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono font-semibold">{p}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniSimilarPanel() {
  return (
    <div className="w-full max-w-[280px] bg-[#0a0a0a] rounded-lg border border-white/[0.1] shadow-2xl shadow-black/40 p-2.5">
      <div className="text-[9px] uppercase tracking-[0.1em] text-white/40 font-semibold mb-1.5">
        Similar to this niche
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {[
          ['Garage workshop builds',     '94%', 'from-amber-400 to-orange-500'],
          ['DIY furniture from scratch', '89%', 'from-emerald-400 to-teal-500'],
          ['Restoring antique tools',    '81%', 'from-blue-400 to-indigo-500'],
          ['Hand-cut joinery showcases', '78%', 'from-rose-400 to-pink-500'],
        ].map(([t, p, g]) => (
          <div key={t} className="bg-black/30 border border-white/[0.04] rounded p-1.5">
            <div className={`aspect-video rounded-sm bg-gradient-to-br ${g} mb-1`} />
            <div className="flex items-center gap-1">
              <span className="text-[8px] px-1 py-0 rounded-sm bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono font-semibold">{p}</span>
            </div>
            <div className="text-[9px] text-white/80 leading-tight mt-0.5 line-clamp-2">{t}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniChannelCard() {
  return (
    <div className="w-full max-w-[280px] bg-[#0a0a0a] rounded-lg border border-white/[0.1] shadow-2xl shadow-black/40 p-3">
      <div className="flex items-center gap-2.5 mb-2.5">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-indigo-600 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-white truncate">@workshopdave</div>
          <div className="flex items-center gap-1.5 text-[9.5px] text-white/50">
            <span>4.2K subs</span>
            <span>·</span>
            <span className="text-emerald-400 font-semibold">5 mo old</span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {[
          'from-amber-400 to-orange-500',
          'from-rose-400 to-pink-500',
          'from-sky-400 to-indigo-500',
          'from-emerald-400 to-teal-500',
        ].map((g, i) => (
          <div key={i} className="aspect-video rounded relative">
            <div className={`w-full h-full rounded bg-gradient-to-br ${g}`} />
            {i === 0 && (
              <div className="absolute top-1 right-1 px-1 py-px rounded-sm bg-rose-500 text-white text-[8px] font-bold font-mono">
                14×
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniOppPills() {
  // Renders the 4 score pills with explanatory micro-labels so the
  // visual reads as "at a glance" rather than "what do these
  // acronyms mean."
  return (
    <div className="w-full max-w-[280px] space-y-3">
      <div className="flex items-stretch gap-2 justify-center">
        {[
          { label: 'OPP',  value: '72',   pop: 'Opportunity' },
          { label: 'TOP',  value: '34%',  pop: 'Top-left'    },
          { label: 'NEW',  value: '88%',  pop: 'Newcomers'   },
          { label: 'CEIL', value: '1.4M', pop: 'Ceiling'     },
        ].map(p => (
          <div key={p.label} className="flex flex-col items-center">
            <div className="flex flex-col items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 px-2 py-1.5 min-w-[48px]">
              <span className="text-[8px] uppercase tracking-[0.1em] opacity-80 leading-none font-semibold">{p.label}</span>
              <span className="text-[12px] font-bold leading-tight mt-0.5 font-mono">{p.value}</span>
            </div>
            <span className="text-[8.5px] text-white/55 mt-1.5 font-medium">{p.pop}</span>
          </div>
        ))}
      </div>
      <div className="text-center">
        <span className="inline-flex items-center gap-1.5 text-[10px] text-emerald-300 font-semibold px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          Cracked open for small creators
        </span>
      </div>
    </div>
  );
}
