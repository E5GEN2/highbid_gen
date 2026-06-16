'use client';

import { useEffect, useState } from 'react';
import type { ListicleDraft, ListicleDraftItem } from '@/lib/content-gen/assembler';

type SpyState = 'done' | 'crawling' | 'pending' | 'none';
interface DraftSpyStatus {
  draft_id: string;
  total: number;
  spied: number;
  in_progress: number;
  not_started: number;
  fully_spied: boolean;
  per_channel: Record<string, SpyState>;
}

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
  /** Thumbnail URL of the top video. */
  top_video_thumbnail?: string | null;
  /** YouTube watch URL — used to open the video in a new tab. */
  top_video_url?: string | null;
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
  const [channelsPerDraft, setChannelsPerDraft] = useState<number>(10);
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<ListicleDraft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [spyStatus, setSpyStatus] = useState<Record<string, DraftSpyStatus>>({});

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

  // Fetch drafts server-side whenever count changes. Same code path as
  // /drafts endpoint — no client duplication. Each draft is a distinct-
  // niches listicle suggestion; the niche label per item is L2 when
  // available (more representative) else L1 fallback. Quality channels
  // are picked regardless of which level their niche definition lives at.
  const loadDrafts = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setDraftsLoading(true);
    try {
      const r = await fetch(`/api/admin/content-gen/drafts?mode=mixed&n=${channelsPerDraft}&topK=300`).then(r => r.json());
      if (!r.ok) throw new Error(r.error || 'drafts failed');
      setDrafts(r.mixed_drafts || []);
      setSpyStatus(r.spy_status || {});
    } catch (e) {
      if (!opts?.silent) setError((e as Error).message);
    } finally {
      if (!opts?.silent) setDraftsLoading(false);
    }
  };

  // Silently refresh spy-completion badges while drafts are shown.
  useEffect(() => {
    if (subTab !== 'niches' || drafts.length === 0) return;
    const i = setInterval(() => loadDrafts({ silent: true }), 30000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab, drafts.length, channelsPerDraft]);

  // Mark a group "used" → its channels are excluded → a fresh group replaces it.
  const markGroupUsed = async (draft: ListicleDraft) => {
    const channelIds = draft.items.map(i => i.candidate.channel_id);
    try {
      await fetch('/api/admin/content-gen/use-group', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: draft.id, draftTitle: draft.title, channelIds }),
      });
      await loadDrafts();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    if (!active || overwatch) return;
    void loadAll();
    void loadDrafts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Re-fetch drafts when count changes (mode toggle just filters
  // client-side from the already-fetched both-mode payload).
  useEffect(() => {
    if (!active || !overwatch) return;
    void loadDrafts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsPerDraft]);

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
            <details className="rounded-lg bg-[#161616] border border-[#2a2a2a] group">
              <summary className="px-4 py-3 cursor-pointer text-sm text-[#ccc] font-medium select-none flex items-center gap-2 hover:text-white">
                <svg className="w-4 h-4 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <polyline points="9 6 15 12 9 18" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Filter funnel · pass-through per rule
              </summary>
              <div className="px-4 pb-4 pt-1 space-y-2">
                {overwatch.binding_constraint.ranked_by_killing_pct.map(r => {
                  const pct = 100 - r.killing_pct;
                  return (
                    <div key={r.rule} className="flex items-center gap-3 text-sm">
                      <div className="w-56 text-[#ccc] truncate" title={r.rule}>{r.rule}</div>
                      <div className="flex-1 h-4 bg-[#1a1a1a] rounded overflow-hidden">
                        <div
                          className={`h-full ${r.killing_pct > 70 ? 'bg-red-500/50' : r.killing_pct > 40 ? 'bg-amber-500/50' : 'bg-emerald-500/50'}`}
                          style={{ width: `${pct.toFixed(1)}%` }}
                        />
                      </div>
                      <div className="w-20 text-right tabular-nums text-white font-medium">{fmtNum(r.passing)}</div>
                      <div className="w-14 text-right tabular-nums text-[#aaa]">{pct.toFixed(1)}%</div>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {/* Controls */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <label className="text-sm text-[#aaa]">Channels per draft:</label>
              <input
                type="number"
                min={3}
                max={25}
                value={channelsPerDraft}
                onChange={(e) => {
                  const n = parseInt(e.target.value);
                  if (Number.isFinite(n)) setChannelsPerDraft(Math.max(3, Math.min(25, n)));
                }}
                className="w-16 px-2 py-1 text-sm bg-[#0a0a0a] border border-[#2a2a2a] focus:border-amber-400 focus:outline-none rounded text-white text-center font-medium"
              />
              <span className="text-xs text-[#666]">
                Each draft has distinct niches — quality channels picked from across the pool, labeled by L2 when available (else L1).
              </span>
            </div>
            {selectedChannels.size > 0 && (
              <div className="text-sm text-[#ccc] flex items-center gap-3">
                <span>
                  <span className="text-amber-300 font-semibold tabular-nums">{selectedChannels.size}</span>
                  {' '}channels picked across drafts
                </span>
                <SendToProducerButton selectedChannels={selectedChannels} />
              </div>
            )}
          </div>

          {/* Suggested-listicle cards — one card per ASSEMBLED listicle */}
          {draftsLoading && (
            <div className="text-sm text-[#aaa]">Re-assembling drafts…</div>
          )}
          {!draftsLoading && drafts.length === 0 && (
            <div className="p-6 rounded-lg bg-[#141414] border border-[#2a2a2a] text-sm text-[#bbb] text-center">
              No drafts assembled at N={channelsPerDraft}. The pool may not have enough channels across distinct niches.
            </div>
          )}
          {!draftsLoading && drafts.length > 0 && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
              {drafts.map(d => (
                <ListicleDraftCard
                  key={d.id}
                  draft={d}
                  spy={spyStatus[d.id]}
                  onMarkUsed={() => markGroupUsed(d)}
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
          )}
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
    <div className="p-4 rounded-lg bg-[#161616] border border-[#2a2a2a]">
      <div className="text-[11px] uppercase tracking-wide text-[#888] font-medium">{label}</div>
      <div className={`text-3xl font-bold mt-1 tabular-nums ${
        accent === 'amber' ? 'text-amber-300' : accent === 'emerald' ? 'text-emerald-300' : 'text-white'
      }`}>
        {value}
      </div>
      {hint && <div className="text-xs text-[#888] mt-1">{hint}</div>}
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
/**
 * One pre-assembled listicle = the unit the generator produces.
 *
 * Each draft groups channels into a "Top N [theme]" video where:
 *   - theme = the L1 niche they all sit under (e.g. "space universe moon")
 *   - items = up to 10 channels, one per distinct L2 sub-niche under
 *             that L1, picked by composite_score
 *
 * The card has plenty of breathing room: large thumbnails, readable
 * text, scale-diversity badges, generate action.
 */
/**
 * Re-import the listicle-draft types from the server-side assembler so
 * we can render server-assembled drafts in the cards below.
 */


function ListicleDraftCard({
  draft,
  spy,
  onMarkUsed,
  selectedChannels,
  onToggleChannel,
}: {
  draft: ListicleDraft;
  spy?: DraftSpyStatus;
  onMarkUsed: () => void;
  selectedChannels: Set<string>;
  onToggleChannel: (channelId: string) => void;
}) {
  const pickedCount = draft.items.filter(i => selectedChannels.has(i.candidate.channel_id)).length;
  // Mix of L1/L2 representation in this draft — useful to glance at.
  const l2Count = draft.items.filter(i => i.niche_level === 2).length;
  const l1Count = draft.items.filter(i => i.niche_level === 1).length;

  const spied = spy?.spied ?? 0;
  const inProg = spy?.in_progress ?? 0;
  const total = spy?.total ?? draft.items.length;
  const fully = spy?.fully_spied ?? false;
  const [confirming, setConfirming] = useState(false);

  return (
    <div className={`rounded-lg bg-[#161616] border overflow-hidden ${fully ? 'border-emerald-500/40' : 'border-[#2f2f2f]'}`}>
      {/* Header */}
      <div className="px-5 py-4 border-b border-[#262626] bg-gradient-to-r from-amber-500/5 to-transparent">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888] font-medium mb-1.5">
              <span className="text-amber-300/80">{draft.items.length} channels</span>
              <span>·</span>
              <span>
                {l2Count > 0 && <>{l2Count} L2</>}
                {l2Count > 0 && l1Count > 0 && ' + '}
                {l1Count > 0 && <>{l1Count} L1</>}
                {' distinct niches'}
              </span>
            </div>
            <h3 className="text-xl font-bold text-white truncate" title={draft.title}>
              {draft.title}
            </h3>
            <p className="text-sm text-[#aaa] mt-1">{draft.framing}</p>
          </div>
          <div className="flex flex-col items-end shrink-0 gap-1">
            <div className="flex items-center gap-1">
              {draft.scale_mix.small > 0 && <ScaleChip label="S" count={draft.scale_mix.small} color="emerald" />}
              {draft.scale_mix.mid > 0   && <ScaleChip label="M" count={draft.scale_mix.mid} color="amber" />}
              {draft.scale_mix.big > 0   && <ScaleChip label="L" count={draft.scale_mix.big} color="rose" />}
            </div>
            <span className="text-[10px] text-[#777] uppercase">scale mix</span>
          </div>
        </div>

        {/* Spy-prep status + mark-used */}
        <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-[#222]">
          <div className="flex items-center gap-2 text-xs">
            {fully ? (
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 font-semibold">✓ Spy-researched · ready</span>
            ) : inProg > 0 ? (
              <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 font-medium">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse mr-1 align-middle" />
                spying {spied}/{total} done · {inProg} crawling
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded-full bg-[#222] text-[#888]">{spied}/{total} spied · queued for priority crawl</span>
            )}
          </div>
          {confirming ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-[#aaa]">Mark used & replace?</span>
              <button onClick={onMarkUsed} className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-medium">Yes</button>
              <button onClick={() => setConfirming(false)} className="px-2 py-1 rounded bg-[#333] hover:bg-[#444] text-[#ccc] text-[11px]">No</button>
            </div>
          ) : (
            <button onClick={() => setConfirming(true)}
              title="Mark this group as used in a video — hides it and surfaces a fresh group"
              className="px-2.5 py-1 rounded bg-[#2a2a2a] hover:bg-[#383838] text-[#bbb] hover:text-white text-[11px] font-medium transition">
              Mark used →
            </button>
          )}
        </div>
      </div>

      {/* Items — one row per channel, numbered, big thumbnail */}
      <div className="divide-y divide-[#202020]">
        {draft.items.map((item, idx) => {
          const c = item.candidate;
          const isSel = selectedChannels.has(c.channel_id);
          const cState: SpyState = spy?.per_channel?.[c.channel_id] ?? 'none';
          const dot = cState === 'done' ? { cls: 'bg-emerald-400', t: 'spy crawl done' }
            : cState === 'crawling' ? { cls: 'bg-amber-400 animate-pulse', t: 'spy crawling now' }
            : cState === 'pending' ? { cls: 'bg-amber-400/50', t: 'spy queued' }
            : { cls: 'bg-[#444]', t: 'not yet spied' };
          return (
            <button
              key={c.channel_id}
              type="button"
              onClick={() => onToggleChannel(c.channel_id)}
              className={`w-full px-4 py-3 flex items-center gap-4 text-left transition ${
                isSel ? 'bg-amber-400/10' : 'hover:bg-[#1c1c1c]'
              }`}
            >
              {/* Index number + spy-state dot */}
              <div className={`w-8 text-center shrink-0 text-xl font-bold tabular-nums relative ${
                isSel ? 'text-amber-300' : 'text-[#666]'
              }`}>
                {idx + 1}
                <span className={`absolute -top-0.5 -right-0 w-2 h-2 rounded-full ${dot.cls}`} title={dot.t} />
              </div>
              {/* Checkbox */}
              <input
                type="checkbox"
                checked={isSel}
                onChange={() => {}}
                className="w-4 h-4 accent-amber-400 shrink-0"
              />
              {/* Top video thumbnail — clickable to open YT in new tab */}
              {c.top_video_thumbnail ? (
                c.top_video_url ? (
                  <a
                    href={c.top_video_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title="Open video on YouTube"
                    className="shrink-0 group relative"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.top_video_thumbnail}
                      alt=""
                      className="w-32 h-[72px] object-cover rounded-md bg-[#222] ring-1 ring-[#2a2a2a] group-hover:ring-amber-400 transition"
                    />
                    {/* Play overlay on hover */}
                    <div className="absolute inset-0 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/40 transition">
                      <svg className="w-7 h-7 text-white drop-shadow" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                  </a>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.top_video_thumbnail}
                    alt=""
                    className="w-32 h-[72px] object-cover rounded-md bg-[#222] shrink-0 ring-1 ring-[#2a2a2a]"
                  />
                )
              ) : (
                <div className="w-32 h-[72px] rounded-md bg-[#1a1a1a] ring-1 ring-[#2a2a2a] shrink-0 flex items-center justify-center">
                  <svg className="w-6 h-6 text-[#444]" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              )}
              {/* Channel + niche info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  {c.channel_avatar && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.channel_avatar} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
                  )}
                  {c.channel_handle ? (
                    <a
                      href={`https://www.youtube.com/${c.channel_handle.startsWith('@') ? c.channel_handle : `@${c.channel_handle}`}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title="Open channel on YouTube"
                      className="text-base text-white font-semibold truncate hover:text-amber-300 underline-offset-2 hover:underline"
                    >
                      {c.channel_name || '(unnamed)'}
                    </a>
                  ) : (
                    <span className="text-base text-white font-semibold truncate">{c.channel_name || '(unnamed)'}</span>
                  )}
                  <span className={`text-[10px] px-1.5 py-px rounded border shrink-0 ${ageTierColor[c.age_tier]}`}>
                    {c.age_tier === 'ultra_young' ? 'ultra-young' : c.age_tier.replace('_', '-')}
                  </span>
                </div>
                {c.top_video_url ? (
                  <a
                    href={c.top_video_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title="Open video on YouTube"
                    className="text-sm text-[#bbb] truncate block hover:text-amber-300 underline-offset-2 hover:underline"
                  >
                    {c.top_video_title || '—'}
                  </a>
                ) : (
                  <div className="text-sm text-[#bbb] truncate" title={c.top_video_title || ''}>
                    {c.top_video_title || '—'}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1.5 text-xs text-[#999]">
                  <span className={`px-1.5 py-px rounded text-[9px] font-bold border ${
                    item.niche_level === 2
                      ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                      : 'bg-purple-500/15 text-purple-300 border-purple-500/40'
                  }`}>
                    {item.niche_level === 2 ? 'L2' : 'L1'}
                  </span>
                  <span className="text-amber-200/90 truncate max-w-[280px]" title={item.niche_label || `cluster ${item.niche_cluster_id}`}>
                    {item.niche_label || `cluster ${item.niche_cluster_id}`}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-[#aaa] tabular-nums">
                  <span><span className="text-[#666]">subs</span> <span className="text-white">{fmtNum(c.subscriber_count)}</span></span>
                  <span><span className="text-[#666]">top</span> <span className="text-white">{fmtNum(c.top_video_views)}</span></span>
                  <span><span className="text-[#666]">ratio</span> <span className="text-emerald-300">{c.views_to_subs_ratio}×</span></span>
                  <span><span className="text-[#666]">age</span> <span className="text-white">{fmtAge(c.channel_age_days)}</span></span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-[#262626] bg-[#0e0e0e] flex items-center justify-between">
        <span className="text-xs text-[#aaa]">
          {pickedCount > 0
            ? <><span className="text-amber-300 font-semibold">{pickedCount}/{draft.items.length}</span> picked</>
            : <span className="text-[#888]">All {draft.items.length} channels in this draft</span>}
        </span>
        <button
          type="button"
          disabled
          title="Coming soon — feed this draft to the script generator"
          className="text-sm px-4 py-1.5 rounded-md border border-amber-500/40 text-amber-300 bg-amber-400/5 hover:bg-amber-400/15 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
        >
          Generate this video ▸
        </button>
      </div>
    </div>
  );
}

/** Ship picked channels to the Producer. Two modes:
 *   - "1 listicle"  → ONE merged mp4 with niche_1..N (each channel one niche)
 *   - "N renders"   → one async render per channel (independent jobs) */
function SendToProducerButton({ selectedChannels }: { selectedChannels: Set<string> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const sendListicle = async () => {
    if (selectedChannels.size === 0) return;
    setBusy(true); setMsg(null);
    const ids = Array.from(selectedChannels);
    try {
      const r = await fetch('/api/admin/content-gen/producer/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels: ids, beat_id: 'niche_segment_3', sync: false }),
      }).then(r => r.json());
      if (r.ok) setMsg(`✓ Queued listicle job #${r.job_id} (${ids.length} niches) → see Producer tab`);
      else setMsg(`✗ ${r.error ?? 'failed'}`);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const sendIndividual = async () => {
    if (selectedChannels.size === 0) return;
    setBusy(true); setMsg(null);
    const ids = Array.from(selectedChannels);
    let ok = 0; const failed: string[] = [];
    try {
      const results = await Promise.all(ids.map(channelId =>
        fetch('/api/admin/content-gen/producer/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId, beat_id: 'niche_segment_3', sync: false }),
        }).then(r => r.json()).catch(e => ({ ok: false, error: (e as Error).message }))
      ));
      for (let i = 0; i < results.length; i++) {
        if (results[i]?.ok) ok++; else failed.push(ids[i]);
      }
      setMsg(failed.length === 0
        ? `✓ Queued ${ok} separate render${ok === 1 ? '' : 's'} → see Producer tab`
        : `Queued ${ok}/${ids.length} · ${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`);
    } finally { setBusy(false); }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={sendListicle}
        disabled={busy}
        className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-medium border border-emerald-500/60"
        title="Build ONE merged mp4 with niche_1..N (each picked channel becomes one niche segment). The producer runs the writer per channel + concatenates."
      >
        {busy ? 'Queuing…' : `Render 1 listicle (${selectedChannels.size} niches)`}
      </button>
      <button
        onClick={sendIndividual}
        disabled={busy}
        className="px-3 py-1 rounded border border-[#2a2a2a] hover:border-[#444] text-[#bbb] text-xs"
        title="One async render per picked channel — produces N separate mp4s."
      >
        or {selectedChannels.size} individual renders
      </button>
      {msg && <span className="text-[11px] text-[#888]">{msg}</span>}
    </span>
  );
}

function ScaleChip({ label, count, color }: { label: string; count: number; color: 'emerald' | 'amber' | 'rose' }) {
  const cls = color === 'emerald'
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
    : color === 'amber'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
      : 'bg-rose-500/15 text-rose-300 border-rose-500/40';
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border tabular-nums ${cls}`}>
      {label}·{count}
    </span>
  );
}

