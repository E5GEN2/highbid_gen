'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';

interface ChannelEntry {
  id: string;
  channel_id: string;
  channel_name: string;
  channel_url: string;
  priority: number;
  interest_score: number;
  triage_reason: string;
  what_to_look_for: string;
  synthesis: Record<string, unknown> | null;
  post_tweet: string | null;
  post_hook_category: string | null;
  status: string;
  error: string | null;
  storyboards?: Array<{
    id: string;
    video_id: string;
    video_title: string;
    view_count: number;
    storyboard: Record<string, unknown>;
    status: string;
  }>;
  post?: { tweet: string; hook_category: string } | null;
}

interface Run {
  id: string;
  status: string;
  channel_count: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  channels: Array<{ id: string; channel_name: string; status: string; post_tweet: string | null }>;
}

const STEPS = ['triage', 'storyboarding', 'synthesizing', 'post_gen', 'done'];
const STEP_LABELS: Record<string, string> = {
  triage: 'Triage',
  storyboarding: 'Storyboards',
  synthesizing: 'Synthesis',
  post_gen: 'Posts',
  done: 'Done',
};

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function duration(start: string, end: string | null): string {
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const secs = Math.floor((e - s) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-gray-700 text-gray-300',
    triage: 'bg-yellow-900/50 text-yellow-400',
    storyboarding: 'bg-blue-900/50 text-blue-400',
    synthesizing: 'bg-purple-900/50 text-purple-400',
    post_gen: 'bg-cyan-900/50 text-cyan-400',
    done: 'bg-green-900/50 text-green-400',
    error: 'bg-red-900/50 text-red-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || colors.pending}`}>
      {status}
    </span>
  );
}

export default function DeepAnalysisPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<{ run: Run; channels: ChannelEntry[] } | null>(null);
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());
  const [expandedStoryboards, setExpandedStoryboards] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Filters
  const today = new Date().toISOString().split('T')[0];
  const [filterDate, setFilterDate] = useState(today);
  const [filterMaxAge, setFilterMaxAge] = useState(90);
  const [filterMinSubs, setFilterMinSubs] = useState(10000);
  const [filterMaxSubs, setFilterMaxSubs] = useState(0);
  const [filterLanguage, setFilterLanguage] = useState('en');
  const [filterTriageCount, setFilterTriageCount] = useState(30);
  const [filterPickCount, setFilterPickCount] = useState(8);

  // Auth check
  useEffect(() => {
    fetch('/api/admin/auth')
      .then((res) => res.json())
      .then((data) => { if (data.authenticated) setAuthenticated(true); })
      .finally(() => setChecking(false));
  }, []);

  // Fetch runs list
  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/deep-analysis');
      const data = await res.json();
      if (data.runs) setRuns(data.runs);
    } catch {}
  }, []);

  useEffect(() => {
    if (authenticated) fetchRuns();
  }, [authenticated, fetchRuns]);

  // Poll active run status
  const startPolling = useCallback((runId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    setActiveRunId(runId);
    setExpandedRunId(runId);

    const poll = async () => {
      try {
        const res = await fetch(`/api/admin/deep-analysis/${runId}`);
        const data = await res.json();
        if (data.run) {
          setRunDetail(data);
          // Also refresh the runs list
          fetchRuns();
          // Stop polling when done or errored
          if (data.run.status === 'done' || data.run.status === 'error') {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setActiveRunId(null);
            if (data.run.status === 'error' && data.run.error) {
              setRunError(data.run.error);
            }
          }
        }
      } catch {}
    };

    // Poll immediately, then every 3s
    poll();
    pollRef.current = setInterval(poll, 3000);
  }, [fetchRuns]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // On initial load, auto-poll any active run
  useEffect(() => {
    if (!authenticated || runs.length === 0) return;
    const active = runs.find((r) => !['done', 'error'].includes(r.status));
    if (active && !activeRunId) {
      startPolling(active.id);
    }
  }, [authenticated, runs, activeRunId, startPolling]);

  // Fetch run detail (for expanding completed runs)
  const fetchRunDetail = async (runId: string) => {
    try {
      const res = await fetch(`/api/admin/deep-analysis/${runId}`);
      const data = await res.json();
      if (data.run) setRunDetail(data);
    } catch {}
  };

  const handleExpand = (runId: string) => {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
      setRunDetail(null);
    } else {
      setExpandedRunId(runId);
      fetchRunDetail(runId);
    }
  };

  const toggleChannel = (id: string) => {
    setExpandedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleStoryboard = (id: string) => {
    setExpandedStoryboards((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  // Cancel a run
  const handleCancel = async (runId: string) => {
    try {
      await fetch('/api/admin/deep-analysis', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, action: 'cancel' }),
      });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      setActiveRunId(null);
      fetchRuns();
    } catch {}
  };

  // Retry/resume a run
  const handleRetry = async (runId: string) => {
    setRunError(null);
    try {
      await fetch('/api/admin/deep-analysis', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, action: 'retry' }),
      });
      startPolling(runId);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Retry failed');
    }
  };

  // Start new run
  const handleStartRun = async () => {
    setRunError(null);
    try {
      const res = await fetch('/api/admin/deep-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filters: {
            date: filterDate,
            maxAgeDays: filterMaxAge,
            minSubs: filterMinSubs,
            maxSubs: filterMaxSubs,
            language: filterLanguage,
            triageCount: filterTriageCount,
            pickCount: filterPickCount,
          },
        }),
      });

      const data = await res.json();
      if (data.error) {
        setRunError(data.error);
        return;
      }

      if (data.runId) {
        startPolling(data.runId);
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to start run');
    }
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400">
          Not authenticated. <a href="/admin" className="text-cyan-400 underline">Log in</a>
        </div>
      </div>
    );
  }

  // Derive step indicator from the active run's DB status
  const activeRun = runs.find((r) => r.id === activeRunId);
  const activeStep = activeRun?.status || '';
  const activeStepIndex = STEPS.indexOf(activeStep);

  // Build a progress summary from run detail channels
  const activeChannels = runDetail && activeRunId === expandedRunId ? runDetail.channels : [];
  const doneChannels = activeChannels.filter((c) => c.status === 'done').length;
  const currentChannel = activeChannels.find((c) => !['done', 'error', 'pending'].includes(c.status));

  return (
    <div className="min-h-screen bg-gray-950">
      <div className="max-w-5xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Deep Analysis</h1>
            <p className="text-gray-400 text-sm">AI pipeline: triage &rarr; storyboard &rarr; synthesis &rarr; post generation</p>
          </div>
          <a href="/admin" className="px-4 py-2 bg-gray-800 text-gray-300 rounded-xl hover:bg-gray-700 transition text-sm">
            Back to Admin
          </a>
        </div>

        {/* Start Button + Filters + Live Progress */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white">Run Pipeline</h2>
            <button
              onClick={handleStartRun}
              disabled={!!activeRunId}
              className="px-6 py-3 bg-cyan-600 text-white font-semibold rounded-xl hover:bg-cyan-700 disabled:opacity-50 transition flex items-center gap-3"
            >
              {activeRunId ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Running...
                </>
              ) : (
                'Start New Run'
              )}
            </button>
          </div>

          {/* Filters */}
          {!activeRunId && (
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Date (first seen)</label>
                <input
                  type="date"
                  value={filterDate}
                  onChange={(e) => setFilterDate(e.target.value)}
                  className="w-full px-2.5 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Max age (days)</label>
                <input
                  type="number"
                  min={0}
                  value={filterMaxAge}
                  onChange={(e) => setFilterMaxAge(parseInt(e.target.value) || 0)}
                  className="w-full px-2.5 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Min subs</label>
                <input
                  type="number"
                  min={0}
                  value={filterMinSubs}
                  onChange={(e) => setFilterMinSubs(parseInt(e.target.value) || 0)}
                  className="w-full px-2.5 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Max subs (0=no max)</label>
                <input
                  type="number"
                  min={0}
                  value={filterMaxSubs}
                  onChange={(e) => setFilterMaxSubs(parseInt(e.target.value) || 0)}
                  className="w-full px-2.5 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Language (empty=all)</label>
                <input
                  type="text"
                  value={filterLanguage}
                  onChange={(e) => setFilterLanguage(e.target.value.trim())}
                  placeholder="en"
                  className="w-full px-2.5 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Triage pool</label>
                <input
                  type="number"
                  min={5}
                  max={100}
                  value={filterTriageCount}
                  onChange={(e) => setFilterTriageCount(parseInt(e.target.value) || 30)}
                  className="w-full px-2.5 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Pick count</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={filterPickCount}
                  onChange={(e) => setFilterPickCount(parseInt(e.target.value) || 8)}
                  className="w-full px-2.5 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
            </div>
          )}

          {/* Step Indicator (polling-based) */}
          {activeRunId && activeStep && (
            <div className="space-y-4">
              {/* Steps bar */}
              <div className="flex items-center gap-1">
                {STEPS.filter((s) => s !== 'done').map((step, i) => {
                  const stepIdx = STEPS.indexOf(step);
                  const isActive = stepIdx === activeStepIndex;
                  const isDone = stepIdx < activeStepIndex || activeStep === 'done';
                  return (
                    <React.Fragment key={step}>
                      {i > 0 && (
                        <div className={`flex-1 h-0.5 ${isDone ? 'bg-cyan-500' : 'bg-gray-700'}`} />
                      )}
                      <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        isActive ? 'bg-cyan-900/50 text-cyan-400 ring-1 ring-cyan-500/50' :
                        isDone ? 'bg-cyan-900/30 text-cyan-500' :
                        'bg-gray-800 text-gray-500'
                      }`}>
                        {isDone && (
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                        {isActive && <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />}
                        {STEP_LABELS[step]}
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>

              {/* Current action summary */}
              <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-4">
                <div className="text-sm text-gray-300 mb-2">
                  {currentChannel
                    ? `Processing ${currentChannel.channel_name} (${currentChannel.status})`
                    : activeStep === 'triage'
                    ? 'Running triage...'
                    : `${doneChannels}/${activeChannels.length} channels complete`
                  }
                </div>
                {activeChannels.length > 0 && (
                  <>
                    <div className="w-full bg-gray-700 rounded-full h-2">
                      <div
                        className="bg-gradient-to-r from-cyan-500 to-teal-500 h-full rounded-full transition-all duration-300"
                        style={{ width: `${Math.round((doneChannels / activeChannels.length) * 100)}%` }}
                      />
                    </div>
                    <div className="text-xs text-gray-500 mt-1.5">
                      {doneChannels} / {activeChannels.length}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {runError && (
            <div className="bg-red-900/20 border border-red-600/30 rounded-xl p-4 mt-4">
              <div className="text-red-400 font-medium mb-1">Run failed</div>
              <div className="text-sm text-red-300/70">{runError}</div>
            </div>
          )}
        </div>

        {/* Run History */}
        <div className="space-y-3">
          <h2 className="text-lg font-bold text-white mb-3">Run History</h2>

          {runs.length === 0 && (
            <div className="text-gray-500 text-sm py-8 text-center">No runs yet. Start a new one above.</div>
          )}

          {runs.map((run) => (
            <div key={run.id} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
              {/* Run header */}
              <button
                onClick={() => handleExpand(run.id)}
                className="w-full p-5 flex items-center justify-between hover:bg-gray-800/50 transition text-left"
              >
                <div className="flex items-center gap-4">
                  <StatusBadge status={run.status} />
                  <div>
                    <div className="text-white text-sm font-medium">
                      {run.channel_count} channel{run.channel_count !== 1 ? 's' : ''}
                    </div>
                    <div className="text-xs text-gray-500">
                      {timeAgo(new Date(run.started_at))} &middot; {duration(run.started_at, run.completed_at)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {/* Cancel / Retry buttons */}
                  {run.status !== 'done' && (
                    <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                      {run.status !== 'error' && (
                        <button
                          onClick={() => handleCancel(run.id)}
                          className="px-2.5 py-1 bg-red-900/40 text-red-400 border border-red-800/50 rounded-lg text-xs hover:bg-red-900/60 transition"
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        onClick={() => handleRetry(run.id)}
                        className="px-2.5 py-1 bg-cyan-900/40 text-cyan-400 border border-cyan-800/50 rounded-lg text-xs hover:bg-cyan-900/60 transition"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {/* Channel names preview */}
                  <div className="hidden sm:flex gap-1.5">
                    {run.channels.slice(0, 3).map((ch) => (
                      <span key={ch.id} className="px-2 py-0.5 bg-gray-800 rounded text-xs text-gray-400">
                        {ch.channel_name}
                      </span>
                    ))}
                    {run.channels.length > 3 && (
                      <span className="px-2 py-0.5 bg-gray-800 rounded text-xs text-gray-500">
                        +{run.channels.length - 3}
                      </span>
                    )}
                  </div>
                  <svg
                    className={`w-5 h-5 text-gray-500 transition-transform ${expandedRunId === run.id ? 'rotate-180' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>

              {/* Run Detail (expanded) */}
              {expandedRunId === run.id && runDetail && (
                <div className="border-t border-gray-800 p-5 space-y-4">
                  {run.error && (
                    <div className="bg-red-900/20 border border-red-600/30 rounded-xl p-3 text-sm text-red-300">
                      {run.error}
                    </div>
                  )}

                  {runDetail.channels.map((ch) => (
                    <div key={ch.id} className="bg-gray-800/50 border border-gray-700/50 rounded-xl overflow-hidden">
                      {/* Channel header */}
                      <button
                        onClick={() => toggleChannel(ch.id)}
                        className="w-full p-4 flex items-center justify-between hover:bg-gray-800/80 transition text-left"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 bg-cyan-600/20 rounded-lg flex items-center justify-center text-cyan-400 font-bold text-sm">
                            {ch.priority}
                          </div>
                          <div>
                            <div className="text-white text-sm font-medium">{ch.channel_name}</div>
                            <div className="text-xs text-gray-500">
                              Score: {ch.interest_score} &middot; <StatusBadge status={ch.status} />
                            </div>
                          </div>
                        </div>
                        <svg
                          className={`w-4 h-4 text-gray-500 transition-transform ${expandedChannels.has(ch.id) ? 'rotate-180' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>

                      {expandedChannels.has(ch.id) && (
                        <div className="border-t border-gray-700/50 p-4 space-y-4">
                          {/* Triage info */}
                          <div>
                            <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Triage</div>
                            <div className="text-sm text-gray-300 mb-1">{ch.triage_reason}</div>
                            <div className="text-xs text-gray-500">Look for: {ch.what_to_look_for}</div>
                            <a href={ch.channel_url} target="_blank" rel="noopener noreferrer" className="text-xs text-cyan-400 hover:underline mt-1 inline-block">
                              {ch.channel_url}
                            </a>
                          </div>

                          {/* Storyboards */}
                          {ch.storyboards && ch.storyboards.length > 0 && (
                            <div>
                              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                                Storyboards ({ch.storyboards.length})
                              </div>
                              <div className="space-y-2">
                                {ch.storyboards.map((sb) => (
                                  <div key={sb.id} className="bg-gray-900/50 border border-gray-700/30 rounded-lg overflow-hidden">
                                    <button
                                      onClick={() => toggleStoryboard(sb.id)}
                                      className="w-full px-3 py-2 flex items-center justify-between hover:bg-gray-800/50 transition text-left"
                                    >
                                      <div className="text-xs text-gray-300">
                                        <span className="font-mono text-gray-500">{sb.video_id}</span>
                                        {sb.video_title && <span className="ml-2 text-gray-400">{sb.video_title.substring(0, 50)}</span>}
                                        {sb.view_count > 0 && (
                                          <span className="ml-2 text-cyan-500">{Number(sb.view_count).toLocaleString()} views</span>
                                        )}
                                      </div>
                                      <svg
                                        className={`w-3.5 h-3.5 text-gray-500 transition-transform ${expandedStoryboards.has(sb.id) ? 'rotate-180' : ''}`}
                                        fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
                                      >
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                                      </svg>
                                    </button>
                                    {expandedStoryboards.has(sb.id) && sb.storyboard && (
                                      <div className="border-t border-gray-700/30 px-3 py-2">
                                        <pre className="text-xs text-gray-400 whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto">
                                          {JSON.stringify(sb.storyboard, null, 2)}
                                        </pre>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Synthesis */}
                          {ch.synthesis && (
                            <div>
                              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Synthesis</div>
                              <div className="bg-gray-900/50 border border-gray-700/30 rounded-lg p-3 space-y-3">
                                {(ch.synthesis as Record<string, unknown>).executive_summary && (
                                  <div className="text-sm text-gray-300 italic">
                                    {String((ch.synthesis as Record<string, unknown>).executive_summary)}
                                  </div>
                                )}
                                {(() => {
                                  const syn = ch.synthesis as Record<string, unknown>;
                                  const strategy = syn.content_strategy as Record<string, unknown> | undefined;
                                  const growth = syn.growth_analysis as Record<string, unknown> | undefined;
                                  const replicability = syn.replicability as Record<string, unknown> | undefined;
                                  return (
                                    <>
                                      {strategy?.core_template && (
                                        <div>
                                          <div className="text-xs text-cyan-500 font-medium mb-1">Core Template</div>
                                          <div className="text-xs text-gray-400">{String(strategy.core_template)}</div>
                                        </div>
                                      )}
                                      {growth?.why_it_works && Array.isArray(growth.why_it_works) && (
                                        <div>
                                          <div className="text-xs text-cyan-500 font-medium mb-1">Why It Works</div>
                                          <ul className="text-xs text-gray-400 space-y-0.5">
                                            {(growth.why_it_works as string[]).map((r, i) => (
                                              <li key={i} className="flex gap-1.5">
                                                <span className="text-cyan-600 mt-0.5">&#9656;</span>
                                                <span>{r}</span>
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
                                      {replicability?.score != null && (
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs text-cyan-500 font-medium">Replicability:</span>
                                          <span className="text-xs text-gray-300 font-mono">{String(replicability.score)}/1.0</span>
                                        </div>
                                      )}
                                    </>
                                  );
                                })()}
                                <details className="group">
                                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400">
                                    View full JSON
                                  </summary>
                                  <pre className="mt-2 text-xs text-gray-500 whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto">
                                    {JSON.stringify(ch.synthesis, null, 2)}
                                  </pre>
                                </details>
                              </div>
                            </div>
                          )}

                          {/* Generated Post */}
                          {ch.post && (
                            <div>
                              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Generated Post</div>
                              <div className="space-y-3">
                                {(() => {
                                  const videoIds = (ch.storyboards || [])
                                    .filter((sb) => sb.status === 'done')
                                    .sort((a, b) => Number(b.view_count) - Number(a.view_count))
                                    .slice(0, 3)
                                    .map((sb) => sb.video_id);
                                  if (videoIds.length === 0) return null;
                                  const params = new URLSearchParams();
                                  params.set('ids', videoIds.join(','));
                                  params.set('channelId', ch.channel_id);
                                  const imgUrl = `/api/admin/x-posts/composite-thumb?${params.toString()}`;
                                  return (
                                    <div className="bg-gray-900/50 border border-gray-700/30 rounded-lg p-3">
                                      <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs font-medium text-cyan-500">Image</span>
                                        <button
                                          onClick={async () => {
                                            try {
                                              const res = await fetch(imgUrl);
                                              const blob = await res.blob();
                                              const url = URL.createObjectURL(blob);
                                              const link = document.createElement('a');
                                              link.href = url;
                                              link.download = `${ch.channel_name}-composite.jpg`;
                                              link.click();
                                              URL.revokeObjectURL(url);
                                            } catch {}
                                          }}
                                          className="px-2 py-1 bg-gray-700 text-gray-300 rounded text-xs hover:bg-gray-600 transition"
                                        >
                                          Save Image
                                        </button>
                                      </div>
                                      <div className="rounded-lg overflow-hidden border border-gray-700/30">
                                        <img src={imgUrl} alt="Composite thumbnail" className="w-full h-auto" />
                                      </div>
                                    </div>
                                  );
                                })()}
                                <div className="bg-gray-900/50 border border-gray-700/30 rounded-lg p-3">
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs font-medium text-cyan-500">T1</span>
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs text-gray-500">{ch.post.tweet.length} chars</span>
                                      <span className={`px-1.5 py-0.5 rounded text-xs ${ch.post.tweet.length <= 336 ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                                        {ch.post.tweet.length <= 336 ? 'OK' : 'OVER'}
                                      </span>
                                      <button
                                        onClick={() => copyText(ch.post!.tweet, `t1-${ch.id}`)}
                                        className="px-2 py-1 bg-gray-700 text-gray-300 rounded text-xs hover:bg-gray-600 transition"
                                      >
                                        {copied === `t1-${ch.id}` ? 'Copied!' : 'Copy T1'}
                                      </button>
                                    </div>
                                  </div>
                                  <div className="text-sm text-gray-200 whitespace-pre-wrap">{ch.post.tweet}</div>
                                  {ch.post.hook_category && (
                                    <div className="mt-2 text-xs text-gray-500">
                                      Hook: <span className="text-cyan-500">{ch.post.hook_category}</span>
                                    </div>
                                  )}
                                </div>
                                <div className="bg-gray-900/50 border border-gray-700/30 rounded-lg p-3">
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs font-medium text-gray-500">T2 (hardcoded)</span>
                                    <button
                                      onClick={() => copyText(
                                        `${ch.channel_name}\n${ch.channel_url}\n\nFollow @evgeniirofe \u2014 we find channels like this every day.`,
                                        `t2-${ch.id}`
                                      )}
                                      className="px-2 py-1 bg-gray-700 text-gray-300 rounded text-xs hover:bg-gray-600 transition"
                                    >
                                      {copied === `t2-${ch.id}` ? 'Copied!' : 'Copy T2'}
                                    </button>
                                  </div>
                                  <div className="text-sm text-gray-400 whitespace-pre-wrap">
                                    {ch.channel_name}{'\n'}{ch.channel_url}{'\n\n'}Follow @evgeniirofe &mdash; we find channels like this every day.
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}

                          {ch.error && (
                            <div className="bg-red-900/20 border border-red-600/30 rounded-lg p-3 text-xs text-red-300">
                              {ch.error}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
