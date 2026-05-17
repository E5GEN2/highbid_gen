'use client';

import React from 'react';
import { signIn } from 'next-auth/react';

/**
 * Marketing landing page shown to signed-out visitors at the bare
 * domain. Pitches Niche Finder as a YouTube research platform
 * organized around five lenses (Niches / Videos / Channels /
 * Outliers / Similar) plus three search modes (semantic by meaning,
 * kNN by embedding, substring).
 *
 * Visual anchors are CSS-rendered mocks of in-app surfaces
 * (cluster card, outlier card, similar modal, semantic search bar)
 * so the post-sign-in product feels continuous.
 */
export function LandingPage() {
  return (
    <div className="min-h-screen bg-[#070707] text-white antialiased selection:bg-amber-400/30">
      <Header />
      <Hero />
      <Lenses />
      <SearchModes />
      <SortLibrary />
      <DrillDown />
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
        <a href="/" className="flex items-center gap-2">
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
 *  Hero — pitch left, faux niche card right
 * ──────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-white/[0.06]">
      <div
        aria-hidden
        className="absolute -right-32 top-24 w-[640px] h-[640px] rounded-full bg-amber-500/[0.08] blur-3xl pointer-events-none"
      />
      <div className="relative max-w-6xl mx-auto px-6 pt-20 pb-24 lg:pt-28 lg:pb-32">
        <div className="grid lg:grid-cols-[1.05fr_1fr] gap-12 lg:gap-16 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-[11px] text-white/60 mb-7 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Indexing 4,164 niches · refreshed hourly
            </div>

            <h1 className="text-[42px] sm:text-[56px] lg:text-[64px] font-bold tracking-[-0.03em] leading-[1.02] mb-6">
              Research YouTube
              <br />
              like a <span className="text-amber-400">data scientist.</span>
            </h1>

            <p className="text-[17px] sm:text-[18px] text-white/65 max-w-xl leading-[1.55] mb-9">
              rofe.ai auto-clusters the YouTube video corpus into 4,164 niches,
              runs semantic search across video meaning, finds channels punching
              above their subscriber count, and gives you five different lenses
              on what&apos;s actually working — long-form and Shorts.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => signIn('google')}
                className="group inline-flex items-center gap-2 px-5 py-3 rounded-full bg-amber-400 hover:bg-amber-300 text-black font-semibold text-[14px] transition"
              >
                Open the map
                <svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </button>
              <span className="text-[13px] text-white/40">Google sign-in · free to explore</span>
            </div>

            <dl className="grid grid-cols-4 gap-px mt-12 max-w-lg bg-white/[0.06] rounded-xl overflow-hidden border border-white/[0.06]">
              <Stat label="Niches" value="4,164" />
              <Stat label="Lenses" value="5" />
              <Stat label="Search modes" value="3" />
              <Stat label="Refresh" value="Hourly" />
            </dl>
          </div>

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
 *  Lenses — the five surfaces, each with a 1-sentence description.
 * ──────────────────────────────────────────────────────────────── */

function Lenses() {
  // Annotated as the union type so the literal accents stay narrow
  // when passed into LensCard — TS widens to `string` otherwise and
  // the colour lookups fail to typecheck.
  const lenses: Array<{
    tag: string;
    title: string;
    body: string;
    icon: React.ReactNode;
    accent: 'amber' | 'rose' | 'emerald' | 'blue' | 'purple';
  }> = [
    {
      tag: 'Niches',
      title: 'Auto-discovered niches',
      body: 'HDBSCAN over multimodal title + thumbnail embeddings — 4,164 clusters split into broad niches (L1) and sub-niches (L2). No keyword lists to maintain. New videos snap into the right cluster automatically.',
      icon: <NichesIcon />,
      accent: 'amber',
    },
    {
      tag: 'Outliers',
      title: 'Find small channels punching big',
      body: 'Every video gets a peer-bucket score against channels of similar size. Six presets — viral on small channels, above 1M views, high outlier score, high views with few videos — surface the breakout patterns instantly.',
      icon: <OutlierIcon />,
      accent: 'rose',
    },
    {
      tag: 'Videos',
      title: 'Every video, every sort',
      body: 'A full-DB grid you can sort by views, score, recency, likes, or centroid distance to a niche. Filter by min score (50+/70+/80+/90+). Toggle to long-form, Shorts, or both.',
      icon: <VideosIcon />,
      accent: 'emerald',
    },
    {
      tag: 'Channels',
      title: 'Channel analytics, at a glance',
      body: 'Sort channels by total views, video count, subscribers, age, or average score. Filter to channels under 30 days, 3 months, 6 months. Watch newcomers grow alongside established names in the same niche.',
      icon: <ChannelsIcon />,
      accent: 'blue',
    },
    {
      tag: 'Similar',
      title: 'kNN over title, thumbnail, or both',
      body: 'Pick any video or any niche and pull its closest neighbors across three embedding spaces. Title-only, thumbnail-only, or combined multimodal. Slide the "% match" threshold live to tune precision.',
      icon: <SimilarIcon />,
      accent: 'purple',
    },
  ];

  return (
    <section className="border-b border-white/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
        <div className="max-w-2xl mb-14">
          <div className="text-[11px] uppercase tracking-[0.2em] text-amber-400/80 font-semibold mb-4">
            Five lenses
          </div>
          <h2 className="text-[34px] sm:text-[44px] font-bold tracking-[-0.02em] leading-[1.05]">
            One dataset.
            <br />
            Five ways to mine it.
          </h2>
          <p className="text-[17px] text-white/60 leading-[1.55] mt-5">
            Each lens is a different question you can ask the same corpus.
            Combine them — find a niche, drill its outliers, pull its similar
            siblings, inspect the top channels — without ever leaving the app.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-3">
          {lenses.map((l, i) => (
            <LensCard key={i} {...l} wide={i === 0} />
          ))}
        </div>
      </div>
    </section>
  );
}

function LensCard({
  tag, title, body, icon, accent, wide,
}: {
  tag: string; title: string; body: string;
  icon: React.ReactNode;
  accent: 'amber' | 'rose' | 'emerald' | 'blue' | 'purple';
  wide?: boolean;
}) {
  const accentText = {
    amber:   'text-amber-300',
    rose:    'text-rose-300',
    emerald: 'text-emerald-300',
    blue:    'text-blue-300',
    purple:  'text-purple-300',
  }[accent];
  const accentBg = {
    amber:   'bg-amber-500/10 border-amber-500/20',
    rose:    'bg-rose-500/10 border-rose-500/20',
    emerald: 'bg-emerald-500/10 border-emerald-500/20',
    blue:    'bg-blue-500/10 border-blue-500/20',
    purple:  'bg-purple-500/10 border-purple-500/20',
  }[accent];
  return (
    <div className={`p-7 lg:p-8 rounded-2xl bg-[#0c0c0c] border border-white/[0.06] hover:border-white/15 transition ${wide ? 'md:col-span-2' : ''}`}>
      <div className="flex items-start gap-4 mb-5">
        <div className={`flex-shrink-0 w-11 h-11 rounded-xl border ${accentBg} flex items-center justify-center ${accentText}`}>
          {icon}
        </div>
        <div>
          <div className={`text-[10px] uppercase tracking-[0.18em] font-semibold ${accentText} mb-1`}>{tag}</div>
          <h3 className="text-[18px] font-semibold tracking-tight text-white">{title}</h3>
        </div>
      </div>
      <p className="text-[14.5px] text-white/55 leading-[1.65]">{body}</p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Search modes — semantic + kNN + substring
 * ──────────────────────────────────────────────────────────────── */

function SearchModes() {
  return (
    <section className="border-b border-white/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
        <div className="grid lg:grid-cols-[1fr_1.1fr] gap-16 items-center">
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-amber-400/80 font-semibold mb-4">
              Search by meaning
            </div>
            <h2 className="text-[34px] sm:text-[44px] font-bold tracking-[-0.02em] leading-[1.05] mb-5">
              Three ways to search.
              <br />
              None of them are keywords.
            </h2>
            <p className="text-[16px] text-white/60 leading-[1.65] mb-7">
              Keyword search is brittle. The same idea wears a hundred different
              titles. So we embed every video into a joint title + thumbnail
              space and search by what the videos actually <em>mean</em>.
            </p>
            <ul className="space-y-4">
              <SearchMode
                name="Semantic search"
                body='Type a phrase — "tired guy at desk", "AI-generated horror story", "dad woodworking" — and rank niches or videos by cosine to your query. Cached so repeat searches are instant.'
              />
              <SearchMode
                name="kNN similarity"
                body='Click "Similar" on any video or niche to pull its closest neighbors. Choose the embedding space: title, thumbnail, or combined multimodal.'
              />
              <SearchMode
                name="Substring fallback"
                body="Still want a classic title / channel filter? Live debounced text search ships on every grid, ILIKE-backed for speed."
              />
            </ul>
          </div>

          <div>
            <FauxSearchPanel />
          </div>
        </div>
      </div>
    </section>
  );
}

function SearchMode({ name, body }: { name: string; body: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3.5">
      <div className="mt-0.5 flex-shrink-0 w-6 h-6 rounded-md bg-amber-400/15 border border-amber-400/25 flex items-center justify-center">
        <svg className="w-3 h-3 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <div>
        <h4 className="text-[15px] font-semibold text-white mb-1">{name}</h4>
        <p className="text-[14px] text-white/55 leading-[1.6]">{body}</p>
      </div>
    </li>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Sort library — the breadth of sort/filter options as chips.
 * ──────────────────────────────────────────────────────────────── */

function SortLibrary() {
  const buckets = [
    {
      label: 'Sort niches',
      chips: ['Most Videos', 'Most Views', 'Highest Score', 'Opportunity ↑', 'Top-Left ↑', 'Newcomer ↑', 'Ceiling ↑'],
    },
    {
      label: 'Sort videos',
      chips: ['Most central', 'Most outlier', 'Highest score', 'Most views', 'Most likes', 'Newest', 'Oldest', 'Best match'],
    },
    {
      label: 'Sort channels',
      chips: ['Total Views', 'Video Count', 'Subscribers', 'Newest', 'Avg Score'],
    },
    {
      label: 'Filter outliers',
      chips: ['Viral on small channels', 'Viral on medium channels', 'Above 1M views', 'High outlier score', 'High views, few videos'],
    },
    {
      label: 'Filter by recency',
      chips: ['30 days', '3 months', '6 months', '8 months', '1 year', 'All time'],
    },
    {
      label: 'Filter by min score',
      chips: ['Any', '50+', '70+', '80+', '90+'],
    },
  ];

  return (
    <section className="border-b border-white/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
        <div className="max-w-2xl mb-12">
          <div className="text-[11px] uppercase tracking-[0.2em] text-amber-400/80 font-semibold mb-4">
            Sort & filter
          </div>
          <h2 className="text-[34px] sm:text-[44px] font-bold tracking-[-0.02em] leading-[1.05]">
            Every angle.
            <br />
            One click away.
          </h2>
          <p className="text-[17px] text-white/60 leading-[1.55] mt-5">
            Pick a lens, pick a sort, pick a recency window. Stack them. The
            full sort/filter library across every page in the product:
          </p>
        </div>
        <div className="space-y-7">
          {buckets.map((b, i) => (
            <div key={i} className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-4 sm:gap-6 items-baseline pb-7 border-b border-white/[0.04] last:border-b-0">
              <div className="text-[12px] uppercase tracking-[0.14em] text-white/40 font-semibold pt-1">{b.label}</div>
              <div className="flex flex-wrap gap-1.5">
                {b.chips.map((c, j) => (
                  <span key={j} className="text-[12.5px] px-2.5 py-1 rounded-full bg-white/[0.04] text-white/75 border border-white/[0.06]">
                    {c}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Drill-down — how navigation flows through the product.
 * ──────────────────────────────────────────────────────────────── */

function DrillDown() {
  return (
    <section className="border-b border-white/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
        <div className="text-center mb-14">
          <div className="text-[11px] uppercase tracking-[0.2em] text-amber-400/80 font-semibold mb-4">
            One click to anywhere
          </div>
          <h2 className="text-[34px] sm:text-[44px] font-bold tracking-[-0.02em] leading-[1.05]">
            Drill from broad to specific
            <br />
            without breaking flow.
          </h2>
        </div>

        <div className="grid md:grid-cols-5 gap-px bg-white/[0.06] rounded-2xl overflow-hidden border border-white/[0.06]">
          <Step n="01" label="Pick a niche" detail="4,164 to choose from. Sort by Most Views, scan." />
          <Step n="02" label="Drill in"     detail="Videos · Sub-niches · Channels · Insights tabs." />
          <Step n="03" label="Find outliers" detail="Sort by Most Outlier inside the niche, score≥80." />
          <Step n="04" label="See the channel" detail="Age, dormancy, top videos, score history." />
          <Step n="05" label="Pull siblings"  detail="One click — every similar niche, mixed L1 + L2." />
        </div>

        {/* Opportunity-score row — kept brief on purpose. The four
            pills carry meaning visually; the prose can fit in a
            single line because the lens cards already mentioned the
            scoring. */}
        <div className="mt-20 p-7 lg:p-9 rounded-2xl bg-gradient-to-br from-emerald-500/[0.07] to-transparent border border-white/[0.08]">
          <div className="flex flex-col md:flex-row md:items-center gap-6">
            <div className="flex items-stretch gap-1.5 flex-shrink-0">
              <Pill label="OPP"  value="72"   />
              <Pill label="TOP"  value="34%"  />
              <Pill label="NEW"  value="88%"  />
              <Pill label="CEIL" value="1.4M" />
            </div>
            <div className="min-w-0">
              <h3 className="text-[18px] font-semibold tracking-tight mb-1.5">
                Plus: every niche carries an Opportunity score.
              </h3>
              <p className="text-[14.5px] text-white/55 leading-[1.6]">
                Four numbers — view-to-sub ratio, top-left density, newcomer success, low-sub ceiling — tell you
                whether the niche is dominated by giants or quietly cracked open for small creators.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Step({ n, label, detail }: { n: string; label: string; detail: string }) {
  return (
    <div className="bg-[#0a0a0a] p-5 lg:p-6">
      <div className="font-mono text-[11px] text-white/35 mb-3">{n}</div>
      <div className="text-[15px] font-semibold text-white mb-1.5">{label}</div>
      <div className="text-[13px] text-white/50 leading-[1.55]">{detail}</div>
    </div>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-emerald-500/25 bg-emerald-500/10 text-emerald-300 px-2.5 py-1.5 min-w-[52px]">
      <span className="text-[9px] uppercase tracking-[0.1em] opacity-80 font-semibold">{label}</span>
      <span className="text-[13px] font-bold leading-tight mt-0.5 font-mono">{value}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Final CTA
 * ──────────────────────────────────────────────────────────────── */

function FinalCta() {
  return (
    <section>
      <div className="max-w-4xl mx-auto px-6 py-28 lg:py-36 text-center">
        <h2 className="text-[40px] sm:text-[56px] font-bold tracking-[-0.025em] leading-[1.02] mb-6">
          Stop scrolling YouTube.
          <br />
          <span className="text-amber-400">Start mapping it.</span>
        </h2>
        <p className="text-[16px] text-white/60 max-w-xl mx-auto mb-10 leading-[1.55]">
          One Google sign-in. Free to explore every lens, every sort,
          every search mode. No credit card, no setup.
        </p>
        <button
          type="button"
          onClick={() => signIn('google')}
          className="group inline-flex items-center gap-2 px-6 py-3.5 rounded-full bg-amber-400 hover:bg-amber-300 text-black font-semibold text-[14px] transition"
        >
          <GoogleG />
          Sign in with Google
          <svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </button>
      </div>
    </section>
  );
}

function GoogleG() {
  // Monochrome black-on-amber Google G for the CTA button — keeps
  // the button visually unified (no rainbow logo on amber).
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden>
      <path fill="#000" opacity="0.85" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#000" opacity="0.85" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A10.99 10.99 0 0012 23z"/>
      <path fill="#000" opacity="0.85" d="M5.84 14.1A6.6 6.6 0 015.5 12c0-.73.13-1.45.34-2.1V7.07H2.18A11 11 0 001 12c0 1.77.42 3.45 1.18 4.93l3.66-2.83z"/>
      <path fill="#000" opacity="0.85" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Footer
 * ──────────────────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer className="border-t border-white/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-4 text-[12px] text-white/35">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-gradient-to-br from-amber-400 to-orange-500" />
          <span>rofe.ai · YouTube research, mapped</span>
        </div>
        <span>© {new Date().getFullYear()} rofe.ai</span>
      </div>
    </footer>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Faux visual mockups — CSS renders of in-app surfaces.
 *  Designed to look as close as possible to the real components.
 * ──────────────────────────────────────────────────────────────── */

function FauxNicheCard() {
  return (
    <div className="relative bg-[#101010] border border-white/[0.08] rounded-2xl shadow-2xl shadow-amber-500/[0.06] overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            <span className="text-[11px] bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full px-2 py-0.5 font-medium">
              1,247 videos
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/60 text-white/60 border border-white/10">L1</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
              3 sub-niches
            </span>
          </div>
          <h3 className="text-[14px] font-medium text-white truncate">
            Solo woodworking · workshop builds
          </h3>
        </div>
        <FauxOppPills />
      </div>

      <div className="grid grid-cols-4 gap-2 px-5 mb-4">
        <FauxStatTile label="Avg views" value="480K" />
        <FauxHeartbeat />
        <FauxStatTile label="Total views" value="1.2B" valueColor="text-emerald-400" />
        <FauxStatTile label="Channels" value="312" valueColor="text-blue-400" />
      </div>

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

function FauxStatTile({ label, value, valueColor = 'text-white' }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="bg-black/40 border border-white/[0.06] rounded-lg px-2.5 py-2">
      <div className="text-[9px] text-white/40 uppercase tracking-[0.1em] font-medium">{label}</div>
      <div className={`text-[15px] font-semibold ${valueColor} mt-0.5 font-mono`}>{value}</div>
    </div>
  );
}

function FauxHeartbeat() {
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
          return <rect key={i} x={i * (barW + 0.3)} y={22 - h} width={barW} height={h} fill="#34d399" rx={0.4} />;
        })}
      </svg>
    </div>
  );
}

function FauxOppPills() {
  const pills = [
    { label: 'OPP',  value: '72'   },
    { label: 'TOP',  value: '34%'  },
    { label: 'NEW',  value: '88%'  },
    { label: 'CEIL', value: '1.4M' },
  ];
  return (
    <div className="flex items-stretch gap-1 flex-shrink-0">
      {pills.map(p => (
        <div key={p.label} className="flex flex-col items-center justify-center rounded-md border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 px-2 py-1">
          <span className="text-[8px] uppercase tracking-[0.1em] opacity-70 leading-none font-medium">{p.label}</span>
          <span className="text-[11px] font-bold leading-tight mt-0.5 font-mono">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

function FauxSearchPanel() {
  return (
    <div className="relative bg-[#101010] border border-white/[0.08] rounded-2xl overflow-hidden shadow-2xl shadow-amber-500/[0.04]">
      {/* Top: semantic search bar */}
      <div className="p-5 border-b border-white/[0.06]">
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-black/40 border border-white/[0.08]">
          <svg className="w-4 h-4 text-white/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
          </svg>
          <span className="text-[14px] text-white/80 font-mono">tired guy at desk, dramatic music</span>
          <span className="ml-auto px-2 py-0.5 rounded-md bg-amber-400 text-black text-[10px] font-bold uppercase tracking-wider">↵ Search</span>
        </div>
        <div className="flex items-center gap-2 mt-3 text-[11px] text-white/40">
          <span>Min match</span>
          <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full w-[68%] bg-amber-400 rounded-full" />
          </div>
          <span className="font-mono text-white/70">68%</span>
        </div>
      </div>

      {/* Bottom: results preview */}
      <div className="p-5 space-y-2">
        <FauxSearchResult label="Office burnout · dramatic edits"      pct="91%" videos="847"   accent="amber" />
        <FauxSearchResult label="9-to-5 grind compilations"            pct="84%" videos="1,302" accent="amber" />
        <FauxSearchResult label="Existential workplace shorts"         pct="78%" videos="412"   accent="amber" />
        <FauxSearchResult label="Corporate satire · dark humor"        pct="72%" videos="298"   accent="amber" />
        <FauxSearchResult label="Quiet quitting · gen-z workplace"     pct="69%" videos="556"   accent="amber" dim />
      </div>
    </div>
  );
}

function FauxSearchResult({
  label, pct, videos, dim,
}: { label: string; pct: string; videos: string; accent: 'amber'; dim?: boolean }) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg bg-black/30 border border-white/[0.05] ${dim ? 'opacity-50' : ''}`}>
      <div className="w-9 h-9 rounded-md bg-gradient-to-br from-amber-500/30 to-orange-700/30 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-white truncate">{label}</div>
        <div className="text-[10px] text-white/40 font-mono mt-0.5">{videos} videos</div>
      </div>
      <span className="text-[11px] bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-full px-2 py-0.5 font-medium font-mono">
        {pct}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Icons (kept inline because each is one-off)
 * ──────────────────────────────────────────────────────────────── */

function NichesIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="6"  cy="7"  r="2.5" />
      <circle cx="17" cy="6"  r="2"   />
      <circle cx="12" cy="13" r="2.2" />
      <circle cx="6"  cy="17" r="1.8" />
      <circle cx="18" cy="17" r="2.4" />
      <path strokeLinecap="round" d="M6 9.5v5.5M8 7.5l6 1M14 12l3-4M14 14l3 1.5M8 16l3-2" />
    </svg>
  );
}
function OutlierIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 17l5-5 4 4 7-8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 8h4v4" />
    </svg>
  );
}
function VideosIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="6" width="14" height="12" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 10l4-2v8l-4-2" />
    </svg>
  );
}
function ChannelsIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="9" cy="9" r="3" />
      <path strokeLinecap="round" d="M3 19a6 6 0 0112 0" />
      <circle cx="17" cy="11" r="2" />
      <path strokeLinecap="round" d="M14 19a4 4 0 017-1" />
    </svg>
  );
}
function SimilarIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="9"  cy="12" r="5" />
      <circle cx="15" cy="12" r="5" />
    </svg>
  );
}
