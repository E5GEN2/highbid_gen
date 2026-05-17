'use client';

import React from 'react';
import { signIn } from 'next-auth/react';

/**
 * Marketing landing page shown to signed-out visitors at the bare
 * domain. The pitch is intentionally narrow: only Niche Finder.
 * Visual language mirrors the real /niche/niches surface so the
 * post-sign-in experience feels continuous — the faux niche card in
 * the hero is the same shape & metric layout users see in-app.
 *
 * Signed-in routing happens server-side in app/page.tsx before this
 * component renders.
 */
export function LandingPage() {
  return (
    <div className="min-h-screen bg-[#070707] text-white antialiased selection:bg-amber-400/30">
      <Header />
      <Hero />
      <HowItWorks />
      <OpportunityExplainer />
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
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2 group">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-black font-bold text-sm">
            R
          </div>
          <span className="font-semibold text-[15px] tracking-tight">rofe<span className="text-white/40">.ai</span></span>
        </a>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline text-[13px] text-white/40">Niche Finder</span>
          <button
            type="button"
            onClick={() => signIn('google')}
            className="px-3.5 py-1.5 rounded-full text-[13px] font-medium bg-white text-black hover:bg-white/90 transition"
          >
            Sign in
          </button>
        </div>
      </div>
    </header>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Hero — asymmetric grid: pitch left, faux card right
 * ──────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-white/[0.06]">
      {/* Subtle amber glow anchored to the bottom-right of the hero
          so it doesn't fight the headline. Hidden behind everything. */}
      <div
        aria-hidden
        className="absolute -right-32 top-24 w-[640px] h-[640px] rounded-full bg-amber-500/[0.08] blur-3xl pointer-events-none"
      />
      <div className="relative max-w-6xl mx-auto px-6 pt-20 pb-24 lg:pt-28 lg:pb-32">
        <div className="grid lg:grid-cols-[1.05fr_1fr] gap-12 lg:gap-16 items-center">
          {/* Pitch */}
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-[11px] text-white/60 mb-7 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              4,164 niches indexed · refreshed hourly
            </div>

            <h1 className="text-[42px] sm:text-[56px] lg:text-[64px] font-bold tracking-[-0.03em] leading-[1.02] mb-6">
              Every YouTube Shorts niche.
              <br />
              <span className="text-amber-400">Ranked by opportunity.</span>
            </h1>

            <p className="text-[17px] sm:text-[18px] text-white/65 max-w-xl leading-[1.55] mb-9">
              We cluster the entire Shorts ecosystem into 4,164 auto-discovered niches,
              score each one for how easily a new creator can break through, and surface
              the niches quietly exploding right now — before they&apos;re saturated.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => signIn('google')}
                className="group inline-flex items-center gap-2 px-5 py-3 rounded-full bg-amber-400 hover:bg-amber-300 text-black font-semibold text-[14px] transition shadow-[0_0_0_1px_rgba(0,0,0,0.04)]"
              >
                Open the map
                <svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </button>
              <span className="text-[13px] text-white/40">Google sign-in · free to explore</span>
            </div>

            {/* Inline numerical proof — the kind of detail that makes
                the pitch concrete instead of marketing-soup. */}
            <dl className="grid grid-cols-3 gap-px mt-12 max-w-md bg-white/[0.06] rounded-xl overflow-hidden border border-white/[0.06]">
              <Stat label="Niches" value="4,164" />
              <Stat label="Refresh" value="Hourly" />
              <Stat label="Levels" value="L1 + L2" />
            </dl>
          </div>

          {/* Faux niche card preview — same metric layout users see
              in-app, so they recognize the product the moment they
              sign in. */}
          <div className="relative">
            <div
              aria-hidden
              className="absolute inset-0 -m-4 bg-gradient-to-b from-white/[0.04] to-transparent rounded-3xl blur-xl pointer-events-none"
            />
            <FauxNicheCard />
          </div>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#070707] px-4 py-3.5">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/40 font-medium">{label}</div>
      <div className="text-[15px] font-semibold text-white mt-1 font-mono">{value}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Faux niche card — visual anchor for the hero. Mirrors the
 *  in-app NicheClusterCard so the brand reads as continuous.
 * ──────────────────────────────────────────────────────────────── */

function FauxNicheCard() {
  return (
    <div className="relative bg-[#101010] border border-white/[0.08] rounded-2xl shadow-2xl shadow-amber-500/[0.06] overflow-hidden">
      {/* Header strip */}
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            <span className="text-[11px] bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full px-2 py-0.5 font-medium">
              1,247 videos
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/60 text-white/60 border border-white/10">
              L1
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
              3 sub-niches
            </span>
          </div>
          <h3 className="text-[14px] font-medium text-white truncate">
            Cat compilations · car interior edits
          </h3>
        </div>
        <OppPills />
      </div>

      {/* 4 stat tiles */}
      <div className="grid grid-cols-4 gap-2 px-5 mb-4">
        <StatTile label="Avg views" value="480K" />
        <HeartbeatTile />
        <StatTile label="Total views" value="1.2B" valueColor="text-emerald-400" />
        <StatTile label="Channels" value="312" valueColor="text-blue-400" />
      </div>

      {/* Thumb strip */}
      <div className="px-5 pb-5">
        <div className="text-[10px] text-white/40 uppercase tracking-[0.12em] mb-2 font-medium">
          Most representative videos
        </div>
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
      </div>
    </div>
  );
}

function StatTile({ label, value, valueColor = 'text-white' }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="bg-black/40 border border-white/[0.06] rounded-lg px-2.5 py-2">
      <div className="text-[9px] text-white/40 uppercase tracking-[0.1em] font-medium">{label}</div>
      <div className={`text-[15px] font-semibold ${valueColor} mt-0.5 font-mono`}>{value}</div>
    </div>
  );
}

function HeartbeatTile() {
  // Static set of bars that read as "uptrending" — recent quarter
  // taller than the earlier 39 weeks. Same visual language as the
  // real <HeartbeatTile /> on the niche page.
  const bars = [
    1, 2, 1, 3, 2, 1, 2, 3, 2, 1, 2, 2, 3, 2, 1, 2, 3, 4, 3, 2, 3, 4, 3, 4, 5,
    4, 3, 4, 5, 6, 5, 6, 7, 6, 7, 8, 7, 9, 8, 10, 11, 9, 12, 11, 13, 12, 14, 13, 15, 14, 16, 18,
  ];
  const max = Math.max(...bars);
  return (
    <div className="bg-black/40 border border-white/[0.06] rounded-lg px-2.5 py-2 overflow-hidden">
      <div className="flex items-center justify-between gap-1">
        <span className="text-[9px] text-white/40 uppercase tracking-[0.1em] font-medium">Heartbeat</span>
        <span className="text-[8px] text-emerald-400">↑ trending</span>
      </div>
      <svg viewBox="0 0 100 22" preserveAspectRatio="none" className="w-full h-6 mt-1 block">
        {bars.map((v, i) => {
          const barW = (100 - 0.3 * (bars.length - 1)) / bars.length;
          const h = Math.max(1, (v / max) * 20);
          return (
            <rect
              key={i}
              x={i * (barW + 0.3)}
              y={22 - h}
              width={barW}
              height={h}
              fill="#34d399"
              rx={0.4}
            />
          );
        })}
      </svg>
    </div>
  );
}

function OppPills() {
  // Realistic-but-illustrative opportunity score. Color band per
  // metric matches the in-app scheme (green/yellow/red).
  const pills = [
    { label: 'OPP',  value: '72',  cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
    { label: 'TOP',  value: '34%', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
    { label: 'NEW',  value: '88%', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
    { label: 'CEIL', value: '1.4M', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  ];
  return (
    <div className="flex items-stretch gap-1 flex-shrink-0">
      {pills.map(p => (
        <div key={p.label} className={`flex flex-col items-center justify-center rounded-md border px-2 py-1 ${p.cls}`}>
          <span className="text-[8px] uppercase tracking-[0.1em] opacity-70 leading-none font-medium">{p.label}</span>
          <span className="text-[11px] font-bold leading-tight mt-0.5 font-mono">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  How it works — 3 columns
 * ──────────────────────────────────────────────────────────────── */

function HowItWorks() {
  return (
    <section className="border-b border-white/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
        <div className="max-w-2xl mb-16">
          <div className="text-[11px] uppercase tracking-[0.2em] text-amber-400/80 font-semibold mb-4">
            How the map works
          </div>
          <h2 className="text-[34px] sm:text-[44px] font-bold tracking-[-0.02em] leading-[1.05]">
            Cluster. Score. Compare.
          </h2>
          <p className="text-[17px] text-white/60 leading-[1.55] mt-5">
            We pull every rising video, embed it, and let HDBSCAN find the natural
            shape of the Shorts ecosystem. The result: 4,164 niches you can navigate
            instead of a flat list of keywords.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-px bg-white/[0.06] rounded-2xl overflow-hidden border border-white/[0.06]">
          <Pillar
            step="01"
            title="Cluster the ecosystem"
            body="Every Shorts video gets embedded into a joint title + thumbnail space. HDBSCAN groups them into broad niches (L1) and sub-niches (L2). 4,164 in total — no keyword lists to maintain."
          />
          <Pillar
            step="02"
            title="Score the opportunity"
            body="Each niche gets four scores — OPP, TOP, NEW, CEIL — built from how channels with few subscribers are performing inside it. Green pills = niches where small creators are breaking through."
          />
          <Pillar
            step="03"
            title="Compare and drill"
            body="Heartbeat sparklines show 52 weeks of upload activity. Cosine search finds niches similar to one you like. Drill from a broad niche into its sub-niches in one click."
          />
        </div>
      </div>
    </section>
  );
}

function Pillar({ step, title, body }: { step: string; title: string; body: string }) {
  return (
    <div className="bg-[#0a0a0a] p-7 lg:p-9">
      <div className="font-mono text-[11px] text-white/35 mb-6">{step}</div>
      <h3 className="text-[19px] font-semibold tracking-tight mb-3">{title}</h3>
      <p className="text-[14.5px] text-white/55 leading-[1.6]">{body}</p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Opportunity-score explainer — 4 metrics with definitions.
 * ──────────────────────────────────────────────────────────────── */

function OpportunityExplainer() {
  const metrics = [
    {
      label: 'OPP',
      value: '72',
      title: 'Opportunity score',
      body: 'Median log(views) / log(subs). Niches where channels are punching far above their subscriber count.',
      band: 'emerald' as const,
    },
    {
      label: 'TOP',
      value: '34%',
      title: 'Top-left density',
      body: 'Share of videos with above-median views AND below-median subs — the classic small-channel breakout signal.',
      band: 'emerald' as const,
    },
    {
      label: 'NEW',
      value: '88%',
      title: 'Newcomer success',
      body: 'Median views of channels under 6 months old, expressed as a percentage of the niche-wide median.',
      band: 'emerald' as const,
    },
    {
      label: 'CEIL',
      value: '1.4M',
      title: 'Low-sub ceiling',
      body: 'P90 views among channels under 10K subs — the realistic upper bound of a small creator inside this niche.',
      band: 'emerald' as const,
    },
  ];

  return (
    <section className="border-b border-white/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
        <div className="grid lg:grid-cols-[1fr_1.1fr] gap-16 items-start">
          <div className="lg:sticky lg:top-24">
            <div className="text-[11px] uppercase tracking-[0.2em] text-amber-400/80 font-semibold mb-4">
              Opportunity score
            </div>
            <h2 className="text-[34px] sm:text-[44px] font-bold tracking-[-0.02em] leading-[1.05] mb-5">
              Four numbers tell you whether a niche is worth your time.
            </h2>
            <p className="text-[16px] text-white/60 leading-[1.6]">
              Every niche card carries an <span className="text-white">OPP</span> · <span className="text-white">TOP</span> · <span className="text-white">NEW</span> · <span className="text-white">CEIL</span> row.
              Green across the board means small creators are reliably breaking out.
              Red means the niche is dominated by established channels and the door is closed.
            </p>
          </div>

          <div className="space-y-2">
            {metrics.map(m => (
              <Metric key={m.label} {...m} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Metric({
  label, value, title, body,
}: {
  label: string; value: string; title: string; body: string;
  band: 'emerald';
}) {
  return (
    <div className="group flex items-start gap-5 p-5 lg:p-6 rounded-2xl border border-white/[0.06] bg-[#0a0a0a] hover:border-white/15 hover:bg-[#0d0d0d] transition">
      <div className="flex-shrink-0 flex flex-col items-center justify-center rounded-xl border px-3 py-2.5 text-emerald-400 bg-emerald-500/10 border-emerald-500/20 min-w-[64px]">
        <span className="text-[9px] uppercase tracking-[0.12em] opacity-80 font-semibold">{label}</span>
        <span className="text-[18px] font-bold leading-tight mt-0.5 font-mono">{value}</span>
      </div>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold mb-1">{title}</h3>
        <p className="text-[14px] text-white/55 leading-[1.6]">{body}</p>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Final CTA
 * ──────────────────────────────────────────────────────────────── */

function FinalCta() {
  return (
    <section className="border-b border-white/[0.06]">
      <div className="max-w-4xl mx-auto px-6 py-28 lg:py-36 text-center">
        <h2 className="text-[40px] sm:text-[56px] font-bold tracking-[-0.025em] leading-[1.02] mb-6">
          See the niches everyone else
          <br />
          <span className="text-amber-400">is about to discover.</span>
        </h2>
        <p className="text-[16px] text-white/60 max-w-xl mx-auto mb-10 leading-[1.55]">
          One Google sign-in. Free to explore the whole map.
          No credit card, no setup, no questions.
        </p>
        <button
          type="button"
          onClick={() => signIn('google')}
          className="group inline-flex items-center gap-2 px-6 py-3.5 rounded-full bg-amber-400 hover:bg-amber-300 text-black font-semibold text-[14px] transition"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden>
            <path fill="#000" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" opacity="0.85"/>
            <path fill="#000" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A10.99 10.99 0 0012 23z" opacity="0.85"/>
            <path fill="#000" d="M5.84 14.1A6.6 6.6 0 015.5 12c0-.73.13-1.45.34-2.1V7.07H2.18A11 11 0 001 12c0 1.77.42 3.45 1.18 4.93l3.66-2.83z" opacity="0.85"/>
            <path fill="#000" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z" opacity="0.85"/>
          </svg>
          Sign in with Google
          <svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </button>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Footer
 * ──────────────────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer>
      <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-4 text-[12px] text-white/35">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-gradient-to-br from-amber-400 to-orange-500" />
          <span>rofe.ai · Niche Finder for YouTube Shorts</span>
        </div>
        <span>© {new Date().getFullYear()} rofe.ai</span>
      </div>
    </footer>
  );
}
