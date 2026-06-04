'use client';

import { useEffect, useState } from 'react';

/**
 * Admin → Content Gen tab.
 *
 * Two sub-views:
 *   - "Niches"  — browse the L1 + L2 ready niches surfaced by the
 *                  picker, click a niche to see its viable channels,
 *                  optionally select channels for a future generation
 *                  run (selection is local-only for now).
 *   - "Explore" — paste a channelId / handle / videoId, see the per-rule
 *                  pass/fail breakdown from explain-channel.
 *
 * Wires straight to /api/admin/content-gen/{overwatch,discover,
 * explain-channel} — no new endpoints needed.
 *
 * Data flow on activate:
 *   1. GET overwatch (cheap snapshot: funnel, ready niches, samples)
 *   2. GET discover?topK=300 (the full candidate pool — ~250 channels
 *      with their showcase_clusters attached)
 *   3. The niche drawer filters the cached candidates client-side by
 *      showcase_clusters.l1.cluster_id (for L1 niches) or .l2 (for L2)
 *
 * Both calls are idempotent + safe to re-fetch; we cache once per
 * activation and re-fetch only on the manual refresh button.
 */

interface ChannelCluster {
  cluster_id: number;
  level: 1 | 2;
  cluster_label: string | null;
  parent_cluster_id: number | null;
  cluster_video_count: number;
  channel_videos_in_cluster: number;
  run_id: number;
  run_kind: string | null;
}

interface Candidate {
  channel_id: string;
  channel_name: string;
  channel_handle: string | null;
  channel_avatar: string | null;
  subscriber_count: number;
  channel_age_days: number;
  total_video_count: number | null;
  top_video_views: number;
  top_video_id: number;
  top_video_title: string | null;
  top_video_posted_at: string | null;
  /** Thumbnail URL of the top video — fetched separately for v1. */
  top_video_thumbnail?: string | null;
  videos_indexed: number;
  median_video_views: number;
  views_to_subs_ratio: number;
  novelty_score: number | null;
  showcase_clusters: { l1: ChannelCluster | null; l2: ChannelCluster | null };
  composite_score: number;
  age_tier: 'mature' | 'mid_young' | 'young' | 'ultra_young';
}

interface ReadyClusterEntry {
  cluster_id: number;
  cluster_label: string | null;
  parent_cluster_id?: number | null;
  cluster_video_count: number;
  viable_channel_count: number;
  run_kind: string | null;
  started_at: string;
}

interface OverwatchResp {
  ok: true;
  elapsedMs: number;
  at: string;
  population: {
    total_videos: number;
    distinct_channels: number;
    enriched_channels: number;
    channels_with_age: number;
    channels_in_some_cluster: number;
  };
  funnel: Record<string, { count: number; pct: string } | number>;
  binding_constraint: {
    ranked_by_killing_pct: Array<{ rule: string; passing: number; killing_pct: number }>;
  };
  sample_top_candidates: Array<{
    channel_id: string;
    channel_name: string;
    subscriber_count: number;
    age_days: number;
    top_video_views: number;
    top_video_title: string;
    videos_indexed: number;
  }>;
  cluster_inventory: Record<string, {
    total_clusters: number;
    clusters_with_assignments: number;
    distinct_channels_covered: number;
  }>;
  ready_clusters: {
    l1_count: number;
    l2_count: number;
    top_l1_niches: ReadyClusterEntry[];
    top_l2_subniches: ReadyClusterEntry[];
  };
  recent_enrichment_stats: {
    enriched_last_24h: number;
    enriched_last_7d: number;
    needs_enrichment: number;
  };
}

interface ExplainResult {
  ok: boolean;
  channel_id?: string;
  verdict?: string;
  raw?: Record<string, unknown>;
  rules?: Array<{
    rule: string;
    actual?: number | string | null;
    actual_top_video_age_days?: number | null;
    threshold?: number | string;
    threshold_days?: number;
    pass: boolean;
  }>;
  failed_rules?: string[];
  showcase_clusters?: {
    l1: { cluster_id: number; cluster_label: string | null; run_kind: string | null } | null;
    l2: { cluster_id: number; cluster_label: string | null; parent_cluster_id: number | null; run_kind: string | null } | null;
  };
  error?: string;
  reason?: string;
}

const fmtNum = (n: number | null | undefined): string => {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
  return String(Math.round(n));
};

const fmtAge = (days: number | null | undefined): string => {
  if (days == null) return '—';
  if (days < 30)   return `${days}d`;
  if (days < 365)  return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(days < 730 ? 1 : 0)}y`;
};

const ageTierColor: Record<Candidate['age_tier'], string> = {
  ultra_young: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  young:       'bg-cyan-500/15    text-cyan-300    border-cyan-500/30',
  mid_young:   'bg-blue-500/15    text-blue-300    border-blue-500/30',
  mature:      'bg-slate-500/15   text-slate-300   border-slate-500/30',
};

export default function ContentGenTab({ active }: { active: boolean }) {
  const [subTab, setSubTab] = useState<'niches' | 'explore'>('niches');
  const [overwatch, setOverwatch] = useState<OverwatchResp | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nicheLevel, setNicheLevel] = useState<1 | 2>(2);
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());

  // Channel explorer state
  const [probeInput, setProbeInput] = useState('');
  const [probeResult, setProbeResult] = useState<ExplainResult | null>(null);
  const [probeLoading, setProbeLoading] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [owR, dcR] = await Promise.all([
        fetch('/api/admin/content-gen/overwatch').then(r => r.json()),
        fetch('/api/admin/content-gen/discover?topK=300').then(r => r.json()),
      ]);
      if (!owR.ok) throw new Error(owR.error || 'overwatch failed');
      if (!dcR.ok) throw new Error(dcR.error || 'discover failed');
      setOverwatch(owR);
      setCandidates(dcR.candidates || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active || overwatch) return;
    void loadAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const probeChannel = async () => {
    if (!probeInput.trim()) return;
    setProbeLoading(true);
    setProbeResult(null);
    try {
      const raw = probeInput.trim();
      const param =
        raw.startsWith('@')        ? `channelHandle=${encodeURIComponent(raw)}` :
        /^UC[\w-]{22}$/.test(raw)  ? `channelId=${encodeURIComponent(raw)}` :
        /^\d+$/.test(raw)          ? `videoId=${encodeURIComponent(raw)}` :
                                     `channelId=${encodeURIComponent(raw)}`;
      const r = await fetch(`/api/admin/content-gen/explain-channel?${param}`).then(r => r.json());
      setProbeResult(r);
    } catch (e) {
      setProbeResult({ ok: false, error: (e as Error).message });
    } finally {
      setProbeLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Header strip ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Content Generation — Discovery</h2>
          <p className="text-xs text-[#888] mt-1">
            Channel picker against the rules in <code className="text-[#aaa]">docs/content-gen/data-discovery-rules.json</code>.
            Sweeps the DB, attaches L1 niche + L2 sub-niche labels per candidate.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadAll()}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-md border border-[#2a2a2a] text-[#ccc] hover:border-amber-400 hover:text-amber-300 disabled:opacity-40"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-md bg-red-500/10 border border-red-500/30 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* ── Sub-tab switcher ─────────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-[#1a1a1a]">
        {(['niches', 'explore'] as const).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setSubTab(t)}
            className={`px-3 py-2 text-xs font-medium transition border-b-2 -mb-px ${
              subTab === t
                ? 'border-amber-400 text-amber-300'
                : 'border-transparent text-[#888] hover:text-white'
            }`}
          >
            {t === 'niches' ? 'Niches' : 'Channel Explorer'}
          </button>
        ))}
      </div>

      {/* ── NICHES SUB-TAB ───────────────────────────────────────────── */}
      {subTab === 'niches' && (
        <div className="space-y-6">
          {/* Stat tiles */}
          {overwatch && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <Stat label="Population channels"  value={fmtNum(overwatch.population.distinct_channels)} hint={`${fmtNum(overwatch.population.enriched_channels)} enriched`} />
              <Stat label="Viable candidates"    value={String(candidates.length)} hint={overwatch.funnel.pass_all_filters && typeof overwatch.funnel.pass_all_filters === 'object' ? `${(overwatch.funnel.pass_all_filters as { pct: string }).pct}% of pool` : ''} accent="amber" />
              <Stat label="Ready L1 niches"      value={String(overwatch.ready_clusters.l1_count)} hint="≥2 viable channels" />
              <Stat label="Ready L2 sub-niches"  value={String(overwatch.ready_clusters.l2_count)} hint="≥2 viable channels" />
              <Stat label="Binding constraint"   value={overwatch.binding_constraint.ranked_by_killing_pct[0]?.rule.replace(/^[A-D]\d+\s*\((.*)\).*$/, '$1') || '—'} hint={`${overwatch.binding_constraint.ranked_by_killing_pct[0]?.killing_pct.toFixed(0)}% killed`} />
            </div>
          )}

          {/* Funnel strip */}
          {overwatch && (
            <div className="p-3 rounded-md bg-[#0f0f0f] border border-[#1f1f1f]">
              <div className="text-[10px] uppercase tracking-wide text-[#666] mb-2">Filter funnel · pass-through per rule</div>
              <div className="space-y-1.5">
                {overwatch.binding_constraint.ranked_by_killing_pct.map(r => {
                  const pct = 100 - r.killing_pct;
                  return (
                    <div key={r.rule} className="flex items-center gap-2 text-xs">
                      <div className="w-44 text-[#aaa] truncate" title={r.rule}>{r.rule}</div>
                      <div className="flex-1 h-3 bg-[#1a1a1a] rounded overflow-hidden">
                        <div
                          className={`h-full ${r.killing_pct > 70 ? 'bg-red-500/40' : r.killing_pct > 40 ? 'bg-amber-500/40' : 'bg-emerald-500/40'}`}
                          style={{ width: `${pct.toFixed(1)}%` }}
                        />
                      </div>
                      <div className="w-20 text-right tabular-nums text-[#ccc]">{fmtNum(r.passing)}</div>
                      <div className="w-12 text-right tabular-nums text-[#888]">{pct.toFixed(1)}%</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Niche level switcher */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#888]">Granularity:</span>
              {[
                { key: 2, label: 'L2 sub-niches', count: overwatch?.ready_clusters.l2_count ?? 0 },
                { key: 1, label: 'L1 broad niches', count: overwatch?.ready_clusters.l1_count ?? 0 },
              ].map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => { setNicheLevel(opt.key as 1 | 2); }}
                  className={`px-3 py-1.5 rounded-md text-xs border transition ${
                    nicheLevel === opt.key
                      ? 'bg-amber-400/15 text-amber-300 border-amber-400/40'
                      : 'text-[#aaa] border-[#2a2a2a] hover:border-[#444]'
                  }`}
                >
                  {opt.label} <span className="text-[#666]">({opt.count})</span>
                </button>
              ))}
            </div>
            {selectedChannels.size > 0 && (
              <div className="text-xs text-[#aaa]">
                <span className="text-amber-300 font-medium">{selectedChannels.size}</span> channels selected
              </div>
            )}
          </div>

          {/* Suggested-listicle cards — one card per ready niche */}
          {!overwatch && loading && (
            <div className="text-xs text-[#888]">Loading suggestions…</div>
          )}
          {overwatch && (() => {
            const nicheList = nicheLevel === 1
              ? overwatch.ready_clusters.top_l1_niches
              : overwatch.ready_clusters.top_l2_subniches;
            if (nicheList.length === 0) {
              return (
                <div className="p-6 rounded-md bg-[#0f0f0f] border border-[#1f1f1f] text-xs text-[#888] text-center">
                  No niches with ≥2 viable channels at this level yet.
                </div>
              );
            }
            // Build cards: one per ready niche, paired with the
            // channels from the cached candidate pool whose showcase
            // matches it. Skip niches with zero matched channels (data
            // misalignment edge cases) so the user only sees actionable
            // suggestions.
            const cards = nicheList
              .map(niche => {
                const channels = candidates
                  .filter(c => {
                    const sc = nicheLevel === 1 ? c.showcase_clusters.l1 : c.showcase_clusters.l2;
                    return sc?.cluster_id === niche.cluster_id;
                  })
                  .sort((a, b) => b.composite_score - a.composite_score);
                return { niche, channels };
              })
              .filter(card => card.channels.length > 0);

            if (cards.length === 0) {
              return (
                <div className="p-6 rounded-md bg-[#0f0f0f] border border-[#1f1f1f] text-xs text-[#888] text-center">
                  Ready niches surfaced but their channels didn&apos;t make the cached top-300 pool. Try Refresh or widen the pool.
                </div>
              );
            }

            return (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {cards.map(({ niche, channels }) => (
                  <ListicleSuggestionCard
                    key={`${niche.cluster_id}-${niche.started_at}`}
                    niche={niche}
                    level={nicheLevel}
                    channels={channels}
                    selectedChannels={selectedChannels}
                    onToggleChannel={(channelId) => {
                      const next = new Set(selectedChannels);
                      if (next.has(channelId)) next.delete(channelId);
                      else next.add(channelId);
                      setSelectedChannels(next);
                    }}
                  />
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* ── CHANNEL EXPLORER SUB-TAB ─────────────────────────────────── */}
      {subTab === 'explore' && (
        <div className="space-y-4">
          <div className="p-3 rounded-md bg-[#0f0f0f] border border-[#1f1f1f]">
            <label className="text-[10px] uppercase tracking-wide text-[#666]">
              Probe a channel
            </label>
            <p className="text-[11px] text-[#888] mt-1 mb-2">
              Accepts a channel ID (<code className="text-[#aaa]">UC…</code>),
              a YouTube handle (<code className="text-[#aaa]">@foo</code>), or
              a video id (integer from <code className="text-[#aaa]">niche_spy_videos.id</code>).
              Walks the channel through every discovery rule.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={probeInput}
                onChange={e => setProbeInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void probeChannel(); }}
                placeholder="UCxxxxxxxxxxxxxxxxxxxxxx  or  @handle  or  video_id"
                className="flex-1 px-3 py-2 text-sm bg-[#0a0a0a] border border-[#2a2a2a] focus:border-amber-400 focus:outline-none rounded text-white"
              />
              <button
                type="button"
                onClick={() => void probeChannel()}
                disabled={probeLoading || !probeInput.trim()}
                className="text-xs px-4 py-2 rounded-md border border-amber-500/40 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20 disabled:opacity-40"
              >
                {probeLoading ? 'Probing…' : 'Probe'}
              </button>
            </div>
          </div>

          {probeResult && !probeResult.ok && (
            <div className="p-3 rounded-md bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              {probeResult.error || probeResult.reason || 'Unknown failure.'}
            </div>
          )}

          {probeResult && probeResult.ok && probeResult.rules && (
            <div className="space-y-3">
              <div className={`p-3 rounded-md border text-sm font-semibold ${
                probeResult.verdict?.startsWith('PASS')
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-red-500/10 border-red-500/30 text-red-300'
              }`}>
                {probeResult.verdict || (probeResult.failed_rules?.length ? 'REJECTED' : 'PASS')}
                <span className="ml-2 font-mono text-xs text-[#aaa]">{probeResult.channel_id}</span>
              </div>

              {probeResult.raw && (
                <div className="p-3 rounded-md bg-[#0f0f0f] border border-[#1f1f1f] grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-2 text-xs">
                  {Object.entries(probeResult.raw).map(([k, v]) => (
                    <div key={k}>
                      <div className="text-[9px] uppercase text-[#666]">{k}</div>
                      <div className="text-[#ccc] truncate" title={String(v ?? '—')}>
                        {v == null ? '—' : typeof v === 'number' && k !== 'age_days' && k !== 'top_video_age_days' && k !== 'videos_indexed' && k !== 'views_to_subs_ratio' && k !== 'novelty_score' && k !== 'total_video_count' ? fmtNum(v) : String(v)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="p-3 rounded-md bg-[#0f0f0f] border border-[#1f1f1f]">
                <div className="text-[10px] uppercase tracking-wide text-[#666] mb-2">Rules</div>
                <div className="space-y-1">
                  {probeResult.rules.map((r, i) => (
                    <div key={i} className={`flex items-center gap-2 text-xs p-2 rounded ${r.pass ? 'bg-emerald-500/5' : 'bg-red-500/5'}`}>
                      <span className={`w-5 text-center ${r.pass ? 'text-emerald-400' : 'text-red-400'}`}>
                        {r.pass ? '✓' : '✗'}
                      </span>
                      <span className="flex-1 text-[#ccc]">{r.rule}</span>
                      <span className="text-[#888]">
                        actual: <span className="text-[#ccc]">{String(r.actual ?? r.actual_top_video_age_days ?? '—')}</span>
                        {' · '}
                        threshold: <span className="text-[#ccc]">{String(r.threshold ?? r.threshold_days ?? '—')}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {probeResult.showcase_clusters && (probeResult.showcase_clusters.l1 || probeResult.showcase_clusters.l2) && (
                <div className="p-3 rounded-md bg-[#0f0f0f] border border-[#1f1f1f]">
                  <div className="text-[10px] uppercase tracking-wide text-[#666] mb-2">Showcase clusters (top video&apos;s niche)</div>
                  <div className="space-y-1.5 text-xs">
                    {probeResult.showcase_clusters.l1 && (
                      <div>
                        <span className="text-[#666]">L1:</span>{' '}
                        <span className="text-white">{probeResult.showcase_clusters.l1.cluster_label || `cluster #${probeResult.showcase_clusters.l1.cluster_id}`}</span>
                        <span className="text-[#666] ml-2">cluster {probeResult.showcase_clusters.l1.cluster_id} · {probeResult.showcase_clusters.l1.run_kind}</span>
                      </div>
                    )}
                    {probeResult.showcase_clusters.l2 && (
                      <div>
                        <span className="text-[#666]">L2:</span>{' '}
                        <span className="text-white">{probeResult.showcase_clusters.l2.cluster_label || `cluster #${probeResult.showcase_clusters.l2.cluster_id}`}</span>
                        <span className="text-[#666] ml-2">cluster {probeResult.showcase_clusters.l2.cluster_id} · parent L1 {probeResult.showcase_clusters.l2.parent_cluster_id} · {probeResult.showcase_clusters.l2.run_kind}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: 'amber' | 'emerald';
}) {
  return (
    <div className="p-3 rounded-md bg-[#0f0f0f] border border-[#1f1f1f]">
      <div className="text-[9px] uppercase tracking-wide text-[#666]">{label}</div>
      <div className={`text-xl font-bold mt-0.5 tabular-nums ${
        accent === 'amber' ? 'text-amber-300' : accent === 'emerald' ? 'text-emerald-300' : 'text-white'
      }`}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-[#666] mt-0.5">{hint}</div>}
    </div>
  );
}

/**
 * One "suggested listicle" card. The card represents a video we could
 * generate from this niche, with 3-5 of its viable channels as candidate
 * items in the listicle. The user can toggle individual channels in/out
 * before triggering generation.
 *
 * Layout:
 *   Header: niche title + L1/L2 badge + parent L1 (for L2) + viable count
 *   Body  : up to 5 channel rows with thumbnails of their top video
 *   Footer: action buttons (Generate / Edit selection)
 */
function ListicleSuggestionCard({
  niche,
  level,
  channels,
  selectedChannels,
  onToggleChannel,
}: {
  niche: ReadyClusterEntry;
  level: 1 | 2;
  channels: Candidate[];
  selectedChannels: Set<string>;
  onToggleChannel: (channelId: string) => void;
}) {
  // Show top-5 by composite score in the preview. The full list is
  // queryable on click but for the card we only need a preview.
  const previewChannels = channels.slice(0, 5);
  const total = channels.length;
  const selectedCount = previewChannels.filter(c => selectedChannels.has(c.channel_id)).length;

  return (
    <div className="rounded-lg bg-[#0f0f0f] border border-[#1f1f1f] hover:border-[#2a2a2a] transition overflow-hidden flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-[#1a1a1a]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                level === 1
                  ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30'
                  : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
              }`}>
                {level === 1 ? 'L1' : 'L2'}
              </span>
              <h3 className="text-sm font-semibold text-white truncate" title={niche.cluster_label || ''}>
                {niche.cluster_label || `cluster #${niche.cluster_id}`}
              </h3>
            </div>
            <div className="text-[10px] text-[#666] mt-1">
              cluster {niche.cluster_id}
              {niche.parent_cluster_id && <> · parent L1 {niche.parent_cluster_id}</>}
              {' · '}{fmtNum(niche.cluster_video_count)} videos in niche
            </div>
          </div>
          <div className="flex flex-col items-end shrink-0">
            <span className={`text-base font-bold tabular-nums ${
              total >= 8 ? 'text-emerald-300' : total >= 4 ? 'text-amber-300' : 'text-[#aaa]'
            }`}>
              {total}
            </span>
            <span className="text-[9px] text-[#666] uppercase leading-none">channels</span>
          </div>
        </div>
      </div>

      {/* Body — channel preview rows */}
      <div className="divide-y divide-[#1a1a1a] flex-1">
        {previewChannels.map(c => {
          const isSel = selectedChannels.has(c.channel_id);
          return (
            <button
              key={c.channel_id}
              type="button"
              onClick={() => onToggleChannel(c.channel_id)}
              className={`w-full flex items-center gap-2 p-2 text-left transition ${
                isSel ? 'bg-amber-400/5' : 'hover:bg-[#141414]'
              }`}
            >
              <input
                type="checkbox"
                checked={isSel}
                onChange={() => {}}
                className="w-3 h-3 accent-amber-400 shrink-0"
              />
              {/* Thumbnail of the top video — 16:9 aspect ratio */}
              {c.top_video_thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={c.top_video_thumbnail}
                  alt=""
                  className="w-16 h-9 object-cover rounded-sm bg-[#222] shrink-0"
                />
              ) : (
                <div className="w-16 h-9 rounded-sm bg-[#1a1a1a] shrink-0 flex items-center justify-center">
                  <svg className="w-4 h-4 text-[#444]" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {c.channel_avatar && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.channel_avatar} alt="" className="w-4 h-4 rounded-full object-cover shrink-0" />
                  )}
                  <span className="text-xs text-white truncate font-medium">{c.channel_name || '(unnamed)'}</span>
                  <span className={`text-[8px] px-1 py-px rounded border shrink-0 ${ageTierColor[c.age_tier]}`}>
                    {c.age_tier === 'ultra_young' ? 'ultra' : c.age_tier === 'mid_young' ? 'mid' : c.age_tier}
                  </span>
                </div>
                <div className="text-[10px] text-[#888] truncate" title={c.top_video_title || ''}>
                  {c.top_video_title || '—'}
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-[9px] text-[#666] tabular-nums">
                  <span>{fmtNum(c.subscriber_count)} subs</span>
                  <span>·</span>
                  <span className="text-[#aaa]">{fmtNum(c.top_video_views)} top views</span>
                  <span>·</span>
                  <span>{c.views_to_subs_ratio}×</span>
                  <span>·</span>
                  <span>{fmtAge(c.channel_age_days)}</span>
                </div>
              </div>
            </button>
          );
        })}
        {total > 5 && (
          <div className="px-2 py-1.5 text-[10px] text-[#666] text-center">
            + {total - 5} more candidate{total - 5 === 1 ? '' : 's'} in this niche
          </div>
        )}
      </div>

      {/* Footer — actions */}
      <div className="p-2 border-t border-[#1a1a1a] flex items-center justify-between gap-2 bg-[#0a0a0a]">
        <span className="text-[10px] text-[#666]">
          {selectedCount > 0 ? (
            <>
              <span className="text-amber-300">{selectedCount}</span> picked
            </>
          ) : (
            'Pick channels to include'
          )}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled
            title="Coming soon — generate a Class B listicle from this niche"
            className="text-[10px] px-2 py-1 rounded border border-amber-500/40 text-amber-300 bg-amber-400/5 hover:bg-amber-400/15 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Generate ▸
          </button>
        </div>
      </div>
    </div>
  );
}
