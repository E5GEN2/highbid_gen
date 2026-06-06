'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Admin → Audio Gen tab.
 *
 * The Stage-D.3 audio surface — talks to /api/admin/content-gen/audio,
 * /voice/file, /sfx/file, /audio/file. Three panels:
 *
 *   1. SFX vocabulary — every token in the TOKENS registry. Shows whether
 *      it's cached, plus an inline <audio> for instant audition. One-click
 *      "Warm all" pre-generates anything missing.
 *
 *   2. Voice library — every cached TTS phrase (text, voice, duration,
 *      playback). Lets the operator A/B voices by ear before re-running
 *      a whole group.
 *
 *   3. Group beds — every script-group's voice-lock + bed state. Single
 *      "Compose bed" button runs the full pipeline (auto voice-reflow if
 *      needed → SFX warm → ffmpeg mix). Listen straight to the bed.
 *
 * Wires straight to existing endpoints — no new infra.
 */

interface TokenRow {
  token: string;
  kind: 'sfx' | 'music';
  prompt: string;
  default_duration_s: number;
  cached: boolean;
  duration_s: number | null;
  bytes: number | null;
  last_used_at: string | null;
  file_url: string | null;
}
interface VoiceRow {
  text_hash: string; text: string; voice_id: string; model_id: string;
  duration_s: number; bytes: number; char_count: number;
  created_at: string; last_used_at: string; file_url: string;
}
interface GroupRow {
  group_key: string;
  title: string | null;
  channels: Array<{ channel_id: string; name: string }>;
  est_duration_s: number | null;
  word_count: number | null;
  voice_locked: boolean;
  updated_at: string;
}

function fmtBytes(n: number | null): string {
  if (!n) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}B`;
}
function fmtDuration(s: number | null): string {
  if (s == null) return '—';
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

export default function AudioGenTab({ active }: { active: boolean }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [voices, setVoices] = useState<VoiceRow[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [warming, setWarming] = useState(false);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  const [bedByGroup, setBedByGroup] = useState<Record<string, { url: string; duration_s: number; segs_voice: number; segs_sfx: number; cached: boolean }>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/content-gen/audio?voiceLimit=80').then(r => r.json());
      if (r.ok) { setTokens(r.tokens || []); setVoices(r.voices || []); setGroups(r.groups || []); }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (active) refresh(); }, [active, refresh]);

  const warmAll = async () => {
    setWarming(true); setMsg(null);
    try {
      const r = await fetch('/api/admin/content-gen/audio?action=warm').then(r => r.json());
      if (r.ok) setMsg(`Warmed ${r.ok}/${r.ok + r.failed} tokens`);
      else setMsg(r.error || 'warm failed');
      refresh();
    } catch (e) { setMsg((e as Error).message); } finally { setWarming(false); }
  };

  const composeBed = async (g: GroupRow) => {
    setBusyGroup(g.group_key); setMsg(null);
    try {
      const r = await fetch('/api/admin/content-gen/audio', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelIds: g.channels.map(c => c.channel_id), voiceFirst: true, warm: !tokens.every(t => t.cached) }),
      }).then(r => r.json());
      if (r.ok && r.bed) {
        setBedByGroup(prev => ({ ...prev, [g.group_key]: { url: r.bed.audio_url, duration_s: r.bed.duration_s, segs_voice: r.bed.segments_voiced, segs_sfx: r.bed.segments_with_sfx, cached: r.bed.cached } }));
        setMsg(`Composed ${fmtDuration(r.bed.duration_s)} bed${r.bed.cached ? ' (cached)' : ''} for ${g.channels.length} channels`);
        refresh();
      } else setMsg(r.error || 'compose failed');
    } catch (e) { setMsg((e as Error).message); } finally { setBusyGroup(null); }
  };

  // Counts for the top bar
  const tokenStats = {
    cached: tokens.filter(t => t.cached).length,
    total: tokens.length,
    missing: tokens.filter(t => !t.cached).length,
  };

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-6 text-[#ddd]">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-white">Audio Gen</h2>
        <p className="text-xs text-[#888] mt-1">
          Drives the voice + SFX + audio-bed pipeline. Narration via ElevenLabs TTS, SFX/music via 11labs sound-generation, mixed
          to a single MP3 per group via ffmpeg. All assets cached on the volume — re-runs are instant.
        </p>
      </div>

      {msg && <div className="mb-4 text-xs text-[#bbb] bg-[#101010] border border-[#222] rounded px-3 py-2">{msg}</div>}

      {/* ── PANEL 1 — SFX VOCABULARY ── */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">SFX & music vocabulary</h3>
            <p className="text-[11px] text-[#777] mt-0.5">14 tokens emitted by the timeline compiler · generated by ElevenLabs /v1/sound-generation</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-1 rounded border border-green-500/25 bg-green-500/10 text-green-300">cached {tokenStats.cached}/{tokenStats.total}</span>
            {tokenStats.missing > 0 && <span className="px-2 py-1 rounded border border-amber-500/25 bg-amber-500/10 text-amber-300">missing {tokenStats.missing}</span>}
            <button onClick={warmAll} disabled={warming} className="px-3 py-1 rounded border border-lime-600/40 text-lime-300 hover:border-lime-500 disabled:opacity-50">
              {warming ? 'Warming…' : 'Warm all'}
            </button>
            <button onClick={refresh} disabled={loading} className="px-3 py-1 rounded border border-[#2a2a2a] hover:border-[#444] text-[#aaa] disabled:opacity-50">
              {loading ? 'Refresh…' : 'Refresh'}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {tokens.map(t => (
            <div key={t.token} className={`rounded-lg border p-3 flex flex-col gap-2 ${t.cached ? 'border-[#1f1f1f] bg-[#101010]' : 'border-amber-500/30 bg-amber-500/[0.03]'}`}>
              <div className="flex items-center gap-1.5">
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.kind === 'music' ? 'border-purple-500/30 bg-purple-500/10 text-purple-300' : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'}`}>{t.kind}</span>
                <span className="text-xs font-mono text-white truncate">{t.token}</span>
                {t.cached
                  ? <span className="ml-auto text-[10px] text-[#666]">{fmtDuration(t.duration_s)} · {fmtBytes(t.bytes)}</span>
                  : <span className="ml-auto text-[10px] text-amber-400">missing</span>}
              </div>
              <p className="text-[11px] text-[#888] line-clamp-2" title={t.prompt}>{t.prompt}</p>
              {t.cached && t.file_url
                ? <audio src={t.file_url} controls preload="none" className="w-full h-7" />
                : <div className="h-7 text-[10px] text-[#555] italic flex items-center">click &quot;Warm all&quot; to generate</div>}
            </div>
          ))}
        </div>
      </section>

      {/* ── PANEL 2 — VOICE LIBRARY ── */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Voice library <span className="text-[11px] text-[#666] font-normal">({voices.length})</span></h3>
            <p className="text-[11px] text-[#777] mt-0.5">Every cached TTS phrase · default voice: Daniel (steady broadcaster) · model: eleven_multilingual_v2</p>
          </div>
        </div>
        {voices.length === 0
          ? <div className="text-center text-[#666] text-sm py-10 border border-dashed border-[#222] rounded-lg">No voice assets yet. Run /api/admin/content-gen/voice to generate.</div>
          : (
            <div className="space-y-1.5">
              {voices.map(v => (
                <div key={v.text_hash} className="rounded border border-[#1f1f1f] bg-[#101010] px-3 py-2 flex items-center gap-3">
                  <span className="text-[10px] text-[#666] font-mono w-12 shrink-0">{v.duration_s.toFixed(1)}s</span>
                  <p className="text-xs text-[#ddd] flex-1 truncate" title={v.text}>{v.text}</p>
                  <span className="text-[10px] text-[#666] shrink-0">{v.char_count} chars</span>
                  <audio src={v.file_url} controls preload="none" className="w-64 h-7 shrink-0" />
                </div>
              ))}
            </div>
          )}
      </section>

      {/* ── PANEL 3 — GROUP BEDS ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Group beds <span className="text-[11px] text-[#666] font-normal">({groups.length})</span></h3>
            <p className="text-[11px] text-[#777] mt-0.5">Compose narration + ducked music bed + per-segment SFX into one MP3 per script group</p>
          </div>
        </div>
        {groups.length === 0
          ? <div className="text-center text-[#666] text-sm py-10 border border-dashed border-[#222] rounded-lg">No script groups yet. Generate a timeline first via Content Gen.</div>
          : (
            <div className="space-y-2">
              {groups.map(g => {
                const bed = bedByGroup[g.group_key];
                const busy = busyGroup === g.group_key;
                return (
                  <div key={g.group_key} className="rounded-lg border border-[#1f1f1f] bg-[#101010] p-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-white truncate">{g.title || '(untitled)'}</span>
                          {g.voice_locked
                            ? <span className="text-[10px] px-1.5 py-0.5 rounded border border-green-500/30 bg-green-500/10 text-green-300">voice-locked</span>
                            : <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300">needs voice-reflow</span>}
                        </div>
                        <p className="text-[11px] text-[#888] truncate">{g.channels.map(c => c.name).join(' · ')}</p>
                        <p className="text-[10px] text-[#666] mt-0.5">{g.word_count ?? '?'} words · est {fmtDuration(g.est_duration_s)} · updated {new Date(g.updated_at).toLocaleString()}</p>
                      </div>
                      <button onClick={() => composeBed(g)} disabled={busy}
                        className="text-xs px-3 py-1.5 rounded border border-lime-600/40 text-lime-300 hover:border-lime-500 disabled:opacity-50 shrink-0">
                        {busy ? 'Composing…' : bed ? 'Re-compose' : 'Compose bed'}
                      </button>
                    </div>
                    {bed && (
                      <div className="mt-3 flex items-center gap-3">
                        <span className="text-[10px] text-[#888] shrink-0">
                          {fmtDuration(bed.duration_s)} · {bed.segs_voice} voiced · {bed.segs_sfx} sfx{bed.cached ? ' · cached' : ''}
                        </span>
                        <audio src={bed.url} controls preload="none" className="flex-1 h-8 max-w-2xl" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </section>
    </div>
  );
}
