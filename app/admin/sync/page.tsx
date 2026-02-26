'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

interface DbStats {
  channels: number;
  videos: number;
  collections: number;
  feedEligible: number;
}

interface SyncProgress {
  phase: string;
  message: string;
  total?: number;
  processed?: number;
  synced?: number;
  skipped?: number;
  videos?: number;
  empty?: number;
  tasksFetched?: number;
}

interface SyncResult {
  synced: number;
  videos: number;
  confirmed: number;
  skipped: number;
  empty: number;
  totalFetched: number;
  emptyTaskIds?: string[];
}

export default function SyncPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  // DB stats
  const [statsBefore, setStatsBefore] = useState<DbStats | null>(null);
  const [statsAfter, setStatsAfter] = useState<DbStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Fix dates state
  const [fixingDates, setFixingDates] = useState(false);
  const [fixDatesProgress, setFixDatesProgress] = useState<{ total: number; processed: number; updated: number; failed: number; message: string } | null>(null);
  const [fixDatesResult, setFixDatesResult] = useState<{ total: number; updated: number; failed: number; resolved: number } | null>(null);
  const [fixDatesError, setFixDatesError] = useState('');

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncLimit, setSyncLimit] = useState('50');
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState('');
  const [logLines, setLogLines] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-sync state
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  const [autoSyncInterval, setAutoSyncInterval] = useState('30');
  const [autoSyncLimit, setAutoSyncLimit] = useState('200');
  const [cronSecret, setCronSecret] = useState('');
  const [cronSecretVisible, setCronSecretVisible] = useState(false);
  const [lastAutoSync, setLastAutoSync] = useState<{ at: string; result: { synced: number; skipped: number; confirmed: number; videos: number; error?: string } } | null>(null);
  const [autoSyncCountdown, setAutoSyncCountdown] = useState(0);
  const [autoSyncConfigLoaded, setAutoSyncConfigLoaded] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStats = useCallback(async (): Promise<DbStats | null> => {
    try {
      const res = await fetch('/api/feed-spy/sync');
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, []);

  // Check auth on mount
  useEffect(() => {
    fetch('/api/admin/auth')
      .then(res => res.json())
      .then(data => {
        if (data.authenticated) {
          setAuthenticated(true);
        }
      })
      .finally(() => setChecking(false));
  }, []);

  // Load initial stats
  useEffect(() => {
    if (authenticated) {
      setStatsLoading(true);
      fetchStats().then(s => {
        setStatsBefore(s);
        setStatsLoading(false);
      });
    }
  }, [authenticated, fetchStats]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  // Load auto-sync config
  useEffect(() => {
    if (!authenticated) return;
    fetch('/api/admin/config')
      .then(res => res.json())
      .then(data => {
        if (data.config) {
          const c = data.config;
          setAutoSyncEnabled(c.auto_sync_enabled === 'true');
          setAutoSyncInterval(c.auto_sync_interval_minutes || '30');
          setAutoSyncLimit(c.auto_sync_task_limit || '200');
          setCronSecret(c.cron_secret || '');
          if (c.last_auto_sync_at) {
            try {
              setLastAutoSync({
                at: c.last_auto_sync_at,
                result: JSON.parse(c.last_auto_sync_result || '{}'),
              });
            } catch { /* skip */ }
          }
          setAutoSyncConfigLoaded(true);
        }
      })
      .catch(() => {});
  }, [authenticated]);

  // Save auto-sync config helper
  const saveAutoSyncConfig = useCallback(async (overrides: Record<string, string>) => {
    await fetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: overrides }),
    });
  }, []);

  // Client-side auto-sync countdown timer
  useEffect(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }

    if (!autoSyncEnabled || !autoSyncConfigLoaded) {
      setAutoSyncCountdown(0);
      return;
    }

    const intervalSec = (parseInt(autoSyncInterval) || 30) * 60;
    setAutoSyncCountdown(intervalSec);

    countdownRef.current = setInterval(() => {
      setAutoSyncCountdown(prev => {
        if (prev <= 1) return intervalSec; // will trigger sync below
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoSyncEnabled, autoSyncInterval, autoSyncConfigLoaded]);

  // Trigger sync when countdown hits 0
  const prevCountdown = useRef(0);
  useEffect(() => {
    if (autoSyncEnabled && prevCountdown.current > 1 && autoSyncCountdown <= 1 && !syncing && autoSyncConfigLoaded) {
      handleSyncRef.current();
    }
    prevCountdown.current = autoSyncCountdown;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSyncCountdown, autoSyncEnabled, syncing, autoSyncConfigLoaded]);

  // Reset countdown after manual sync completes
  useEffect(() => {
    if (!syncing && autoSyncEnabled && autoSyncConfigLoaded) {
      const intervalSec = (parseInt(autoSyncInterval) || 30) * 60;
      setAutoSyncCountdown(intervalSec);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    const res = await fetch('/api/admin/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.success) {
      setAuthenticated(true);
    } else {
      setLoginError('Invalid credentials');
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncError('');
    setSyncProgress(null);
    setStatsAfter(null);
    setLogLines([]);

    // Refresh before-stats
    const before = await fetchStats();
    if (before) setStatsBefore(before);

    try {
      const limit = Math.max(1, parseInt(syncLimit) || 50);
      const res = await fetch('/api/feed-spy/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit }),
      });

      if (!res.ok) {
        setSyncError(res.status === 401 ? 'Unauthorized — please log in again' : `HTTP ${res.status}`);
        setSyncing(false);
        return;
      }

      if (!res.body) {
        setSyncError('No response stream');
        setSyncing(false);
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
                setSyncProgress(data);
                if (data.message) {
                  setLogLines(prev => [...prev, data.message]);
                }
              } else if (eventType === 'done') {
                setSyncResult(data);
                // Fetch after-stats
                const after = await fetchStats();
                if (after) setStatsAfter(after);
              } else if (eventType === 'error') {
                setSyncError(data.error || 'Sync failed');
              }
            } catch { /* skip malformed */ }
            eventType = '';
          }
        }
      }
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  // Ref so countdown effect can call latest handleSync without stale closure
  const handleSyncRef = useRef(handleSync);
  handleSyncRef.current = handleSync;

  const handleFixDates = async () => {
    setFixingDates(true);
    setFixDatesResult(null);
    setFixDatesError('');
    setFixDatesProgress(null);

    try {
      const res = await fetch('/api/admin/fix-channel-dates', { method: 'POST' });

      if (!res.ok) {
        setFixDatesError(res.status === 401 ? 'Unauthorized' : `HTTP ${res.status}`);
        setFixingDates(false);
        return;
      }

      if (!res.body) {
        setFixDatesError('No response stream');
        setFixingDates(false);
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
                setFixDatesProgress(data);
              } else if (eventType === 'done') {
                setFixDatesResult(data);
                const s = await fetchStats();
                if (s) {
                  if (statsAfter) setStatsAfter(s);
                  else setStatsBefore(s);
                }
              } else if (eventType === 'error') {
                setFixDatesError(data.error || 'Failed');
              }
            } catch { /* skip */ }
            eventType = '';
          }
        }
      }
    } catch (err) {
      setFixDatesError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setFixingDates(false);
    }
  };

  const formatTimeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  };

  const phaseLabel = (phase: string) => {
    switch (phase) {
      case 'fetching': return 'Fetching from xgodo';
      case 'resolving': return 'Resolving channel IDs';
      case 'processing': return 'Processing tasks';
      case 'avatars': return 'Fetching YouTube data';
      case 'confirming': return 'Confirming on xgodo';
      default: return phase;
    }
  };

  const phaseColor = (phase: string) => {
    switch (phase) {
      case 'fetching': return 'text-yellow-400';
      case 'resolving': return 'text-purple-400';
      case 'processing': return 'text-blue-400';
      case 'avatars': return 'text-cyan-400';
      case 'confirming': return 'text-green-400';
      default: return 'text-gray-400';
    }
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 w-full max-w-sm">
          <div className="text-center mb-6">
            <div className="w-14 h-14 bg-gradient-to-br from-purple-600 to-pink-600 rounded-2xl flex items-center justify-center text-white font-bold text-2xl mx-auto mb-4">
              R
            </div>
            <h1 className="text-xl font-bold text-white">Admin Access</h1>
            <p className="text-sm text-gray-400 mt-1">Sync Monitor</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              autoFocus
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
            {loginError && <div className="text-red-400 text-sm text-center">{loginError}</div>}
            <button type="submit" className="w-full py-3 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 transition">
              Log In
            </button>
          </form>
        </div>
      </div>
    );
  }

  const delta = statsBefore && statsAfter ? {
    channels: statsAfter.channels - statsBefore.channels,
    videos: statsAfter.videos - statsBefore.videos,
    collections: statsAfter.collections - statsBefore.collections,
    feedEligible: statsAfter.feedEligible - statsBefore.feedEligible,
  } : null;

  // Check if delta matches sync result
  const deltaValid = delta && syncResult
    ? delta.videos === syncResult.videos && delta.collections === syncResult.synced + syncResult.empty
    : null;

  return (
    <div className="min-h-screen bg-gray-950">
      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Sync Monitor</h1>
            <p className="text-gray-400 text-sm">Feed Spy data sync</p>
          </div>
          <a href="/admin" className="px-4 py-2 bg-gray-800 text-gray-300 rounded-xl hover:bg-gray-700 transition text-sm">
            Back to Admin
          </a>
        </div>

        {/* Before Stats */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
              {statsAfter ? 'Before Sync' : 'Current Database'}
            </h2>
            {!syncing && (
              <button
                onClick={async () => {
                  setStatsLoading(true);
                  const s = await fetchStats();
                  if (s) setStatsBefore(s);
                  setStatsLoading(false);
                }}
                className="text-xs text-gray-500 hover:text-gray-300 transition"
              >
                {statsLoading ? 'Loading...' : 'Refresh'}
              </button>
            )}
          </div>
          {statsBefore ? (
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-gray-800/50 rounded-xl p-4 text-center">
                <div className="text-2xl font-bold text-purple-400 font-mono">{statsBefore.channels.toLocaleString()}</div>
                <div className="text-xs text-gray-500 mt-1">Channels</div>
              </div>
              <div className="bg-gray-800/50 rounded-xl p-4 text-center">
                <div className="text-2xl font-bold text-blue-400 font-mono">{statsBefore.videos.toLocaleString()}</div>
                <div className="text-xs text-gray-500 mt-1">Videos</div>
              </div>
              <div className="bg-gray-800/50 rounded-xl p-4 text-center">
                <div className="text-2xl font-bold text-green-400 font-mono">{statsBefore.collections.toLocaleString()}</div>
                <div className="text-xs text-gray-500 mt-1">Collections</div>
              </div>
              <div className="bg-gray-800/50 rounded-xl p-4 text-center border border-orange-800/30">
                <div className="text-2xl font-bold text-orange-400 font-mono">{statsBefore.feedEligible.toLocaleString()}</div>
                <div className="text-xs text-gray-500 mt-1">In Feed</div>
                <div className="text-[9px] text-gray-600 mt-0.5">&lt;90d, 10K+ subs</div>
              </div>
            </div>
          ) : (
            <div className="text-gray-500 text-sm">{statsLoading ? 'Loading stats...' : 'Failed to load stats'}</div>
          )}
        </div>

        {/* Controls */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6 space-y-4">
          <div className="flex items-center gap-4">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="px-6 py-3 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 disabled:opacity-50 transition flex items-center gap-3"
            >
              {syncing ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Start Sync
                </>
              )}
            </button>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">Task limit</label>
              <input
                type="number"
                min={1}
                max={5000}
                value={syncLimit}
                onChange={(e) => setSyncLimit(e.target.value)}
                disabled={syncing}
                className="w-24 px-3 py-3 bg-gray-800 border border-gray-700 rounded-xl text-white text-sm text-center font-mono focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50"
              />
            </div>
          </div>

          {/* Fix Channel Dates */}
          <div className="flex items-center gap-3 pt-2 border-t border-gray-800">
            <button
              onClick={handleFixDates}
              disabled={fixingDates || syncing}
              className="px-5 py-2.5 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition flex items-center gap-2 text-sm"
            >
              {fixingDates ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Fixing dates...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  Fix Channel Dates
                </>
              )}
            </button>
            <span className="text-xs text-gray-500">Fix NULL, future, or pre-2005 dates via YouTube API</span>
          </div>
          {/* Fix dates progress */}
          {fixingDates && fixDatesProgress && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span>{fixDatesProgress.message}</span>
                <span className="font-mono">{fixDatesProgress.processed}/{fixDatesProgress.total}</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2.5">
                <div
                  className="bg-gradient-to-r from-purple-500 to-pink-500 h-full rounded-full transition-all duration-300"
                  style={{ width: fixDatesProgress.total > 0 ? `${Math.round((fixDatesProgress.processed / fixDatesProgress.total) * 100)}%` : '0%' }}
                />
              </div>
              <div className="flex gap-4 text-xs">
                <span className="text-green-400">{fixDatesProgress.updated} updated</span>
                {fixDatesProgress.failed > 0 && <span className="text-yellow-400">{fixDatesProgress.failed} failed</span>}
              </div>
            </div>
          )}
          {fixDatesResult && (
            <div className="bg-green-900/20 border border-green-600/30 rounded-xl p-3 text-sm">
              <span className="text-green-400 font-medium">Done</span>
              <span className="text-green-300/70 ml-2">
                {fixDatesResult.updated} updated out of {fixDatesResult.total} channels
                {fixDatesResult.resolved > 0 && <span className="text-purple-400 ml-1">({fixDatesResult.resolved} @handles resolved)</span>}
                {fixDatesResult.failed > 0 && <span className="text-yellow-400 ml-1">({fixDatesResult.failed} failed)</span>}
              </span>
              {fixDatesResult.total === 0 && (
                <span className="text-gray-400 ml-2">All dates already valid</span>
              )}
            </div>
          )}
          {fixDatesError && (
            <div className="bg-red-900/20 border border-red-600/30 rounded-xl p-3 text-sm">
              <span className="text-red-400 font-medium">Failed:</span>
              <span className="text-red-300/70 ml-2">{fixDatesError}</span>
            </div>
          )}
        </div>

        {/* Auto-Sync Settings */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Auto-Sync</h2>
            <button
              onClick={async () => {
                const next = !autoSyncEnabled;
                setAutoSyncEnabled(next);
                await saveAutoSyncConfig({ auto_sync_enabled: next ? 'true' : 'false' });
              }}
              className={`relative w-12 h-6 rounded-full transition-colors ${autoSyncEnabled ? 'bg-green-600' : 'bg-gray-700'}`}
            >
              <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${autoSyncEnabled ? 'translate-x-6' : ''}`} />
            </button>
          </div>

          {autoSyncEnabled && autoSyncCountdown > 0 && !syncing && (
            <div className="flex items-center gap-2 text-sm">
              <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
              <span className="text-green-400 font-mono">
                Next sync in {Math.floor(autoSyncCountdown / 60)}:{String(autoSyncCountdown % 60).padStart(2, '0')}
              </span>
            </div>
          )}

          {autoSyncEnabled && syncing && (
            <div className="flex items-center gap-2 text-sm">
              <div className="w-4 h-4 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-green-400">Syncing now...</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">Interval</label>
              <div className="flex gap-1">
                {[
                  { label: '15m', value: '15' },
                  { label: '30m', value: '30' },
                  { label: '1h', value: '60' },
                  { label: '2h', value: '120' },
                  { label: '6h', value: '360' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={async () => {
                      setAutoSyncInterval(opt.value);
                      await saveAutoSyncConfig({ auto_sync_interval_minutes: opt.value });
                    }}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition ${
                      autoSyncInterval === opt.value
                        ? 'bg-purple-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">Task limit</label>
              <input
                type="number"
                min={1}
                max={5000}
                value={autoSyncLimit}
                onChange={(e) => setAutoSyncLimit(e.target.value)}
                onBlur={async () => {
                  const val = String(Math.max(1, Math.min(5000, parseInt(autoSyncLimit) || 200)));
                  setAutoSyncLimit(val);
                  await saveAutoSyncConfig({ auto_sync_task_limit: val });
                }}
                className="w-24 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm text-center font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
          </div>

          {/* Cron endpoint */}
          <div className="pt-2 border-t border-gray-800 space-y-2">
            <div className="text-xs text-gray-500">
              Cron endpoint: <code className="text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">GET /api/cron/sync</code>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500">Secret:</label>
              <code className="text-xs text-gray-300 bg-gray-800 px-2 py-1 rounded font-mono flex-1 min-w-0 truncate">
                {cronSecret ? (cronSecretVisible ? cronSecret : '●'.repeat(Math.min(cronSecret.length, 24))) : '(not set)'}
              </code>
              {cronSecret && (
                <>
                  <button
                    onClick={() => setCronSecretVisible(v => !v)}
                    className="text-xs text-gray-500 hover:text-gray-300 transition px-2 py-1"
                  >
                    {cronSecretVisible ? 'Hide' : 'Show'}
                  </button>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(cronSecret);
                    }}
                    className="text-xs text-gray-500 hover:text-gray-300 transition px-2 py-1"
                  >
                    Copy
                  </button>
                </>
              )}
              <button
                onClick={async () => {
                  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                  const arr = new Uint8Array(32);
                  crypto.getRandomValues(arr);
                  const secret = Array.from(arr, b => chars[b % chars.length]).join('');
                  setCronSecret(secret);
                  setCronSecretVisible(true);
                  await saveAutoSyncConfig({ cron_secret: secret });
                }}
                className="text-xs text-purple-400 hover:text-purple-300 transition px-2 py-1 whitespace-nowrap"
              >
                {cronSecret ? 'Regenerate' : 'Generate'}
              </button>
            </div>
          </div>

          {/* Last run info */}
          {lastAutoSync && (
            <div className="pt-2 border-t border-gray-800">
              <div className="flex items-center gap-3 text-xs">
                <span className="text-gray-500">Last run:</span>
                <span className="text-gray-300">{formatTimeAgo(lastAutoSync.at)}</span>
              </div>
              {lastAutoSync.result && !lastAutoSync.result.error && (
                <div className="flex items-center gap-3 text-xs mt-1">
                  <span className="text-gray-500">Result:</span>
                  <span className="text-green-400">{lastAutoSync.result.synced} synced</span>
                  <span className="text-gray-600">·</span>
                  <span className="text-gray-400">{lastAutoSync.result.skipped} skipped</span>
                  <span className="text-gray-600">·</span>
                  <span className="text-blue-400">{lastAutoSync.result.videos} videos</span>
                </div>
              )}
              {lastAutoSync.result?.error && (
                <div className="text-xs text-red-400 mt-1">{lastAutoSync.result.error}</div>
              )}
            </div>
          )}
        </div>

        {/* Live Progress */}
        {syncing && syncProgress && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6 space-y-5">
            {/* Phase indicator */}
            <div className="flex items-center gap-3">
              <div className="w-2.5 h-2.5 bg-red-400 rounded-full animate-pulse" />
              <span className={`text-sm font-semibold uppercase tracking-wider ${phaseColor(syncProgress.phase)}`}>
                {phaseLabel(syncProgress.phase)}
              </span>
            </div>

            {/* Counter + progress bar */}
            {syncProgress.phase === 'fetching' && (
              <>
                <div className="text-center">
                  <span className="text-4xl font-bold text-white font-mono">{syncProgress.tasksFetched ?? 0}</span>
                  <span className="text-lg text-gray-500 ml-2">tasks fetched</span>
                </div>
                <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
                  <div className="bg-yellow-500/60 h-full rounded-full animate-pulse" style={{ width: '100%' }} />
                </div>
              </>
            )}

            {syncProgress.phase === 'processing' && syncProgress.total != null && syncProgress.processed != null && (
              <>
                <div className="text-center">
                  <span className="text-4xl font-bold text-white font-mono">{syncProgress.processed}</span>
                  <span className="text-2xl text-gray-500 font-mono mx-1">/</span>
                  <span className="text-2xl text-gray-500 font-mono">{syncProgress.total}</span>
                </div>
                <div className="w-full bg-gray-700 rounded-full h-3">
                  <div
                    className="bg-gradient-to-r from-red-500 to-orange-500 h-full rounded-full transition-all duration-300"
                    style={{ width: `${Math.round((syncProgress.processed / syncProgress.total) * 100)}%` }}
                  />
                </div>
                {/* Stat cards */}
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-green-900/30 border border-green-800/30 rounded-xl px-3 py-3 text-center">
                    <div className="text-xl font-bold text-green-400 font-mono">{syncProgress.synced ?? 0}</div>
                    <div className="text-[10px] text-green-500/70 uppercase tracking-wider">synced</div>
                  </div>
                  <div className="bg-blue-900/30 border border-blue-800/30 rounded-xl px-3 py-3 text-center">
                    <div className="text-xl font-bold text-blue-400 font-mono">{syncProgress.videos ?? 0}</div>
                    <div className="text-[10px] text-blue-500/70 uppercase tracking-wider">videos</div>
                  </div>
                  <div className="bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-3 text-center">
                    <div className="text-xl font-bold text-gray-400 font-mono">{syncProgress.skipped ?? 0}</div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">skipped</div>
                  </div>
                  <div className="bg-yellow-900/30 border border-yellow-800/30 rounded-xl px-3 py-3 text-center">
                    <div className="text-xl font-bold text-yellow-400 font-mono">{syncProgress.empty ?? 0}</div>
                    <div className="text-[10px] text-yellow-500/70 uppercase tracking-wider">empty</div>
                  </div>
                </div>
              </>
            )}

            {(syncProgress.phase === 'resolving' || syncProgress.phase === 'avatars' || syncProgress.phase === 'confirming') && (
              <>
                <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
                  <div className="bg-purple-500/60 h-full rounded-full animate-pulse" style={{ width: '100%' }} />
                </div>
                <div className="text-sm text-gray-300 text-center">{syncProgress.message}</div>
              </>
            )}

            {/* Activity log */}
            <div
              ref={logRef}
              className="bg-gray-950 border border-gray-800 rounded-xl p-4 h-48 overflow-y-auto font-mono text-xs text-gray-400 space-y-0.5"
            >
              {logLines.map((line, i) => (
                <div key={i} className={
                  line.includes('skipped') ? 'text-gray-600' :
                  line.includes('empty') ? 'text-yellow-500/70' :
                  line.includes('ingested') ? 'text-green-400/80' :
                  line.includes('Resolved') ? 'text-purple-400/80' :
                  line.includes('Warning') ? 'text-yellow-400' :
                  line.includes('Error') || line.includes('failed') ? 'text-red-400' :
                  'text-gray-400'
                }>
                  {line}
                </div>
              ))}
              {logLines.length === 0 && <div className="text-gray-600">Waiting for events...</div>}
            </div>
          </div>
        )}

        {/* Sync Error */}
        {syncError && (
          <div className="bg-red-900/20 border border-red-600/30 rounded-2xl p-6 mb-6">
            <div className="text-red-400 font-semibold mb-1">Sync Failed</div>
            <div className="text-sm text-red-300/70">{syncError}</div>
          </div>
        )}

        {/* Results + After Stats */}
        {syncResult && (
          <div className="space-y-6">
            {/* Final summary */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
              <h2 className="text-sm font-semibold text-green-400 uppercase tracking-wider mb-4">Sync Complete</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-green-900/30 border border-green-800/30 rounded-xl px-3 py-4 text-center">
                  <div className="text-2xl font-bold text-green-300 font-mono">{syncResult.synced}</div>
                  <div className="text-[10px] text-green-400/70 uppercase">tasks synced</div>
                </div>
                <div className="bg-blue-900/30 border border-blue-800/30 rounded-xl px-3 py-4 text-center">
                  <div className="text-2xl font-bold text-blue-300 font-mono">{syncResult.videos}</div>
                  <div className="text-[10px] text-blue-400/70 uppercase">videos ingested</div>
                </div>
                <div className="bg-purple-900/30 border border-purple-800/30 rounded-xl px-3 py-4 text-center">
                  <div className="text-2xl font-bold text-purple-300 font-mono">{syncResult.confirmed}</div>
                  <div className="text-[10px] text-purple-400/70 uppercase">confirmed</div>
                </div>
                <div className="bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-4 text-center">
                  <div className="text-2xl font-bold text-gray-300 font-mono">{syncResult.totalFetched}</div>
                  <div className="text-[10px] text-gray-400/70 uppercase">total fetched</div>
                </div>
              </div>
              {(syncResult.skipped > 0 || syncResult.empty > 0) && (
                <div className="flex gap-4 mt-3 text-xs text-gray-400">
                  {syncResult.skipped > 0 && <span>{syncResult.skipped} already synced (skipped)</span>}
                  {syncResult.empty > 0 && <span className="text-yellow-400/70">{syncResult.empty} empty tasks</span>}
                </div>
              )}
            </div>

            {/* After stats + delta */}
            {statsAfter && (
              <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">After Sync</h2>
                <div className="grid grid-cols-4 gap-4">
                  <div className="bg-gray-800/50 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-purple-400 font-mono">{statsAfter.channels.toLocaleString()}</div>
                    <div className="text-xs text-gray-500 mt-1">Channels</div>
                  </div>
                  <div className="bg-gray-800/50 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-blue-400 font-mono">{statsAfter.videos.toLocaleString()}</div>
                    <div className="text-xs text-gray-500 mt-1">Videos</div>
                  </div>
                  <div className="bg-gray-800/50 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-green-400 font-mono">{statsAfter.collections.toLocaleString()}</div>
                    <div className="text-xs text-gray-500 mt-1">Collections</div>
                  </div>
                  <div className="bg-gray-800/50 rounded-xl p-4 text-center border border-orange-800/30">
                    <div className="text-2xl font-bold text-orange-400 font-mono">{statsAfter.feedEligible.toLocaleString()}</div>
                    <div className="text-xs text-gray-500 mt-1">In Feed</div>
                    <div className="text-[9px] text-gray-600 mt-0.5">&lt;90d, 10K+ subs</div>
                  </div>
                </div>

                {/* Delta row */}
                {delta && (
                  <div className="mt-4 flex items-center gap-3">
                    <div className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-mono ${
                      deltaValid ? 'bg-green-900/30 border border-green-700/40' : 'bg-yellow-900/30 border border-yellow-700/40'
                    }`}>
                      {deltaValid && (
                        <svg className="w-4 h-4 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      <span className="text-gray-300">
                        <span className={delta.channels > 0 ? 'text-purple-400' : 'text-gray-500'}>
                          {delta.channels > 0 ? '+' : ''}{delta.channels} channels
                        </span>
                        <span className="text-gray-600 mx-2">/</span>
                        <span className={delta.videos > 0 ? 'text-blue-400' : 'text-gray-500'}>
                          {delta.videos > 0 ? '+' : ''}{delta.videos} videos
                        </span>
                        <span className="text-gray-600 mx-2">/</span>
                        <span className={delta.collections > 0 ? 'text-green-400' : 'text-gray-500'}>
                          {delta.collections > 0 ? '+' : ''}{delta.collections} collections
                        </span>
                        <span className="text-gray-600 mx-2">/</span>
                        <span className={delta.feedEligible > 0 ? 'text-orange-400' : 'text-gray-500'}>
                          {delta.feedEligible > 0 ? '+' : ''}{delta.feedEligible} in feed
                        </span>
                      </span>
                    </div>
                    {deltaValid === false && (
                      <span className="text-yellow-400 text-xs">Delta doesn&apos;t match sync report — check logs</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Scrollable log (persists after sync) */}
            {logLines.length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Activity Log ({logLines.length} events)</h2>
                <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 max-h-64 overflow-y-auto font-mono text-xs text-gray-400 space-y-0.5">
                  {logLines.map((line, i) => (
                    <div key={i} className={
                      line.includes('skipped') ? 'text-gray-600' :
                      line.includes('empty') ? 'text-yellow-500/70' :
                      line.includes('ingested') ? 'text-green-400/80' :
                      line.includes('Resolved') ? 'text-purple-400/80' :
                      line.includes('Warning') ? 'text-yellow-400' :
                      line.includes('Error') || line.includes('failed') ? 'text-red-400' :
                      'text-gray-400'
                    }>
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
