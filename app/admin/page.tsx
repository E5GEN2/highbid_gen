'use client';

import React, { useState, useEffect } from 'react';

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ synced: number; videos: number; confirmed: number; skipped: number; empty: number; totalFetched: number; emptyTaskIds?: string[] } | null>(null);
  const [syncError, setSyncError] = useState('');
  const [syncLimit, setSyncLimit] = useState('50');
  const [syncProgress, setSyncProgress] = useState<{ phase: string; message: string; total?: number; processed?: number; synced?: number; skipped?: number; videos?: number; empty?: number; tasksFetched?: number } | null>(null);

  // DB stats
  const [stats, setStats] = useState<{
    total_videos: string; total_channels: string;
    total_sightings: string; total_collections: string;
  } | null>(null);

  // Visible tabs state
  const ALL_TABS = [
    { id: 'creator', label: 'Creator' },
    { id: 'library', label: 'Library' },
    { id: 'spy', label: 'Feed Spy' },
    { id: 'feed', label: 'Shorts Feed' },
  ];
  const [visibleTabs, setVisibleTabs] = useState<string[]>(['feed']);
  const [tabsSaving, setTabsSaving] = useState(false);
  const [tabsSaved, setTabsSaved] = useState(false);

  // Config state
  const [xgodoToken, setXgodoToken] = useState('');
  const [xgodoJobId, setXgodoJobId] = useState('');
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);

  // Schedule state
  const [schedNumVideos, setSchedNumVideos] = useState(20);
  const [schedFetchAge, setSchedFetchAge] = useState(true);
  const [schedYoutubeKey, setSchedYoutubeKey] = useState('');
  const [schedFetchVideoCount, setSchedFetchVideoCount] = useState(false);
  const [schedTaskCount, setSchedTaskCount] = useState(1);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleResult, setScheduleResult] = useState<{ scheduled: number } | null>(null);
  const [scheduleError, setScheduleError] = useState('');

  // Users state
  interface UserRow {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    created_at: string;
    last_login: string;
    channels_seen: number;
    last_active: string | null;
  }
  const [users, setUsers] = useState<UserRow[]>([]);

  // Fetch avatars state
  const [fetchingAvatars, setFetchingAvatars] = useState(false);
  const [avatarResult, setAvatarResult] = useState<{ fetched: number; total: number; message?: string } | null>(null);
  const [avatarError, setAvatarError] = useState('');

  // Check auth on mount
  useEffect(() => {
    fetch('/api/admin/auth')
      .then(res => res.json())
      .then(data => {
        if (data.authenticated) setAuthenticated(true);
      })
      .finally(() => setChecking(false));
  }, []);

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
      fetchStats();
    } else {
      setLoginError('Invalid credentials');
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/admin/config');
      const data = await res.json();
      if (data.config) {
        setXgodoToken(data.config.xgodo_api_token || '');
        setXgodoJobId(data.config.xgodo_shorts_spy_job_id || '');
        setSchedYoutubeKey(data.config.youtube_api_key || '');
        try {
          if (data.config.visible_tabs) setVisibleTabs(JSON.parse(data.config.visible_tabs));
        } catch {}
      }
    } catch (err) {
      console.error('Failed to fetch config:', err);
    }
  };

  const handleSchedule = async () => {
    setScheduling(true);
    setScheduleResult(null);
    setScheduleError('');

    try {
      const res = await fetch('/api/admin/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numVideos: schedNumVideos,
          fetchChannelAge: schedFetchAge,
          youtubeApiKey: schedYoutubeKey,
          fetchChannelVideoCount: schedFetchVideoCount,
          taskCount: schedTaskCount,
        }),
      });
      const data = await res.json();

      if (data.success) {
        setScheduleResult({ scheduled: data.scheduled });
      } else {
        setScheduleError(data.error || 'Failed to schedule');
      }
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Failed to schedule');
    } finally {
      setScheduling(false);
    }
  };

  const saveConfig = async () => {
    setConfigSaving(true);
    setConfigSaved(false);
    try {
      await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            xgodo_api_token: xgodoToken,
            xgodo_shorts_spy_job_id: xgodoJobId,
            youtube_api_key: schedYoutubeKey,
          },
        }),
      });
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save config:', err);
    } finally {
      setConfigSaving(false);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/feed-spy?limit=0');
      const data = await res.json();
      if (data.stats) setStats(data.stats);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncError('');
    setSyncProgress(null);

    try {
      const limit = Math.max(1, parseInt(syncLimit) || 50);
      const res = await fetch('/api/feed-spy/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit }),
      });

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

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line in buffer

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'progress') {
                setSyncProgress(data);
              } else if (eventType === 'done') {
                setSyncResult(data);
                fetchStats();
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
      setSyncProgress(null);
    }
  };

  const handleFetchAvatars = async () => {
    setFetchingAvatars(true);
    setAvatarResult(null);
    setAvatarError('');

    try {
      const res = await fetch('/api/admin/fetch-avatars', { method: 'POST' });
      const data = await res.json();

      if (data.success) {
        setAvatarResult({ fetched: data.fetched, total: data.total || 0, message: data.message });
      } else {
        setAvatarError(data.error || 'Failed to fetch avatars');
      }
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Failed to fetch avatars');
    } finally {
      setFetchingAvatars(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/admin/users');
      const data = await res.json();
      if (data.users) setUsers(data.users);
    } catch {}
  };

  useEffect(() => {
    if (authenticated) {
      fetchStats();
      fetchConfig();
      fetchUsers();
    }
  }, [authenticated]);

  if (checking) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Login screen
  if (!authenticated) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 w-full max-w-sm">
          <div className="text-center mb-6">
            <div className="w-14 h-14 bg-gradient-to-br from-purple-600 to-pink-600 rounded-2xl flex items-center justify-center text-white font-bold text-2xl mx-auto mb-4">
              R
            </div>
            <h1 className="text-xl font-bold text-white">Admin Access</h1>
            <p className="text-sm text-gray-400 mt-1">rofe.ai control panel</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                autoFocus
              />
            </div>
            <div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>

            {loginError && (
              <div className="text-red-400 text-sm text-center">{loginError}</div>
            )}

            <button
              type="submit"
              className="w-full py-3 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 transition"
            >
              Log In
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Admin dashboard
  return (
    <div className="min-h-screen bg-gray-950">
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div>
            <h1 className="text-2xl font-bold text-white">Admin Panel</h1>
            <p className="text-gray-400 text-sm">rofe.ai data operations</p>
          </div>
          <a href="/" className="px-4 py-2 bg-gray-800 text-gray-300 rounded-xl hover:bg-gray-700 transition text-sm">
            Back to App
          </a>
        </div>

        {/* Navigation */}
        <a
          href="/admin/x-posts"
          className="block bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-8 hover:border-purple-600/50 hover:bg-gray-900/80 transition group"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-white font-bold text-lg group-hover:text-purple-400 transition">Daily X Posts</h2>
              <p className="text-gray-500 text-sm mt-0.5">Generate &amp; preview tweet content from today&apos;s discoveries</p>
            </div>
            <svg className="w-5 h-5 text-gray-600 group-hover:text-purple-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </a>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-4 gap-4 mb-10">
            {[
              { label: 'Videos', value: parseInt(stats.total_videos).toLocaleString(), color: 'text-blue-400' },
              { label: 'Channels', value: parseInt(stats.total_channels).toLocaleString(), color: 'text-purple-400' },
              { label: 'Data Points', value: parseInt(stats.total_sightings).toLocaleString(), color: 'text-orange-400' },
              { label: 'Collections', value: parseInt(stats.total_collections).toLocaleString(), color: 'text-green-400' },
            ].map((s, i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-gray-500">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Users */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white">Users</h2>
              <p className="text-gray-400 text-sm">{users.length} registered user{users.length !== 1 ? 's' : ''}</p>
            </div>
            <button
              onClick={fetchUsers}
              className="px-3 py-1.5 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition text-sm"
            >
              Refresh
            </button>
          </div>

          {users.length === 0 ? (
            <div className="text-gray-500 text-sm py-4">No users yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 text-xs uppercase tracking-wider border-b border-gray-800">
                    <th className="pb-2 pr-4">User</th>
                    <th className="pb-2 pr-4">Joined</th>
                    <th className="pb-2 pr-4">Last active</th>
                    <th className="pb-2 pr-4 text-right">Channels seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {users.map((u) => (
                    <tr key={u.id} className="text-gray-300">
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2.5">
                          {u.image ? (
                            <img src={u.image} alt="" className="w-7 h-7 rounded-full" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-purple-600 flex items-center justify-center text-white text-xs font-bold">
                              {(u.name?.[0] ?? '?').toUpperCase()}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-white text-sm truncate">{u.name || 'Unknown'}</div>
                            <div className="text-gray-500 text-xs truncate">{u.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-gray-400 whitespace-nowrap">
                        {new Date(u.created_at).toLocaleDateString()}
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-gray-400 whitespace-nowrap">
                        {u.last_active ? timeAgo(new Date(u.last_active)) : 'Never'}
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono text-xs">
                        {u.channels_seen}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Feed Spy Sync */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-2">Feed Spy — Sync</h2>
          <p className="text-gray-400 text-sm mb-4">
            Pull completed tasks from xgodo, store video/channel data in PostgreSQL, and mark tasks as confirmed.
          </p>

          <div className="flex items-center gap-3 mb-4">
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
                  Sync Now
                </>
              )}
            </button>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 whitespace-nowrap">Tasks limit</label>
              <input
                type="number"
                min={1}
                max={5000}
                value={syncLimit}
                onChange={(e) => setSyncLimit(e.target.value)}
                disabled={syncing}
                className="w-20 px-2.5 py-3 bg-gray-800 border border-gray-700 rounded-xl text-white text-sm text-center focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50"
              />
            </div>
          </div>

          {/* Live progress */}
          {syncing && syncProgress && (
            <div className="mb-4 bg-gray-800/80 border border-gray-700 rounded-xl p-4 space-y-3">
              {/* Phase label */}
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-red-400 rounded-full animate-pulse" />
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                  {syncProgress.phase === 'fetching' ? 'Fetching from xgodo' :
                   syncProgress.phase === 'resolving' ? 'Resolving channel IDs' :
                   syncProgress.phase === 'processing' ? 'Processing tasks' :
                   syncProgress.phase === 'avatars' ? 'Fetching YouTube data' :
                   syncProgress.phase === 'confirming' ? 'Confirming on xgodo' : syncProgress.phase}
                </span>
              </div>

              {/* Progress bar — always visible when we have numbers */}
              {syncProgress.phase === 'fetching' && (
                <>
                  <div className="w-full bg-gray-700 rounded-full h-2.5 overflow-hidden">
                    <div className="bg-red-500/60 h-full rounded-full animate-pulse" style={{ width: '100%' }} />
                  </div>
                  <div className="text-center">
                    <span className="text-2xl font-bold text-white font-mono">{syncProgress.tasksFetched ?? 0}</span>
                    <span className="text-sm text-gray-400 ml-2">tasks fetched</span>
                  </div>
                </>
              )}

              {syncProgress.phase === 'processing' && syncProgress.total != null && syncProgress.processed != null && (
                <>
                  <div className="w-full bg-gray-700 rounded-full h-2.5">
                    <div
                      className="bg-gradient-to-r from-red-500 to-orange-500 h-full rounded-full transition-all duration-200"
                      style={{ width: `${Math.round((syncProgress.processed / syncProgress.total) * 100)}%` }}
                    />
                  </div>
                  <div className="flex items-baseline justify-center gap-1">
                    <span className="text-3xl font-bold text-white font-mono">{syncProgress.processed}</span>
                    <span className="text-lg text-gray-500 font-mono">/ {syncProgress.total}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <div className="bg-green-900/30 border border-green-800/30 rounded-lg px-2 py-1.5 text-center">
                      <div className="text-base font-bold text-green-400 font-mono">{syncProgress.synced ?? 0}</div>
                      <div className="text-[9px] text-green-500/70 uppercase">synced</div>
                    </div>
                    <div className="bg-blue-900/30 border border-blue-800/30 rounded-lg px-2 py-1.5 text-center">
                      <div className="text-base font-bold text-blue-400 font-mono">{syncProgress.videos ?? 0}</div>
                      <div className="text-[9px] text-blue-500/70 uppercase">videos</div>
                    </div>
                    <div className="bg-gray-800 border border-gray-700/50 rounded-lg px-2 py-1.5 text-center">
                      <div className="text-base font-bold text-gray-400 font-mono">{syncProgress.skipped ?? 0}</div>
                      <div className="text-[9px] text-gray-500 uppercase">skipped</div>
                    </div>
                    <div className="bg-yellow-900/30 border border-yellow-800/30 rounded-lg px-2 py-1.5 text-center">
                      <div className="text-base font-bold text-yellow-400 font-mono">{syncProgress.empty ?? 0}</div>
                      <div className="text-[9px] text-yellow-500/70 uppercase">empty</div>
                    </div>
                  </div>
                </>
              )}

              {(syncProgress.phase === 'resolving' || syncProgress.phase === 'avatars' || syncProgress.phase === 'confirming') && (
                <>
                  <div className="w-full bg-gray-700 rounded-full h-2.5 overflow-hidden">
                    <div className="bg-purple-500/60 h-full rounded-full animate-pulse" style={{ width: '100%' }} />
                  </div>
                  <div className="text-sm text-gray-300 text-center">{syncProgress.message}</div>
                </>
              )}
            </div>
          )}

          {syncResult && (
            <div className="mt-4 bg-green-900/20 border border-green-600/30 rounded-xl p-4">
              <div className="text-green-400 font-medium mb-2">Sync Complete</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                <div className="bg-green-900/30 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-bold text-green-300">{syncResult.synced}</div>
                  <div className="text-[10px] text-green-400/70">tasks synced</div>
                </div>
                <div className="bg-blue-900/30 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-bold text-blue-300">{syncResult.videos}</div>
                  <div className="text-[10px] text-blue-400/70">videos ingested</div>
                </div>
                <div className="bg-purple-900/30 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-bold text-purple-300">{syncResult.confirmed}</div>
                  <div className="text-[10px] text-purple-400/70">confirmed</div>
                </div>
                <div className="bg-gray-800 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-bold text-gray-300">{syncResult.totalFetched}</div>
                  <div className="text-[10px] text-gray-400/70">fetched from xgodo</div>
                </div>
              </div>
              {(syncResult.skipped > 0 || syncResult.empty > 0) && (
                <div className="flex gap-3 mt-2 text-xs text-gray-400">
                  {syncResult.skipped > 0 && <span>{syncResult.skipped} already synced (skipped)</span>}
                  {syncResult.empty > 0 && <span className="text-yellow-400/70">{syncResult.empty} empty tasks</span>}
                </div>
              )}
            </div>
          )}

          {syncResult && syncResult.emptyTaskIds && syncResult.emptyTaskIds.length > 0 && (
            <div className="mt-4 bg-yellow-900/20 border border-yellow-600/30 rounded-xl p-4">
              <div className="text-yellow-400 font-medium mb-2">Empty Tasks ({syncResult.emptyTaskIds.length})</div>
              <div className="text-xs text-yellow-300/70 mb-2">These tasks returned 0 videos and were confirmed as paid:</div>
              <div className="flex flex-wrap gap-1.5">
                {syncResult.emptyTaskIds.map((id) => (
                  <code key={id} className="px-2 py-0.5 bg-yellow-900/30 border border-yellow-700/30 rounded text-xs text-yellow-300 font-mono">{id}</code>
                ))}
              </div>
            </div>
          )}

          {syncResult && syncResult.synced === 0 && syncResult.empty === 0 && syncResult.skipped === 0 && (
            <div className="mt-4 bg-gray-800 border border-gray-700 rounded-xl p-4">
              <div className="text-gray-300 text-sm">No new tasks to sync. All pending data has been collected.</div>
            </div>
          )}

          {syncError && (
            <div className="mt-4 bg-red-900/20 border border-red-600/30 rounded-xl p-4">
              <div className="text-red-400 font-medium mb-1">Sync Failed</div>
              <div className="text-sm text-red-300/70">{syncError}</div>
            </div>
          )}
        </div>

        {/* Fetch Avatars */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-2">Channel Avatars</h2>
          <p className="text-gray-400 text-sm mb-6">
            Fetch YouTube profile pictures for channels that are missing avatars. Uses the YouTube Data API key from config.
          </p>

          <button
            onClick={handleFetchAvatars}
            disabled={fetchingAvatars}
            className="px-6 py-3 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition flex items-center gap-3"
          >
            {fetchingAvatars ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Fetching avatars...
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Fetch Missing Avatars
              </>
            )}
          </button>

          {avatarResult && (
            <div className="mt-4 bg-green-900/20 border border-green-600/30 rounded-xl p-4">
              <div className="text-green-400 font-medium mb-1">Done</div>
              <div className="text-sm text-green-300/70">
                {avatarResult.message || `${avatarResult.fetched} of ${avatarResult.total} missing avatars fetched`}
              </div>
            </div>
          )}

          {avatarError && (
            <div className="mt-4 bg-red-900/20 border border-red-600/30 rounded-xl p-4">
              <div className="text-red-400 font-medium mb-1">Failed</div>
              <div className="text-sm text-red-300/70">{avatarError}</div>
            </div>
          )}
        </div>

        {/* Schedule Tasks */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-2">Feed Spy — Schedule Tasks</h2>
          <p className="text-gray-400 text-sm mb-6">
            Submit planned spy tasks to xgodo. Each task will collect YouTube Shorts feed data with the specified parameters.
          </p>

          <div className="space-y-5">
            {/* Task Count */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Number of tasks to schedule</label>
              <input
                type="number"
                min={1}
                max={100}
                value={schedTaskCount}
                onChange={(e) => setSchedTaskCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
                className="w-32 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">All tasks will use the same inputs below (max 100)</p>
            </div>

            <div className="border-t border-gray-800 pt-5">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-4">Task Inputs</div>

              {/* Num Videos */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Num videos <span className="text-red-400">*</span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={schedNumVideos}
                  onChange={(e) => setSchedNumVideos(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-32 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Number of videos to collect per task</p>
              </div>

              {/* Fetch Channel Age */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-300 mb-2">Fetch channel age</label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={schedFetchAge}
                    onChange={(e) => setSchedFetchAge(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-purple-500 focus:ring-purple-500 focus:ring-offset-0"
                  />
                  <span className="text-sm text-gray-300">Enabled</span>
                </label>
              </div>

              {/* YouTube API Key */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  YouTube API key
                  <span className="text-gray-500 text-xs ml-1">{schedFetchAge ? '(required)' : '(optional)'}</span>
                </label>
                <input
                  type="password"
                  value={schedYoutubeKey}
                  onChange={(e) => setSchedYoutubeKey(e.target.value)}
                  placeholder="Only required when fetching channel age"
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                />
              </div>

              {/* Fetch Channel Video Count */}
              <div className="mb-2">
                <label className="block text-sm font-medium text-gray-300 mb-2">Fetch channel video count</label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={schedFetchVideoCount}
                    onChange={(e) => setSchedFetchVideoCount(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-purple-500 focus:ring-purple-500 focus:ring-offset-0"
                  />
                  <span className="text-sm text-gray-300">Fetch number of videos of the channel</span>
                </label>
              </div>
            </div>

            {/* Submit */}
            <div className="border-t border-gray-800 pt-5">
              <button
                onClick={handleSchedule}
                disabled={scheduling || schedNumVideos < 1}
                className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 transition flex items-center gap-3"
              >
                {scheduling ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Scheduling...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6l4 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Schedule {schedTaskCount} Task{schedTaskCount > 1 ? 's' : ''}
                  </>
                )}
              </button>
            </div>

            {scheduleResult && (
              <div className="bg-green-900/20 border border-green-600/30 rounded-xl p-4">
                <div className="text-green-400 font-medium mb-1">Tasks Scheduled</div>
                <div className="text-sm text-green-300/70">
                  {scheduleResult.scheduled} task{scheduleResult.scheduled > 1 ? 's' : ''} submitted to xgodo. They will be picked up by workers and results will appear after syncing.
                </div>
              </div>
            )}

            {scheduleError && (
              <div className="bg-red-900/20 border border-red-600/30 rounded-xl p-4">
                <div className="text-red-400 font-medium mb-1">Schedule Failed</div>
                <div className="text-sm text-red-300/70">{scheduleError}</div>
              </div>
            )}
          </div>
        </div>

        {/* Visible Tabs */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-2">Visible Tabs</h2>
          <p className="text-gray-400 text-sm mb-6">
            Toggle which tabs are visible to regular users. Hidden tabs are still accessible via direct URL.
          </p>

          <div className="space-y-3">
            {ALL_TABS.map((tab) => (
              <label key={tab.id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={visibleTabs.includes(tab.id)}
                  onChange={(e) => {
                    setVisibleTabs((prev) =>
                      e.target.checked
                        ? [...prev, tab.id]
                        : prev.filter((t) => t !== tab.id)
                    );
                    setTabsSaved(false);
                  }}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-purple-500 focus:ring-purple-500 focus:ring-offset-0"
                />
                <span className="text-sm text-gray-300">{tab.label}</span>
              </label>
            ))}
          </div>

          <div className="flex items-center gap-3 mt-5">
            <button
              onClick={async () => {
                setTabsSaving(true);
                setTabsSaved(false);
                try {
                  await fetch('/api/admin/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ config: { visible_tabs: JSON.stringify(visibleTabs) } }),
                  });
                  setTabsSaved(true);
                  setTimeout(() => setTabsSaved(false), 3000);
                } catch {}
                setTabsSaving(false);
              }}
              disabled={tabsSaving}
              className="px-5 py-2.5 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition"
            >
              {tabsSaving ? 'Saving...' : 'Save'}
            </button>
            {tabsSaved && <span className="text-green-400 text-sm">Saved</span>}
          </div>
        </div>

        {/* xgodo Config */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <h2 className="text-lg font-bold text-white mb-2">xgodo Configuration</h2>
          <p className="text-gray-400 text-sm mb-6">API token and job IDs for xgodo integrations.</p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">xgodo API Token</label>
              <input
                type="password"
                value={xgodoToken}
                onChange={(e) => setXgodoToken(e.target.value)}
                placeholder="Bearer token from xgodo"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Shorts Spy Job ID</label>
              <input
                type="text"
                value={xgodoJobId}
                onChange={(e) => setXgodoJobId(e.target.value)}
                placeholder="e.g. 698709196049e1a09a72fb4e"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">YouTube API Key</label>
              <input
                type="password"
                value={schedYoutubeKey}
                onChange={(e) => setSchedYoutubeKey(e.target.value)}
                placeholder="For channel age fetching in spy tasks"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={saveConfig}
                disabled={configSaving}
                className="px-5 py-2.5 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition"
              >
                {configSaving ? 'Saving...' : 'Save Config'}
              </button>
              {configSaved && (
                <span className="text-green-400 text-sm">Saved</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
