'use client';

import React from 'react';

/**
 * Marketing landing page shown to signed-out visitors at the bare
 * domain. Structure follows viewstats.com/info — white-dominant
 * layout, generous spacing, centered hero, 3×2 feature grid with
 * screenshot-style mockups, founder-less but otherwise the same
 * section flow.
 *
 * Copy is intentionally human. No "kNN", "HDBSCAN", or "cosine
 * similarity" — those are mechanisms, not features. We talk about
 * what the user does, not what the code does.
 */
export function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900 antialiased selection:bg-amber-200">
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
    <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-xl border-b border-zinc-100">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-md bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white font-bold text-sm">
            R
          </div>
          <span className="font-semibold text-[16px] tracking-tight">
            rofe<span className="text-zinc-400">.ai</span>
          </span>
        </a>

        <nav className="hidden md:flex items-center gap-7 text-[14px] text-zinc-700">
          <a href="#features"  className="hover:text-zinc-950 transition">Features</a>
          <a href="#data"      className="hover:text-zinc-950 transition">Data</a>
          <a href="#workflow"  className="hover:text-zinc-950 transition">How it works</a>
        </nav>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => { window.location.href = '/login'; }}
            className="hidden sm:inline px-3.5 py-2 text-[13px] text-zinc-700 hover:text-zinc-950 transition"
          >
            Log in
          </button>
          <button
            type="button"
            onClick={() => { window.location.href = '/login'; }}
            className="px-4 py-2 rounded-full text-[13px] font-semibold bg-zinc-950 text-white hover:bg-zinc-800 transition"
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
      {/* Soft warm gradient wash anchored to the top so the hero
          reads "energetic" without being heavy. Pure white below
          where the screenshot sits. */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[600px] bg-gradient-to-b from-amber-50 via-orange-50/40 to-transparent pointer-events-none"
      />
      <div className="relative max-w-5xl mx-auto px-6 pt-16 sm:pt-24 pb-20 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white border border-zinc-200 shadow-sm text-[12px] text-zinc-700 font-medium mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          4,164 niches indexed · refreshed every hour
        </div>

        <h1 className="text-[44px] sm:text-[64px] lg:text-[76px] font-bold tracking-[-0.035em] leading-[1.02] text-zinc-950 mb-6">
          Find the videos and niches
          <br />
          <span className="text-amber-500">about to blow up.</span>
        </h1>

        <p className="text-[18px] sm:text-[20px] text-zinc-600 max-w-2xl mx-auto leading-[1.55] mb-10">
          See what&apos;s working on YouTube before everyone else does. Search by what you
          mean, drill into trending niches, and watch new channels break through —
          all from one map.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-4">
          <button
            type="button"
            onClick={() => { window.location.href = '/login'; }}
            className="w-full sm:w-auto px-6 py-3.5 rounded-full bg-zinc-950 text-white font-semibold text-[14.5px] hover:bg-zinc-800 transition flex items-center justify-center gap-2"
          >
            Sign up free
          </button>
          <button
            type="button"
            onClick={() => { window.location.href = '/login'; }}
            className="w-full sm:w-auto px-6 py-3.5 rounded-full bg-white border border-zinc-200 text-zinc-950 font-semibold text-[14.5px] hover:border-zinc-300 hover:bg-zinc-50 transition"
          >
            See what&apos;s trending
          </button>
        </div>
        <p className="text-[12.5px] text-zinc-500">
          No credit card · Free to explore the whole platform
        </p>

        {/* Hero "screenshot" — the niches grid mock. Anchors the
            page visually and shows the product on first glance. */}
        <div className="relative mt-16 sm:mt-24">
          <div
            aria-hidden
            className="absolute -inset-x-6 -bottom-10 -top-6 bg-gradient-to-b from-zinc-200/0 via-zinc-200/40 to-transparent rounded-[40px] blur-2xl pointer-events-none"
          />
          <div className="relative rounded-2xl overflow-hidden border border-zinc-200 shadow-[0_30px_60px_-20px_rgba(0,0,0,0.12)]">
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
    <section className="border-t border-zinc-100 bg-zinc-50/60">
      <div className="max-w-4xl mx-auto px-6 py-24 sm:py-32 text-center">
        <div className="text-[12px] uppercase tracking-[0.18em] text-amber-600 font-semibold mb-4">
          The map nobody else has
        </div>
        <h2 className="text-[36px] sm:text-[48px] font-bold tracking-[-0.025em] leading-[1.08] text-zinc-950 mb-6">
          We decoded YouTube into a map any creator can read.
        </h2>
        <p className="text-[17px] sm:text-[18px] text-zinc-600 leading-[1.6] max-w-2xl mx-auto">
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
    <section id="features" className="border-t border-zinc-100">
      <div className="max-w-6xl mx-auto px-6 py-24 sm:py-32">
        <div className="text-center mb-16">
          <div className="text-[12px] uppercase tracking-[0.18em] text-amber-600 font-semibold mb-4">
            Everything you need
          </div>
          <h2 className="text-[36px] sm:text-[48px] font-bold tracking-[-0.025em] leading-[1.05] text-zinc-950">
            The most powerful YouTube research tools.
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
    <div className="group rounded-2xl border border-zinc-200 bg-white overflow-hidden hover:border-zinc-300 hover:shadow-lg hover:shadow-zinc-200/40 transition">
      <div className="aspect-[4/3] bg-gradient-to-b from-zinc-50 to-white p-6 flex items-center justify-center border-b border-zinc-100">
        {visual}
      </div>
      <div className="p-6">
        <h3 className="text-[17px] font-bold tracking-tight text-zinc-950 mb-2">{title}</h3>
        <p className="text-[14px] text-zinc-600 leading-[1.6]">{body}</p>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Data advantage section — viewstats has "We know what will go viral"
 * ──────────────────────────────────────────────────────────────── */

function DataAdvantage() {
  return (
    <section id="data" className="border-t border-zinc-100 bg-zinc-950 text-white">
      <div className="max-w-5xl mx-auto px-6 py-24 sm:py-32 text-center">
        <div className="text-[12px] uppercase tracking-[0.18em] text-amber-400 font-semibold mb-5">
          The data behind it
        </div>
        <h2 className="text-[36px] sm:text-[48px] font-bold tracking-[-0.025em] leading-[1.05] mb-6">
          We see what&apos;s working before
          <br />
          everyone else does.
        </h2>
        <p className="text-[17px] sm:text-[18px] text-zinc-400 leading-[1.6] max-w-2xl mx-auto mb-16">
          Every hour we pull new videos, score how they&apos;re performing, and update the
          map. By the time a niche is on someone&apos;s radar, you&apos;ve already explored it.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-white/10 rounded-2xl overflow-hidden max-w-3xl mx-auto">
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
    <div className="bg-zinc-950 px-5 py-7">
      <div className="text-[28px] sm:text-[34px] font-bold tracking-tight text-white font-mono">{value}</div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500 mt-1 font-semibold">{label}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  CTA bridge — viewstats has "Your next video should go viral"
 * ──────────────────────────────────────────────────────────────── */

function CtaBridge() {
  return (
    <section id="workflow" className="border-t border-zinc-100">
      <div className="max-w-4xl mx-auto px-6 py-24 sm:py-28 text-center">
        <h2 className="text-[36px] sm:text-[48px] font-bold tracking-[-0.025em] leading-[1.05] text-zinc-950 mb-8">
          Your next channel niche is
          <br />
          hiding in our map.
        </h2>
        <button
          type="button"
          onClick={() => { window.location.href = '/login'; }}
          className="inline-flex items-center gap-2 px-6 py-3.5 rounded-full bg-zinc-950 text-white font-semibold text-[14.5px] hover:bg-zinc-800 transition"
        >
          Get started for free
        </button>
        <p className="text-[12.5px] text-zinc-500 mt-4">
          Free to start. No credit card.
        </p>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Final CTA — split layout, viewstats has phone mockup right
 * ──────────────────────────────────────────────────────────────── */

function FinalCta() {
  return (
    <section className="border-t border-zinc-100 bg-amber-50/40 relative overflow-hidden">
      <div
        aria-hidden
        className="absolute -right-32 top-20 w-[600px] h-[600px] rounded-full bg-amber-200/30 blur-3xl pointer-events-none"
      />
      <div className="relative max-w-6xl mx-auto px-6 py-24 sm:py-32 grid lg:grid-cols-2 gap-14 items-center">
        <div>
          <h2 className="text-[36px] sm:text-[52px] font-bold tracking-[-0.025em] leading-[1.05] text-zinc-950 mb-6">
            Start finding niches that work.
          </h2>
          <p className="text-[17px] text-zinc-600 leading-[1.6] mb-9 max-w-md">
            Free to explore. Sign in and the whole map opens up — every
            niche, every video, every sort, every filter.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => { window.location.href = '/login'; }}
              className="px-6 py-3.5 rounded-full bg-zinc-950 text-white font-semibold text-[14.5px] hover:bg-zinc-800 transition flex items-center gap-2"
            >
              Get started
            </button>
            <span className="text-[13px] text-zinc-500">2 minutes to first niche</span>
          </div>
        </div>

        <div className="relative">
          <div
            aria-hidden
            className="absolute inset-0 -m-3 bg-white/40 rounded-3xl blur-2xl pointer-events-none"
          />
          <div className="relative rounded-2xl overflow-hidden border border-zinc-200 shadow-2xl bg-white">
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
    <footer className="border-t border-zinc-100 bg-white">
      <div className="max-w-6xl mx-auto px-6 py-14">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white font-bold text-sm">
              R
            </div>
            <span className="font-semibold text-[15px] tracking-tight">
              rofe<span className="text-zinc-400">.ai</span>
            </span>
          </div>
          <p className="text-[13px] text-zinc-500">
            YouTube research, mapped. © {new Date().getFullYear()} rofe.ai
          </p>
        </div>
      </div>
    </footer>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Google G
 * ──────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────
 *  Hero mockup — faux niches grid (browser chrome + 3 cluster rows)
 * ──────────────────────────────────────────────────────────────── */

function FauxNichesGrid() {
  return (
    <div className="bg-[#0a0a0a] text-white">
      {/* Mock browser chrome */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 bg-[#0f0f0f] border-b border-white/[0.06]">
        <div className="w-2.5 h-2.5 rounded-full bg-red-400/60" />
        <div className="w-2.5 h-2.5 rounded-full bg-amber-400/60" />
        <div className="w-2.5 h-2.5 rounded-full bg-emerald-400/60" />
        <div className="ml-3 px-3 py-0.5 bg-black/40 rounded-full text-[10px] text-white/40 font-mono">
          rofe.ai/niche/niches
        </div>
      </div>
      {/* Page header inside the screenshot */}
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
      {/* Card stack */}
      <div className="px-6 pb-6 space-y-2.5">
        <FauxNicheCard label="Solo woodworking · workshop builds"          videos="1,247" />
        <FauxNicheCard label="Family vlogs · daily life clips"              videos="2,103" />
        <FauxNicheCard label="AI-generated horror short films"              videos="884"   trim />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Faux niche card — used twice (in hero grid + final CTA right side)
 * ──────────────────────────────────────────────────────────────── */

function FauxNicheCard({
  label = 'Solo woodworking · workshop builds',
  videos = '1,247',
  trim = false,
  light = false,
}: { label?: string; videos?: string; trim?: boolean; light?: boolean }) {
  // light=true is a full-card view used in the final-CTA panel.
  // trim=true cuts the thumb strip so cards stack tighter inside
  // the hero grid mock.
  const bgCard  = light ? 'bg-[#0a0a0a]' : 'bg-[#0f0f0f]';
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
 *  Feature-card visuals — small mockups (fit ~4:3 area)
 *  Each rendered against the soft top-half of the parent card.
 * ──────────────────────────────────────────────────────────────── */

function MiniNicheCard() {
  return (
    <div className="w-full max-w-[280px] bg-[#0a0a0a] text-white rounded-lg p-3 border border-zinc-300 shadow-md">
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
    <div className="w-full max-w-[280px] bg-white rounded-lg overflow-hidden border border-zinc-300 shadow-md">
      <div className="aspect-video relative bg-gradient-to-br from-rose-400 to-purple-600">
        <div className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-bold font-mono shadow">
          9.4×
        </div>
        <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/70 text-white text-[9px] font-semibold">
          0:54
        </div>
      </div>
      <div className="p-2.5">
        <div className="text-[11px] font-semibold text-zinc-900 leading-tight line-clamp-2 mb-1">
          I built a workshop in my garage and changed my life
        </div>
        <div className="flex items-center justify-between text-[9.5px] text-zinc-500">
          <span>2.4M views</span>
          <span>4.8K subs</span>
        </div>
      </div>
    </div>
  );
}

function MiniSearchPanel() {
  return (
    <div className="w-full max-w-[280px] bg-white rounded-lg border border-zinc-300 shadow-md p-3">
      <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-zinc-50 border border-zinc-200">
        <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="7" />
          <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
        </svg>
        <span className="text-[11px] text-zinc-700 font-mono truncate">tired guy at desk</span>
      </div>
      <div className="mt-2.5 space-y-1.5">
        {[
          ['Office burnout · dramatic edits', '91%'],
          ['9-to-5 grind compilations',       '84%'],
          ['Corporate satire · dark humor',    '72%'],
        ].map(([t, p]) => (
          <div key={t} className="flex items-center gap-2 p-1.5 rounded bg-zinc-50">
            <div className="w-6 h-6 rounded bg-gradient-to-br from-amber-400 to-orange-500 flex-shrink-0" />
            <span className="text-[10px] text-zinc-700 truncate flex-1">{t}</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-mono font-semibold">{p}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniSimilarPanel() {
  return (
    <div className="w-full max-w-[280px] bg-white rounded-lg border border-zinc-300 shadow-md p-2.5">
      <div className="text-[9px] uppercase tracking-[0.1em] text-zinc-400 font-semibold mb-1.5">
        Similar to this niche
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {[
          ['Garage workshop builds',  '94%', 'from-amber-400 to-orange-500'],
          ['DIY furniture from scratch','89%', 'from-emerald-400 to-teal-500'],
          ['Restoring antique tools',  '81%', 'from-blue-400 to-indigo-500'],
          ['Hand-cut joinery showcases','78%', 'from-rose-400 to-pink-500'],
        ].map(([t, p, g]) => (
          <div key={t} className="bg-zinc-50 rounded p-1.5">
            <div className={`aspect-video rounded-sm bg-gradient-to-br ${g} mb-1`} />
            <div className="flex items-center gap-1">
              <span className="text-[8px] px-1 py-0 rounded-sm bg-purple-100 text-purple-700 font-mono font-semibold">{p}</span>
            </div>
            <div className="text-[9px] text-zinc-700 leading-tight mt-0.5 line-clamp-2">{t}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniChannelCard() {
  return (
    <div className="w-full max-w-[280px] bg-white rounded-lg border border-zinc-300 shadow-md p-3">
      <div className="flex items-center gap-2.5 mb-2.5">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-indigo-600 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-zinc-900 truncate">@workshopdave</div>
          <div className="flex items-center gap-1.5 text-[9.5px] text-zinc-500">
            <span>4.2K subs</span>
            <span>·</span>
            <span className="text-emerald-600 font-semibold">5 mo old</span>
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
          <div key={i} className="aspect-video rounded bg-gradient-to-br relative">
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
  // Renders the 4 score pills with explanatory micro-labels around
  // them so the visual reads as "at a glance" rather than "what
  // do these acronyms mean."
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
            <div className="flex flex-col items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-100 text-emerald-700 px-2 py-1.5 min-w-[48px]">
              <span className="text-[8px] uppercase tracking-[0.1em] opacity-80 leading-none font-semibold">{p.label}</span>
              <span className="text-[12px] font-bold leading-tight mt-0.5 font-mono">{p.value}</span>
            </div>
            <span className="text-[8.5px] text-zinc-500 mt-1.5 font-medium">{p.pop}</span>
          </div>
        ))}
      </div>
      <div className="text-center">
        <span className="inline-flex items-center gap-1.5 text-[10px] text-emerald-700 font-semibold px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          Cracked open for small creators
        </span>
      </div>
    </div>
  );
}
