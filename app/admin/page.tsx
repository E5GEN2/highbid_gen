'use client';

import React, { useState, useEffect } from 'react';

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ synced: number; videos: number; confirmed: number } | null>(null);
  const [syncError, setSyncError] = useState('');

  // DB stats
  const [stats, setStats] = useState<{
    total_videos: string; total_channels: string;
    total_sightings: string; total_collections: string;
  } | null>(null);

  // Config state
  const [xgodoToken, setXgodoToken] = useState('');
  const [xgodoJobId, setXgodoJobId] = useState('');
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);

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
      }
    } catch (err) {
      console.error('Failed to fetch config:', err);
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

    try {
      const res = await fetch('/api/feed-spy/sync', { method: 'POST' });
      const data = await res.json();

      if (data.success) {
        setSyncResult({ synced: data.synced, videos: data.videos, confirmed: data.confirmed });
        fetchStats();
      } else {
        setSyncError(data.error || 'Sync failed');
      }
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    if (authenticated) {
      fetchStats();
      fetchConfig();
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

        {/* Feed Spy Sync */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-2">Feed Spy — Sync</h2>
          <p className="text-gray-400 text-sm mb-6">
            Pull completed tasks from xgodo, store video/channel data in PostgreSQL, and mark tasks as confirmed.
          </p>

          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-6 py-3 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 disabled:opacity-50 transition flex items-center gap-3"
          >
            {syncing ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Syncing from xgodo...
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

          {syncResult && (
            <div className="mt-4 bg-green-900/20 border border-green-600/30 rounded-xl p-4">
              <div className="text-green-400 font-medium mb-1">Sync Complete</div>
              <div className="text-sm text-green-300/70">
                {syncResult.synced} tasks synced — {syncResult.videos} videos ingested — {syncResult.confirmed} confirmed on xgodo
              </div>
            </div>
          )}

          {syncResult && syncResult.synced === 0 && (
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
