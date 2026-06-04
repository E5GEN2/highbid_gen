'use client';

import { useEffect, useMemo, useState } from 'react';

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
  const [selectedNiche, setSelectedNiche] = useState<ReadyClusterEntry | null>(null);
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

  const channelsInSelectedNiche = useMemo(() => {
    if (!selectedNiche) return [];
    return candidates
      .filter(c => {
        const sc = nicheLevel === 1 ? c.showcase_clusters.l1 : c.showcase_clusters.l2;
        return sc?.cluster_id === selectedNiche.cluster_id;
      })
      .sort((a, b) => b.composite_score - a.composite_score);
  }, [candidates, selectedNiche, nicheLevel]);

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
                  onClick={() => { setNicheLevel(opt.key as 1 | 2); setSelectedNiche(null); }}
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

          {/* Two-column layout: niches list | channels in selected niche */}
          <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-4">
            {/* Niches list */}
            <div className="space-y-1">
              {!overwatch && loading && <div className="text-xs text-[#888]">Loading…</div>}
              {overwatch && (nicheLevel === 1 ? overwatch.ready_clusters.top_l1_niches : overwatch.ready_clusters.top_l2_subniches).length === 0 && (
                <div className="text-xs text-[#888] p-3 rounded-md bg-[#0f0f0f] border border-[#1f1f1f]">
                  No niches with ≥2 viable channels at this level yet.
                </div>
              )}
              {overwatch && (nicheLevel === 1 ? overwatch.ready_clusters.top_l1_niches : overwatch.ready_clusters.top_l2_subniches).map(n => {
                const isSelected = selectedNiche?.cluster_id === n.cluster_id;
                return (
                  <button
                    key={`${n.cluster_id}-${n.started_at}`}
                    type="button"
                    onClick={() => setSelectedNiche(n)}
                    className={`w-full text-left px-3 py-2 rounded-md border transition ${
                      isSelected
                        ? 'bg-amber-400/10 border-amber-400/40'
                        : 'bg-[#0f0f0f] border-[#1f1f1f] hover:border-[#333]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-white truncate">
                          {n.cluster_label || `cluster #${n.cluster_id}`}
                        </div>
                        <div className="text-[10px] text-[#666] mt-0.5 flex items-center gap-2">
                          <span>cluster {n.cluster_id}</span>
                          {n.parent_cluster_id && <span>parent L1: {n.parent_cluster_id}</span>}
                          <span>{fmtNum(n.cluster_video_count)} videos</span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end">
                        <span className={`text-sm font-bold tabular-nums ${n.viable_channel_count >= 8 ? 'text-emerald-300' : n.viable_channel_count >= 4 ? 'text-amber-300' : 'text-[#aaa]'}`}>
                          {n.viable_channel_count}
                        </span>
                        <span className="text-[9px] text-[#666] uppercase">viable</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Channels in selected niche */}
            <div className="space-y-2">
              {!selectedNiche && (
                <div className="p-6 rounded-md bg-[#0f0f0f] border border-[#1f1f1f] text-xs text-[#888] text-center">
                  Pick a niche on the left to see its viable channels.
                </div>
              )}
              {selectedNiche && (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-white">
                        {selectedNiche.cluster_label || `cluster #${selectedNiche.cluster_id}`}
                      </div>
                      <div className="text-[10px] text-[#666] mt-0.5">
                        Cluster {selectedNiche.cluster_id} ·{' '}
                        {nicheLevel === 1 ? 'L1 niche' : `L2 sub-niche${selectedNiche.parent_cluster_id ? ` (parent L1 ${selectedNiche.parent_cluster_id})` : ''}`} ·{' '}
                        {fmtNum(selectedNiche.cluster_video_count)} total videos ·{' '}
                        {selectedNiche.viable_channel_count} viable channels
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const next = new Set(selectedChannels);
                          for (const c of channelsInSelectedNiche) next.add(c.channel_id);
                          setSelectedChannels(next);
                        }}
                        className="text-[10px] px-2 py-1 rounded border border-[#2a2a2a] text-[#aaa] hover:border-amber-400 hover:text-amber-300"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const next = new Set(selectedChannels);
                          for (const c of channelsInSelectedNiche) next.delete(c.channel_id);
                          setSelectedChannels(next);
                        }}
                        className="text-[10px] px-2 py-1 rounded border border-[#2a2a2a] text-[#aaa] hover:border-red-400 hover:text-red-300"
                      >
                        Deselect
                      </button>
                    </div>
                  </div>

                  {channelsInSelectedNiche.length === 0 ? (
                    <div className="p-3 rounded-md bg-[#0f0f0f] border border-[#1f1f1f] text-xs text-[#888]">
                      No viable channels found at this niche level in the cached candidate pool. May be channels with this cluster as showcase that didn&apos;t make the top-300.
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {channelsInSelectedNiche.map(c => (
                        <ChannelRow
                          key={c.channel_id}
                          c={c}
                          selected={selectedChannels.has(c.channel_id)}
                          onToggle={() => {
                            const next = new Set(selectedChannels);
                            if (next.has(c.channel_id)) next.delete(c.channel_id);
                            else next.add(c.channel_id);
                            setSelectedChannels(next);
                          }}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
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

function ChannelRow({
  c,
  selected,
  onToggle,
}: {
  c: Candidate;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`grid grid-cols-[24px_40px_1fr_60px_60px_60px_60px_60px_80px] items-center gap-2 px-2 py-1.5 rounded text-xs border transition ${
        selected
          ? 'bg-amber-400/10 border-amber-400/40'
          : 'bg-[#0f0f0f] border-[#1f1f1f] hover:border-[#333]'
      }`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="w-3.5 h-3.5 accent-amber-400"
      />
      {c.channel_avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={c.channel_avatar} alt="" className="w-8 h-8 rounded-full object-cover" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-[#222]" />
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-white truncate font-medium">{c.channel_name || '(unnamed)'}</span>
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${ageTierColor[c.age_tier]}`}>
            {c.age_tier.replace('_', '-')}
          </span>
        </div>
        <div className="text-[10px] text-[#666] truncate" title={c.top_video_title || ''}>
          {c.top_video_title || '—'}
        </div>
      </div>
      <div className="text-right tabular-nums text-[#ccc]">{fmtNum(c.subscriber_count)}</div>
      <div className="text-right tabular-nums text-[#888]">{fmtAge(c.channel_age_days)}</div>
      <div className="text-right tabular-nums text-[#ccc]">{fmtNum(c.top_video_views)}</div>
      <div className="text-right tabular-nums text-[#aaa]">{c.views_to_subs_ratio}×</div>
      <div className="text-right tabular-nums text-[#888]">{c.videos_indexed}</div>
      <div className="text-right tabular-nums">
        <span className="text-amber-300 font-medium">{c.composite_score.toFixed(3)}</span>
      </div>
    </div>
  );
}
