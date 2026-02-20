'use client';

import React, { useState, useEffect, useCallback } from 'react';

interface ProgressEvent {
  step: string;
  channel_name?: string;
  video_id?: string;
  progress?: number;
  total?: number;
  message: string;
}

interface ChannelEntry {
  id: string;
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

const STEPS = ['triage', 'storyboarding', 'synthesis', 'post_gen', 'done'];
const STEP_LABELS: Record<string, string> = {
  triage: 'Triage',
  storyboarding: 'Storyboards',
  synthesis: 'Synthesis',
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
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<{ run: Run; channels: ChannelEntry[] } | null>(null);
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());
  const [expandedStoryboards, setExpandedStoryboards] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Auth check
  useEffect(() => {
    fetch('/api/admin/auth')
      .then((res) => res.json())
      .then((data) => { if (data.authenticated) setAuthenticated(true); })
      .finally(() => setChecking(false));
  }, []);

  // Fetch runs
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

  // Fetch run detail
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

  // Start new run
  const handleStartRun = async () => {
    setRunning(true);
    setProgress(null);
    setRunError(null);
    setCurrentRunId(null);

    try {
      const res = await fetch('/api/admin/deep-analysis', { method: 'POST' });

      if (!res.body) {
        setRunError('No response stream');
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'progress') {
                setProgress(data);
              } else if (eventType === 'done') {
                setCurrentRunId(data.runId);
                fetchRuns();
              } else if (eventType === 'error') {
                setRunError(data.error);
              }
            } catch {}
            eventType = '';
          }
        }
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to start run');
    } finally {
      setRunning(false);
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

  const currentStepIndex = progress ? STEPS.indexOf(progress.step) : -1;

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

        {/* Start Button + Live Progress */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white">Run Pipeline</h2>
            <button
              onClick={handleStartRun}
              disabled={running}
              className="px-6 py-3 bg-cyan-600 text-white font-semibold rounded-xl hover:bg-cyan-700 disabled:opacity-50 transition flex items-center gap-3"
            >
              {running ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Running...
                </>
              ) : (
                'Start New Run'
              )}
            </button>
          </div>

          {/* Step Indicator */}
          {running && progress && (
            <div className="space-y-4">
              {/* Steps bar */}
              <div className="flex items-center gap-1">
                {STEPS.filter((s) => s !== 'done').map((step, i) => {
                  const stepIdx = STEPS.indexOf(step);
                  const isActive = stepIdx === currentStepIndex;
                  const isDone = stepIdx < currentStepIndex || progress.step === 'done';
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

              {/* Current action */}
              <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-4">
                <div className="text-sm text-gray-300 mb-2">{progress.message}</div>
                {progress.total && progress.total > 1 && (
                  <div className="w-full bg-gray-700 rounded-full h-2">
                    <div
                      className="bg-gradient-to-r from-cyan-500 to-teal-500 h-full rounded-full transition-all duration-300"
                      style={{ width: `${Math.round(((progress.progress || 0) / progress.total) * 100)}%` }}
                    />
                  </div>
                )}
                {progress.total && progress.total > 1 && (
                  <div className="text-xs text-gray-500 mt-1.5">
                    {progress.progress || 0} / {progress.total}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Completed run link */}
          {!running && currentRunId && (
            <div className="bg-green-900/20 border border-green-600/30 rounded-xl p-4">
              <div className="text-green-400 font-medium mb-1">Run completed</div>
              <button
                onClick={() => handleExpand(currentRunId)}
                className="text-sm text-cyan-400 hover:underline"
              >
                View results
              </button>
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
                                {/* Executive summary */}
                                {(ch.synthesis as Record<string, unknown>).executive_summary && (
                                  <div className="text-sm text-gray-300 italic">
                                    {String((ch.synthesis as Record<string, unknown>).executive_summary)}
                                  </div>
                                )}

                                {/* Key sections */}
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

                                {/* Full JSON toggle */}
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
                                {/* T1 */}
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

                                {/* T2 (hardcoded) */}
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
