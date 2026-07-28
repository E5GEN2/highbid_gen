'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

// Per-channel Growth page — the catch story + subs-over-time curve + per-video
// view trajectories, read from /api/niche-spy/channel-growth. See
// docs/growth-watcher/spec.md. Hand-rolled SVG (no chart lib in repo).

interface Snapshot { day: string; subscribers: number | null; totalViews: number | null; videoCount: number | null; source: string }
interface VideoSeries { videoId: number; title: string | null; url: string | null; maxViews: number; series: Array<{ day: string; views: number }> }
interface GrowthData {
  channelId: string;
  channel: { name: string; handle: string; avatar: string; subscribers: number | null; videoCount: number; createdAt: string | null } | null;
  tracked: { stage: string; caughtSubs: number | null; caughtAt: string | null; currentSubs: number | null; subsGained: number | null; multiple: number | null; growthScore: number; showedLife: boolean; upDays: number; lastScannedAt: string | null } | null;
  snapshots: Snapshot[];
  videos: VideoSeries[];
}

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
  return String(n);
}
function fmtDay(d: string): string {
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return d; }
}

const STAGE_COLOR: Record<string, string> = {
  liveness: 'text-[#888] bg-[#1f1f1f]', pulse: 'text-sky-300 bg-sky-500/10',
  traction: 'text-emerald-300 bg-emerald-500/10', documented: 'text-amber-300 bg-amber-500/10',
  dormant: 'text-[#666] bg-[#161616]',
};

/** Single-series line+area SVG chart. Handles 1..N points. */
function LineChart({ points, color = '#38bdf8', height = 220 }: { points: Array<{ x: string; y: number | null }>; color?: string; height?: number }) {
  const valid = points.filter((p): p is { x: string; y: number } => p.y != null);
  if (valid.length === 0) return <div className="text-[#555] text-sm py-8 text-center">No data yet — snapshots accrue daily.</div>;
  const W = 720, H = height, padL = 52, padR = 16, padT = 16, padB = 28;
  const ys = valid.map(p => p.y);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const yLo = yMin === yMax ? yMin * 0.9 : yMin, yHi = yMin === yMax ? yMax * 1.1 + 1 : yMax;
  const xOf = (i: number) => padL + (valid.length === 1 ? (W - padL - padR) / 2 : (i / (valid.length - 1)) * (W - padL - padR));
  const yOf = (v: number) => padT + (1 - (v - yLo) / (yHi - yLo || 1)) * (H - padT - padB);
  const line = valid.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p.y).toFixed(1)}`).join(' ');
  const area = `${line} L${xOf(valid.length - 1).toFixed(1)},${(H - padB).toFixed(1)} L${xOf(0).toFixed(1)},${(H - padB).toFixed(1)} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: H }}>
      <defs><linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity="0.28" /><stop offset="100%" stopColor={color} stopOpacity="0" />
      </linearGradient></defs>
      {[0, 0.5, 1].map(f => { const v = yLo + f * (yHi - yLo); const y = yOf(v);
        return <g key={f}><line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#1f1f1f" /><text x={padL - 8} y={y + 4} textAnchor="end" className="fill-[#666]" fontSize="11">{fmt(Math.round(v))}</text></g>; })}
      <path d={area} fill="url(#gArea)" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" />
      {valid.map((p, i) => <circle key={i} cx={xOf(i)} cy={yOf(p.y)} r={valid.length > 40 ? 0 : 3} fill={color} />)}
      <text x={padL} y={H - 8} className="fill-[#666]" fontSize="11">{fmtDay(valid[0].x)}</text>
      {valid.length > 1 && <text x={W - padR} y={H - 8} textAnchor="end" className="fill-[#666]" fontSize="11">{fmtDay(valid[valid.length - 1].x)}</text>}
    </svg>
  );
}

/** Tiny inline sparkline for a video's view trajectory. */
function Spark({ series }: { series: Array<{ day: string; views: number }> }) {
  if (series.length === 0) return null;
  const W = 120, H = 28, ys = series.map(s => s.views);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const xOf = (i: number) => series.length === 1 ? W / 2 : (i / (series.length - 1)) * W;
  const yOf = (v: number) => 2 + (1 - (v - lo) / (hi - lo || 1)) * (H - 4);
  const d = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(s.views).toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${W} ${H}`} className="w-[120px] h-7 flex-shrink-0"><path d={d} fill="none" stroke="#34d399" strokeWidth="1.5" />{series.length === 1 && <circle cx={W / 2} cy={yOf(series[0].views)} r={2} fill="#34d399" />}</svg>;
}

// ── Event timeline (upload events + per-video view deltas + sub deltas) ──
interface TlEvent { at: string; kind: 'upload' | 'discovered' | 'subs' | 'views'; videoId?: number; title?: string | null; isShort?: boolean | null; value?: number | null; delta?: number | null; note?: string }
interface TimelineData { events: TlEvent[]; coverage: { videosInCorpus: number; videosWithViewPulse: number; daysTracked: number } }

function EventTimeline({ channelId }: { channelId: string }) {
  const [tl, setTl] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch(`/api/niche-spy/channel-timeline?channelId=${encodeURIComponent(channelId)}`)
      .then(r => r.json()).then(d => { if (alive) setTl(d); })
      .catch(() => {}).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [channelId]);

  if (loading) return <div className="text-[#666] text-sm">Loading timeline…</div>;
  if (!tl?.events?.length) return <div className="text-[#666] text-sm">No events recorded yet.</div>;

  // group by day, newest day first
  const byDay = new Map<string, TlEvent[]>();
  for (const e of tl.events) { const a = byDay.get(e.at) ?? []; a.push(e); byDay.set(e.at, a); }
  const days = [...byDay.keys()].sort().reverse();

  return (
    <div>
      <div className="text-xs text-[#666] mb-3">
        {tl.coverage.daysTracked} days · {tl.coverage.videosWithViewPulse}/{tl.coverage.videosInCorpus} videos with view-pulse
      </div>
      <div className="space-y-3">
        {days.map(day => {
          const evs = byDay.get(day)!;
          const subEv = evs.find(e => e.kind === 'subs');
          return (
            <div key={day} className="border-l-2 border-[#222] pl-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[13px] text-[#ddd] font-medium">{fmtDay(day)}</span>
                {subEv && (
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${(subEv.delta ?? 0) > 0 ? 'text-emerald-300 bg-emerald-500/10' : 'text-red-300 bg-red-500/10'}`}>
                    subs {(subEv.delta ?? 0) > 0 ? '+' : ''}{subEv.delta} → {fmt(subEv.value)}
                  </span>
                )}
              </div>
              <div className="space-y-0.5">
                {evs.filter(e => e.kind === 'upload' || e.kind === 'discovered').map((e, i) => (
                  <div key={`u${i}`} className="text-[12px] text-sky-300/90 flex items-start gap-1.5">
                    <span>📤</span>
                    <span className="truncate">
                      {e.videoId ? <>posted: <span className="text-[#ccc]">{e.title || `video ${e.videoId}`}</span>
                        {e.isShort != null && <span className="text-[#666] ml-1">[{e.isShort ? 'short' : 'long'}]</span>}</>
                        : <span className="text-[#888]">{e.note}</span>}
                    </span>
                  </div>
                ))}
                {evs.filter(e => e.kind === 'views').sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0)).slice(0, 6).map((e, i) => (
                  <div key={`v${i}`} className="text-[12px] text-[#aaa] flex items-start gap-1.5">
                    <span className="text-emerald-400/70">▲</span>
                    <span className="truncate">
                      <span className="text-emerald-300">+{fmt(e.delta)}</span> views
                      <span className="text-[#666]"> → {fmt(e.value)}</span>
                      <span className="text-[#888] ml-1.5">{e.title || `video ${e.videoId}`}</span>
                      {e.isShort != null && <span className="text-[#555] ml-1">[{e.isShort ? 'short' : 'long'}]</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ChannelGrowthPage() {
  const params = useParams();
  const channelId = params.channelId as string;
  const [data, setData] = useState<GrowthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/niche-spy/channel-growth?channelId=${encodeURIComponent(channelId)}`)
      .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j.error || r.statusText)))
      .then(d => { if (alive) { setData(d); setErr(null); } })
      .catch(e => { if (alive) setErr(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [channelId]);

  if (loading) return <div className="p-8 text-[#888]">Loading growth history…</div>;
  if (err) return <div className="p-8 text-red-400">Couldn&apos;t load: {err}</div>;
  if (!data) return null;

  const t = data.tracked;
  const ch = data.channel;
  const ytUrl = ch?.handle ? `https://www.youtube.com/${ch.handle.startsWith('@') ? '' : '@'}${ch.handle}` : `https://www.youtube.com/channel/${channelId}`;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Catch story header */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-5">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 rounded-full bg-[#1f1f1f] overflow-hidden flex-shrink-0">
            {ch?.avatar ? <img src={ch.avatar} alt="" className="w-full h-full object-cover" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <a href={ytUrl} target="_blank" rel="noopener noreferrer" className="text-xl font-semibold text-white hover:text-red-400 transition truncate">{ch?.name || channelId}</a>
              {t && <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STAGE_COLOR[t.stage] || STAGE_COLOR.liveness}`}>{t.stage}</span>}
            </div>
            {t && t.caughtSubs != null && (
              <div className="mt-2 text-[15px] text-[#ccc]">
                Caught at <span className="text-white font-semibold">{fmt(t.caughtSubs)}</span> subs
                {t.caughtAt && <span className="text-[#777]"> on {fmtDay(t.caughtAt)}</span>}
                <span className="text-[#555]"> → </span>
                now <span className="text-emerald-300 font-semibold">{fmt(t.currentSubs)}</span>
                {t.multiple != null && t.multiple >= 1.1 && <span className="ml-2 text-emerald-400 font-semibold">{t.multiple}×</span>}
                {t.subsGained != null && t.subsGained > 0 && <span className="ml-2 text-[#888]">(+{fmt(t.subsGained)})</span>}
              </div>
            )}
            <div className="mt-1 text-xs text-[#777] flex gap-3 flex-wrap">
              <span>{fmt(ch?.videoCount)} videos</span>
              {t && <span>{t.upDays} up-days</span>}
              {t?.lastScannedAt && <span>updated {fmtDay(t.lastScannedAt)}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Subscriber curve */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-5">
        <div className="text-sm font-medium text-[#ccc] mb-3">Subscribers over time <span className="text-[#666]">· {data.snapshots.length} day{data.snapshots.length === 1 ? '' : 's'}</span></div>
        <LineChart points={data.snapshots.map(s => ({ x: s.day, y: s.subscribers }))} />
      </div>

      {/* Event timeline — uploads + view deltas + sub deltas on one clock */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-5">
        <div className="text-sm font-medium text-[#ccc] mb-3">Event timeline <span className="text-[#666]">· uploads, view gains, sub moves</span></div>
        <EventTimeline channelId={channelId} />
      </div>

      {/* Video trajectories */}
      {data.videos.length > 0 ? (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-5">
          <div className="text-sm font-medium text-[#ccc] mb-3">Top videos — view trajectories <span className="text-[#666]">· deep-tracked</span></div>
          <div className="space-y-2">
            {data.videos.map(v => (
              <div key={v.videoId} className="flex items-center gap-3 py-1.5 border-b border-[#181818] last:border-0">
                <div className="min-w-0 flex-1">
                  <a href={v.url || '#'} target="_blank" rel="noopener noreferrer" className="text-sm text-[#ddd] hover:text-red-400 transition truncate block">{v.title || `video ${v.videoId}`}</a>
                </div>
                <Spark series={v.series} />
                <div className="text-sm text-white font-medium w-16 text-right">{fmt(v.maxViews)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-5 text-sm text-[#666]">
          Per-video trajectories appear once this channel reaches the <span className="text-emerald-400">traction</span> tier (sustained 7-day growth).
        </div>
      )}
    </div>
  );
}
