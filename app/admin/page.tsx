'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';

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

  // Admin section tabs
  const [adminSection, setAdminSection] = useState<'general' | 'niche' | 'enrich' | 'tokens' | 'agents'>('general');

  // Agents tab state
  const [agentsData, setAgentsData] = useState<{
    totalActive: number;
    byKeyword: Array<{ keyword: string; active: number; taskIds: string[] }>;
    tasks: Array<{ id: string; keyword: string; startedAt: string | null }>;
  } | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsAutoRefresh, setAgentsAutoRefresh] = useState(true);
  const [agentsDeploy, setAgentsDeploy] = useState({
    keyword: '', threads: 2, apiKey: '', loopNumber: 30,
    maxSearchResults: 50, maxSuggestedResults: 50, rofeAPIKey: '',
  });
  const [agentsDeployMsg, setAgentsDeployMsg] = useState<string | null>(null);

  // Admin tokens state
  const [adminTokens, setAdminTokens] = useState<Array<{ id: string; name: string; tokenPreview: string; lastUsedAt: string | null; createdAt: string }>>([]);
  const [newAdminToken, setNewAdminToken] = useState<string | null>(null);
  const [adminTokenCopied, setAdminTokenCopied] = useState(false);

  // Niche Explorer embedding state
  const [embeddingStats, setEmbeddingStats] = useState<{
    totalVideos: number; embedded: number; notEmbedded: number; apiKeysConfigured: number; model: string;
    job: { id: number; status: string; total_needed: number; processed: number; errors: number; current_batch: number; total_batches: number; error_message: string | null; started_at: string; completed_at: string | null } | null;
    keys?: Array<{ key: string; proxy: string; banned: boolean; banExpiresIn: number | null }>;
    proxy?: { total: number; online: number; cached: boolean; cacheAge: number; current: { deviceId: string; networkType: string } | null };
    keywordCoverage?: Array<{ keyword: string; total: number; embedded: number; pct: number }>;
  } | null>(null);

  // Poll embedding progress
  useEffect(() => {
    if (adminSection !== 'niche') return;
    const fetchStats = () => {
      fetch('/api/niche-spy/embeddings').then(r => r.json()).then(setEmbeddingStats).catch(() => {});
      fetch('/api/niche-spy/enrich').then(r => r.json()).then(setNicheEnrichStats).catch(() => {});
    };
    fetchStats();
    const iv = setInterval(fetchStats, 3000);
    return () => clearInterval(iv);
  }, [adminSection]);

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
    { id: 'clipping', label: 'Clipping' },
    { id: 'niche', label: 'Niche Explorer' },
  ];
  const [visibleTabs, setVisibleTabs] = useState<string[]>(['feed']);
  const [tabsSaving, setTabsSaving] = useState(false);
  const [tabsSaved, setTabsSaved] = useState(false);

  // Niche Explorer config
  const [nicheGoogleApiKeys, setNicheGoogleApiKeys] = useState('');
  const [nicheEmbeddingModel, setNicheEmbeddingModel] = useState('text-embedding-004');
  const [nicheBatchSize, setNicheBatchSize] = useState(50);
  const [nicheLimit, setNicheLimit] = useState(5000);
  const [nichePriorityKeywords, setNichePriorityKeywords] = useState('');
  const [nicheYtApiKeys, setNicheYtApiKeys] = useState('');
  const [nicheEnrichStats, setNicheEnrichStats] = useState<{
    need_enrichment: string; never_enriched: string; missing_likes: string; missing_subs: string;
    proxyStats: { total: number; online: number };
  } | null>(null);
  const [nicheEnrichRunning, setNicheEnrichRunning] = useState(false);
  const [nicheThreads, setNicheThreads] = useState(2);

  // Config state
  const [xgodoToken, setXgodoToken] = useState('');
  const [nicheSpyToken, setNicheSpyToken] = useState('');
  const [xgodoJobId, setXgodoJobId] = useState('');
  const [xgodoProxyHost, setXgodoProxyHost] = useState('ec2-44-200-81-136.compute-1.amazonaws.com');
  const [xgodoProxyPort, setXgodoProxyPort] = useState('1082');
  const [channelCheckApiKey, setChannelCheckApiKey] = useState('');
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

  // Auto-schedule state
  const [autoSchedEnabled, setAutoSchedEnabled] = useState(false);
  const [autoSchedInterval, setAutoSchedInterval] = useState('60');
  const [autoSchedTaskCount, setAutoSchedTaskCount] = useState('10');
  const [autoSchedNumVideos, setAutoSchedNumVideos] = useState('20');
  const [autoSchedFetchAge, setAutoSchedFetchAge] = useState(true);
  const [autoSchedFetchVideoCount, setAutoSchedFetchVideoCount] = useState(false);
  const [lastAutoSchedule, setLastAutoSchedule] = useState<{ at: string; result: { scheduled: number; error?: string } } | null>(null);

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
        setNicheSpyToken(data.config.xgodo_niche_spy_token || '');
        setNicheGoogleApiKeys(data.config.niche_google_api_keys || '');
        setNicheEmbeddingModel(data.config.niche_embedding_model || 'text-embedding-004');
        setNichePriorityKeywords(data.config.niche_priority_keywords || '');
        setNicheYtApiKeys(data.config.niche_yt_api_keys || '');
        setXgodoJobId(data.config.xgodo_shorts_spy_job_id || '');
        setXgodoProxyHost(data.config.xgodo_proxy_host || 'ec2-44-200-81-136.compute-1.amazonaws.com');
        setXgodoProxyPort(data.config.xgodo_proxy_port || '1082');
        setChannelCheckApiKey(data.config.channel_check_api_key || '');
        setSchedYoutubeKey(data.config.youtube_api_key || '');
        // Auto-schedule config
        setAutoSchedEnabled(data.config.auto_schedule_enabled === 'true');
        setAutoSchedInterval(data.config.auto_schedule_interval_minutes || '60');
        setAutoSchedTaskCount(data.config.auto_schedule_task_count || '10');
        setAutoSchedNumVideos(data.config.auto_schedule_num_videos || '20');
        setAutoSchedFetchAge(data.config.auto_schedule_fetch_age !== 'false');
        setAutoSchedFetchVideoCount(data.config.auto_schedule_fetch_video_count === 'true');
        if (data.config.last_auto_schedule_at) {
          try {
            setLastAutoSchedule({
              at: data.config.last_auto_schedule_at,
              result: JSON.parse(data.config.last_auto_schedule_result || '{}'),
            });
          } catch { /* skip */ }
        }
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

  const saveAutoSchedConfig = async (overrides: Record<string, string>) => {
    await fetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: overrides }),
    });
  };

  const formatTimeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
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
            xgodo_niche_spy_token: nicheSpyToken,
            xgodo_proxy_host: xgodoProxyHost,
            xgodo_proxy_port: xgodoProxyPort,
            niche_google_api_keys: nicheGoogleApiKeys,
            niche_embedding_model: nicheEmbeddingModel,
            niche_priority_keywords: nichePriorityKeywords,
            niche_yt_api_keys: nicheYtApiKeys,
            xgodo_shorts_spy_job_id: xgodoJobId,
            channel_check_api_key: channelCheckApiKey,
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

        {/* Admin Section Tabs */}
        <div className="flex gap-2 mb-8">
          <button onClick={() => setAdminSection('general')}
            className={`px-5 py-2.5 rounded-xl text-sm font-medium transition ${adminSection === 'general' ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
            General
          </button>
          <button onClick={() => setAdminSection('niche')}
            className={`px-5 py-2.5 rounded-xl text-sm font-medium transition ${adminSection === 'niche' ? 'bg-amber-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
            Niche Explorer
          </button>
          <button onClick={() => setAdminSection('enrich')}
            className={`px-5 py-2.5 rounded-xl text-sm font-medium transition ${adminSection === 'enrich' ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
            Enrich Data
          </button>
          <button onClick={() => { setAdminSection('tokens'); fetch('/api/admin/admin-tokens').then(r => r.json()).then(d => setAdminTokens(d.tokens || [])).catch(() => {}); }}
            className={`px-5 py-2.5 rounded-xl text-sm font-medium transition ${adminSection === 'tokens' ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
            Admin Tokens
          </button>
          <button onClick={() => { setAdminSection('agents'); setAgentsLoading(true); fetch('/api/admin/agents').then(r => r.json()).then(d => { setAgentsData(d); setAgentsLoading(false); }).catch(() => setAgentsLoading(false)); }}
            className={`px-5 py-2.5 rounded-xl text-sm font-medium transition ${adminSection === 'agents' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
            Agents
            {agentsData && agentsData.totalActive > 0 && (
              <span className="ml-1.5 bg-green-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">{agentsData.totalActive}</span>
            )}
          </button>
        </div>

        <div style={{ display: adminSection === 'general' ? 'block' : 'none' }}>
        {/* Navigation */}
        <div className="space-y-3 mb-8">
          <a
            href="/admin/x-posts"
            className="block bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-purple-600/50 hover:bg-gray-900/80 transition group"
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
          <a
            href="/admin/deep-analysis"
            className="block bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-cyan-600/50 hover:bg-gray-900/80 transition group"
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-white font-bold text-lg group-hover:text-cyan-400 transition">Deep Analysis</h2>
                <p className="text-gray-500 text-sm mt-0.5">AI pipeline: triage &rarr; storyboard &rarr; synthesis &rarr; post generation</p>
              </div>
              <svg className="w-5 h-5 text-gray-600 group-hover:text-cyan-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </a>
          <a
            href="/admin/sync"
            className="block bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-red-600/50 hover:bg-gray-900/80 transition group"
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-white font-bold text-lg group-hover:text-red-400 transition">Sync Monitor</h2>
                <p className="text-gray-500 text-sm mt-0.5">Run data syncs with full visibility — before/after stats &amp; live progress</p>
              </div>
              <svg className="w-5 h-5 text-gray-600 group-hover:text-red-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
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

          {/* Auto-Schedule Autopilot */}
          <div className="border-t border-gray-800 pt-5 mt-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-300">Autopilot</h3>
                <p className="text-xs text-gray-500 mt-0.5">Automatically schedule tasks on a timer, even with browser closed</p>
              </div>
              <button
                onClick={async () => {
                  const next = !autoSchedEnabled;
                  setAutoSchedEnabled(next);
                  await saveAutoSchedConfig({ auto_schedule_enabled: next ? 'true' : 'false' });
                }}
                className={`relative w-12 h-6 rounded-full transition-colors ${autoSchedEnabled ? 'bg-green-600' : 'bg-gray-700'}`}
              >
                <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${autoSchedEnabled ? 'translate-x-6' : ''}`} />
              </button>
            </div>

            {autoSchedEnabled && (
              <div className="space-y-3 bg-gray-800/30 rounded-xl p-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Every</label>
                    <div className="flex gap-1 items-center">
                      {[
                        { label: '30m', value: '30' },
                        { label: '1h', value: '60' },
                        { label: '2h', value: '120' },
                        { label: '6h', value: '360' },
                        { label: '12h', value: '720' },
                      ].map(opt => (
                        <button
                          key={opt.value}
                          onClick={async () => {
                            setAutoSchedInterval(opt.value);
                            await saveAutoSchedConfig({ auto_schedule_interval_minutes: opt.value });
                          }}
                          className={`px-2.5 py-1 text-xs font-medium rounded-lg transition ${
                            autoSchedInterval === opt.value
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={!['30','60','120','360','720'].includes(autoSchedInterval) ? autoSchedInterval : ''}
                        placeholder="min"
                        onChange={(e) => setAutoSchedInterval(e.target.value)}
                        onBlur={async () => {
                          const val = String(Math.max(1, Math.min(1440, parseInt(autoSchedInterval) || 60)));
                          setAutoSchedInterval(val);
                          await saveAutoSchedConfig({ auto_schedule_interval_minutes: val });
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        className={`w-14 px-2 py-1 text-xs font-mono rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                          !['30','60','120','360','720'].includes(autoSchedInterval)
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'bg-gray-800 border-gray-700 text-gray-400'
                        }`}
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Tasks</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={autoSchedTaskCount}
                      onChange={(e) => setAutoSchedTaskCount(e.target.value)}
                      onBlur={async () => {
                        const val = String(Math.max(1, Math.min(100, parseInt(autoSchedTaskCount) || 10)));
                        setAutoSchedTaskCount(val);
                        await saveAutoSchedConfig({ auto_schedule_task_count: val });
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      className="w-16 px-2 py-1 bg-gray-800 border border-gray-700 rounded-lg text-white text-xs text-center font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Videos</label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={autoSchedNumVideos}
                      onChange={(e) => setAutoSchedNumVideos(e.target.value)}
                      onBlur={async () => {
                        const val = String(Math.max(1, Math.min(50, parseInt(autoSchedNumVideos) || 20)));
                        setAutoSchedNumVideos(val);
                        await saveAutoSchedConfig({ auto_schedule_num_videos: val });
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      className="w-16 px-2 py-1 bg-gray-800 border border-gray-700 rounded-lg text-white text-xs text-center font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoSchedFetchAge}
                      onChange={async (e) => {
                        setAutoSchedFetchAge(e.target.checked);
                        await saveAutoSchedConfig({ auto_schedule_fetch_age: e.target.checked ? 'true' : 'false' });
                      }}
                      className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                    />
                    <span className="text-xs text-gray-400">Channel age</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoSchedFetchVideoCount}
                      onChange={async (e) => {
                        setAutoSchedFetchVideoCount(e.target.checked);
                        await saveAutoSchedConfig({ auto_schedule_fetch_video_count: e.target.checked ? 'true' : 'false' });
                      }}
                      className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                    />
                    <span className="text-xs text-gray-400">Video count</span>
                  </label>
                </div>

                {lastAutoSchedule && (
                  <div className="flex items-center gap-3 text-xs pt-2 border-t border-gray-700/50">
                    <span className="text-gray-500">Last run:</span>
                    <span className="text-gray-300">{formatTimeAgo(lastAutoSchedule.at)}</span>
                    {lastAutoSchedule.result && !lastAutoSchedule.result.error && (
                      <>
                        <span className="text-gray-600">·</span>
                        <span className="text-blue-400">{lastAutoSchedule.result.scheduled} tasks scheduled</span>
                      </>
                    )}
                    {lastAutoSchedule.result?.error && (
                      <span className="text-red-400">{lastAutoSchedule.result.error}</span>
                    )}
                  </div>
                )}
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
              <label className="block text-sm font-medium text-gray-300 mb-1">Niche Spy Token</label>
              <input
                type="password"
                value={nicheSpyToken}
                onChange={(e) => setNicheSpyToken(e.target.value)}
                placeholder="xgodo JWT for niche spy job"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-300 mb-1">Proxy Host</label>
                <input
                  type="text"
                  value={xgodoProxyHost}
                  onChange={(e) => setXgodoProxyHost(e.target.value)}
                  placeholder="ec2-44-200-81-136.compute-1.amazonaws.com"
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Port</label>
                <input
                  type="text"
                  value={xgodoProxyPort}
                  onChange={(e) => setXgodoProxyPort(e.target.value)}
                  placeholder="1082"
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Channel Check API Key</label>
              <input
                type="password"
                value={channelCheckApiKey}
                onChange={(e) => setChannelCheckApiKey(e.target.value)}
                placeholder="API key for /api/feed-spy/check-channel"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">Used by xgodo workers to check if a channel is already known</p>
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

        <div style={{ display: adminSection === 'niche' ? 'block' : 'none' }}>
        {/* Niche Explorer Admin Tab */}
        <div className="space-y-6">
          {/* Embedding Stats */}
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-4">Embedding Generation</h2>

            {embeddingStats && (
              <div className="space-y-4">
                {/* Stats grid */}
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-white">{embeddingStats.totalVideos.toLocaleString()}</div>
                    <div className="text-xs text-gray-500">Total Videos</div>
                  </div>
                  <div className="bg-green-900/20 border border-green-800/30 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-green-400">{embeddingStats.embedded.toLocaleString()}</div>
                    <div className="text-xs text-gray-500">Embedded</div>
                  </div>
                  <div className="bg-yellow-900/20 border border-yellow-800/30 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-yellow-400">{embeddingStats.notEmbedded.toLocaleString()}</div>
                    <div className="text-xs text-gray-500">Remaining</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-blue-400">{embeddingStats.apiKeysConfigured}</div>
                    <div className="text-xs text-gray-500">API Keys</div>
                  </div>
                </div>

                {/* Progress bar */}
                {embeddingStats.totalVideos > 0 && (
                  <div>
                    <div className="flex justify-between text-xs text-gray-400 mb-1">
                      <span>{Math.round((embeddingStats.embedded / embeddingStats.totalVideos) * 100)}% embedded</span>
                      <span>{embeddingStats.model}</span>
                    </div>
                    <div className="h-2.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-green-500 rounded-full transition-all duration-500"
                        style={{ width: `${(embeddingStats.embedded / embeddingStats.totalVideos) * 100}%` }} />
                    </div>
                  </div>
                )}

                {/* Current job status */}
                {embeddingStats.job && (
                  <div className={`border rounded-lg px-4 py-3 ${
                    embeddingStats.job.status === 'running' ? 'bg-blue-900/20 border-blue-600/40' :
                    embeddingStats.job.status === 'done' ? 'bg-green-900/20 border-green-600/40' :
                    embeddingStats.job.status === 'error' ? 'bg-red-900/20 border-red-600/40' :
                    'bg-gray-900/20 border-gray-700'
                  }`}>
                    <div className="flex items-center gap-3">
                      {embeddingStats.job.status === 'running' && (
                        <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                      )}
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-white">
                            {embeddingStats.job.status === 'running' ? `Batch ${embeddingStats.job.current_batch}/${embeddingStats.job.total_batches}` :
                             embeddingStats.job.status === 'done' ? 'Complete' :
                             embeddingStats.job.status === 'error' ? 'Error' :
                             embeddingStats.job.status}
                          </span>
                          <span className="text-xs text-gray-400">
                            {embeddingStats.job.processed}/{embeddingStats.job.total_needed} processed
                            {embeddingStats.job.errors > 0 && ` · ${embeddingStats.job.errors} errors`}
                          </span>
                        </div>
                        {embeddingStats.job.status === 'running' && embeddingStats.job.total_needed > 0 && (
                          <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden mt-2">
                            <div className="h-full bg-blue-500 rounded-full transition-all"
                              style={{ width: `${(embeddingStats.job.processed / embeddingStats.job.total_needed) * 100}%` }} />
                          </div>
                        )}
                        {embeddingStats.job.error_message && (
                          <p className="text-xs text-yellow-400 mt-1">{embeddingStats.job.error_message}</p>
                        )}
                        <p className="text-[10px] text-gray-500 mt-1">
                          Started: {new Date(embeddingStats.job.started_at).toLocaleString()}
                          {embeddingStats.job.completed_at && ` · Completed: ${new Date(embeddingStats.job.completed_at).toLocaleString()}`}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Controls + Action buttons */}
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Batch</label>
                    <select value={nicheBatchSize} onChange={e => setNicheBatchSize(parseInt(e.target.value))}
                      className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                      <option value={5}>5</option>
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Limit</label>
                    <select value={nicheLimit} onChange={e => setNicheLimit(parseInt(e.target.value))}
                      className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                      <option value={100}>100</option>
                      <option value={500}>500</option>
                      <option value={1000}>1K</option>
                      <option value={2000}>2K</option>
                      <option value={5000}>5K</option>
                      <option value={10000}>10K</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Threads</label>
                    <select value={nicheThreads} onChange={e => setNicheThreads(parseInt(e.target.value))}
                      className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                      <option value={5}>5</option>
                      <option value={10}>10</option>
                    </select>
                  </div>
                  <button
                    onClick={async () => {
                      await fetch('/api/niche-spy/embeddings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: nicheLimit, batchSize: nicheBatchSize, threads: nicheThreads }) });
                    }}
                    disabled={embeddingStats.job?.status === 'running'}
                    className="px-5 py-2.5 bg-amber-600 text-white font-semibold rounded-xl hover:bg-amber-700 disabled:opacity-50 transition"
                  >
                    {embeddingStats.job?.status === 'running' ? 'Running...' : 'Generate Embeddings'}
                  </button>
                  {embeddingStats.job?.status === 'running' && (
                    <button
                      onClick={async () => { await fetch('/api/niche-spy/embeddings', { method: 'DELETE' }); }}
                      className="px-5 py-2.5 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 transition"
                    >
                      Cancel
                    </button>
                  )}
                </div>

                {/* Key & Proxy Status Table */}
                {(embeddingStats.keys || embeddingStats.proxy) && (
                  <div className="grid grid-cols-2 gap-4 mt-4">
                    {/* API Keys */}
                    {embeddingStats.keys && embeddingStats.keys.length > 0 && (
                      <div className="bg-gray-900/50 rounded-lg p-3">
                        <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">API Keys</h4>
                        <div className="space-y-1.5">
                          {embeddingStats.keys.map((k, i) => (
                            <div key={i} className="flex items-center justify-between text-xs">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-gray-300">{k.key}</span>
                                <span className="text-blue-400 font-mono">→ {k.proxy}</span>
                              </div>
                              {k.banned ? (
                                <span className="text-red-400 flex items-center gap-1">
                                  <span className="w-2 h-2 bg-red-500 rounded-full" />
                                  banned ({k.banExpiresIn}s)
                                </span>
                              ) : (
                                <span className="text-green-400 flex items-center gap-1">
                                  <span className="w-2 h-2 bg-green-500 rounded-full" />
                                  active
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Proxy Status */}
                    {embeddingStats.proxy && (
                      <div className="bg-gray-900/50 rounded-lg p-3">
                        <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Proxy</h4>
                        <div className="space-y-1.5 text-xs">
                          <div className="flex justify-between">
                            <span className="text-gray-400">Available</span>
                            <span className="text-white font-medium">{embeddingStats.proxy.total} devices</span>
                          </div>
                          {embeddingStats.proxy.current && (
                            <div className="flex justify-between">
                              <span className="text-gray-400">Current</span>
                              <span className="text-blue-400 font-mono">{embeddingStats.proxy.current.deviceId}... ({embeddingStats.proxy.current.networkType})</span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span className="text-gray-400">Cache</span>
                            <span className="text-gray-300">{embeddingStats.proxy.cached ? `fresh (${embeddingStats.proxy.cacheAge}s)` : 'stale'}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Per-keyword embedding coverage */}
                {embeddingStats.keywordCoverage && embeddingStats.keywordCoverage.length > 0 && (
                  <div className="mt-4 bg-gray-900/50 rounded-lg p-3">
                    <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Embedding Coverage by Keyword</h4>
                    <div className="space-y-1.5 max-h-60 overflow-y-auto">
                      {embeddingStats.keywordCoverage.map(k => (
                        <div key={k.keyword} className="flex items-center gap-2 text-xs">
                          <span className="text-gray-400 w-40 truncate">{k.keyword}</span>
                          <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${k.pct >= 100 ? 'bg-green-500' : k.pct > 0 ? 'bg-amber-500' : 'bg-gray-600'}`}
                              style={{ width: `${k.pct}%` }} />
                          </div>
                          <span className={`font-mono w-10 text-right ${k.pct >= 100 ? 'text-green-400' : k.pct > 0 ? 'text-amber-400' : 'text-gray-600'}`}>
                            {k.pct}%
                          </span>
                          <span className="text-gray-600 w-16 text-right">{k.embedded}/{k.total}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sub-niche Clustering */}
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-2">Sub-niche Clustering</h2>
            <p className="text-xs text-gray-500 mb-4">Run HDBSCAN clustering on video embeddings to discover sub-niches within a keyword.</p>

            <div className="flex items-center gap-3 mb-4">
              <select id="cluster-keyword" className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white text-sm flex-1">
                {embeddingStats?.keywordCoverage?.map((k: { keyword: string; embedded: number }) => (
                  <option key={k.keyword} value={k.keyword}>{k.keyword} ({k.embedded} embedded)</option>
                ))}
              </select>
              <button
                onClick={async () => {
                  const kw = (document.getElementById('cluster-keyword') as HTMLSelectElement)?.value;
                  if (!kw) return;
                  const res = await fetch('/api/niche-spy/clusters', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keyword: kw }),
                  });
                  const data = await res.json();
                  alert(data.ok ? `Clustering started (run #${data.runId}, ${data.embeddedVideos} videos)` : `Error: ${data.error}`);
                }}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-sm font-medium"
              >
                Run Clustering
              </button>
              <button
                onClick={async () => {
                  const kw = (document.getElementById('cluster-keyword') as HTMLSelectElement)?.value;
                  if (!kw) return;
                  const res = await fetch('/api/niche-spy/clusters', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keyword: kw, action: 'label' }),
                  });
                  const data = await res.json();
                  alert(data.ok ? 'AI labeling started' : `Error: ${data.error}`);
                }}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-medium"
              >
                Upgrade Labels
              </button>
            </div>
          </div>

          {/* Keyword Management */}
          {embeddingStats?.keywordCoverage && (
            <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
              <h2 className="text-lg font-bold text-white mb-4">Keyword Management</h2>
              <p className="text-xs text-gray-500 mb-3">Delete a keyword to remove it and ALL associated videos, embeddings, and saturation data.</p>
              <div className="space-y-1.5 max-h-80 overflow-y-auto">
                {embeddingStats.keywordCoverage.map(k => (
                  <div key={k.keyword} className="flex items-center gap-3 text-sm bg-gray-900/30 rounded-lg px-3 py-2">
                    <span className="text-gray-300 flex-1 truncate">{k.keyword}</span>
                    <span className="text-xs text-gray-500 w-16 text-right">{k.total} vids</span>
                    <span className={`text-xs w-10 text-right ${k.pct >= 100 ? 'text-green-400' : k.pct > 0 ? 'text-amber-400' : 'text-gray-600'}`}>
                      {k.pct}%
                    </span>
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete "${k.keyword}" and all ${k.total} videos?`)) return;
                        await fetch('/api/niche-spy/keywords', {
                          method: 'DELETE',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ keyword: k.keyword }),
                        });
                        // Refresh stats
                        fetch('/api/niche-spy/embeddings').then(r => r.json()).then(setEmbeddingStats).catch(() => {});
                      }}
                      className="text-red-500/60 hover:text-red-400 transition"
                      title={`Delete ${k.keyword}`}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* API Keys Config */}
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-4">Configuration</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Google API Keys (for embeddings)</label>
                <textarea
                  value={nicheGoogleApiKeys}
                  onChange={(e) => setNicheGoogleApiKeys(e.target.value)}
                  placeholder="One API key per line. Keys are rotated automatically."
                  rows={4}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Free Google AI keys for gemini-embedding. One per line, rotated automatically.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Embedding Model</label>
                <select
                  value={nicheEmbeddingModel}
                  onChange={(e) => setNicheEmbeddingModel(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm"
                >
                  <option value="gemini-embedding-001">gemini-embedding-001 (3072d, stable)</option>
                  <option value="gemini-embedding-2-preview">gemini-embedding-2-preview (3072d, latest)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Priority Keywords (embed first)</label>
                <textarea
                  value={nichePriorityKeywords}
                  onChange={(e) => setNichePriorityKeywords(e.target.value)}
                  placeholder="One keyword per line. These niches get embedded first."
                  rows={3}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Videos matching these keywords are embedded before others. One per line.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Niche Spy xgodo Token</label>
                <input
                  type="password"
                  value={nicheSpyToken}
                  onChange={(e) => setNicheSpyToken(e.target.value)}
                  placeholder="xgodo JWT for niche spy job"
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm"
                />
              </div>
              <div className="flex items-center gap-3">
                <button onClick={saveConfig} disabled={configSaving}
                  className="px-5 py-2.5 bg-amber-600 text-white font-semibold rounded-xl hover:bg-amber-700 disabled:opacity-50 transition">
                  {configSaving ? 'Saving...' : 'Save Config'}
                </button>
                {configSaved && <span className="text-green-400 text-sm">Saved</span>}
              </div>
            </div>
          </div>
        </div>
        </div>

        {/* Enrich Data Tab */}
        <div style={{ display: adminSection === 'enrich' ? 'block' : 'none' }}>
        <div className="space-y-6">
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-4">Enrich Data (YouTube Data API)</h2>

            {nicheEnrichStats && (
              <div className="space-y-4">
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-yellow-400">{parseInt(nicheEnrichStats.need_enrichment).toLocaleString()}</div>
                    <div className="text-xs text-gray-500">Need Enrichment</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-orange-400">{parseInt(nicheEnrichStats.never_enriched).toLocaleString()}</div>
                    <div className="text-xs text-gray-500">Never Enriched</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-red-400">{parseInt(nicheEnrichStats.missing_subs).toLocaleString()}</div>
                    <div className="text-xs text-gray-500">Missing Subs</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-blue-400">{nicheEnrichStats.proxyStats?.total || 0}</div>
                    <div className="text-xs text-gray-500">Proxies</div>
                  </div>
                </div>

                <div className="flex gap-3 items-center">
                  <button
                    onClick={async () => {
                      setNicheEnrichRunning(true);
                      try {
                        const res = await fetch('/api/niche-spy/enrich', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ limit: 500 }),
                        });
                        const reader = res.body?.getReader();
                        if (reader) { while (!(await reader.read()).done) {} }
                      } catch { /* ignore */ }
                      setNicheEnrichRunning(false);
                    }}
                    disabled={nicheEnrichRunning}
                    className="px-5 py-2.5 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition"
                  >
                    {nicheEnrichRunning ? 'Enriching...' : 'Enrich Data'}
                  </button>
                  <span className="text-xs text-gray-500">Fills views, likes, subs, exact dates, channel age via YT Data API + proxies</span>
                </div>
              </div>
            )}
          </div>

          {/* YouTube Data API Keys */}
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-4">YouTube Data API Keys</h2>
            <div className="space-y-4">
              <div>
                <textarea
                  value={nicheYtApiKeys}
                  onChange={(e) => setNicheYtApiKeys(e.target.value)}
                  placeholder="One YouTube Data API v3 key per line. Keys are rotated automatically."
                  rows={4}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Used for enrichment (views, subs, dates, channel age). One per line, rotated per batch.</p>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={saveConfig} disabled={configSaving}
                  className="px-5 py-2.5 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition">
                  {configSaving ? 'Saving...' : 'Save Keys'}
                </button>
                {configSaved && <span className="text-green-400 text-sm">Saved</span>}
              </div>
            </div>
          </div>
        </div>
        </div>

        {/* Admin Tokens Tab */}
        <div style={{ display: adminSection === 'tokens' ? 'block' : 'none' }}>
        <div className="space-y-6">
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-2">Admin API Tokens</h2>
            <p className="text-gray-400 text-sm mb-4">Generate tokens for admin-level API access. Prefix: <code className="text-red-400">hba_</code></p>

            {/* New token display */}
            {newAdminToken && (
              <div className="bg-red-900/20 border border-red-600 rounded-lg p-4 mb-4">
                <p className="text-sm text-red-300 mb-2 font-medium">Token created — copy now, won&apos;t be shown again:</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-black/40 text-red-300 px-3 py-2 rounded text-sm font-mono break-all select-all">{newAdminToken}</code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(newAdminToken); setAdminTokenCopied(true); setTimeout(() => setAdminTokenCopied(false), 2000); }}
                    className="px-3 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm flex-shrink-0"
                  >{adminTokenCopied ? 'Copied!' : 'Copy'}</button>
                </div>
              </div>
            )}

            {/* Existing tokens */}
            {adminTokens.length > 0 && (
              <div className="space-y-2 mb-4">
                <h3 className="text-sm font-medium text-gray-300">Active admin tokens</h3>
                {adminTokens.map(t => (
                  <div key={t.id} className="flex items-center justify-between bg-gray-900/50 border border-gray-700 rounded-lg px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-white font-mono">{t.tokenPreview}</span>
                      <span className="text-xs text-gray-500">{t.name}</span>
                      {t.lastUsedAt && <span className="text-xs text-gray-600">Used: {new Date(t.lastUsedAt).toLocaleDateString()}</span>}
                    </div>
                    <button
                      onClick={async () => {
                        await fetch(`/api/admin/admin-tokens?id=${t.id}`, { method: 'DELETE' });
                        setAdminTokens(prev => prev.filter(x => x.id !== t.id));
                      }}
                      className="text-red-400 hover:text-red-300 text-sm"
                    >Revoke</button>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={async () => {
                const res = await fetch('/api/admin/admin-tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'admin-api' }) });
                const data = await res.json();
                if (data.token) {
                  setNewAdminToken(data.token);
                  const listRes = await fetch('/api/admin/admin-tokens');
                  setAdminTokens((await listRes.json()).tokens || []);
                }
              }}
              className="px-5 py-2.5 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 transition"
            >Generate Admin Token</button>

            <div className="bg-gray-900/30 border border-gray-700 rounded-lg p-4 mt-4">
              <p className="text-xs text-gray-400 mb-2"><strong>Usage:</strong></p>
              <code className="text-xs text-gray-300 block">Authorization: Bearer hba_your_token_here</code>
              <p className="text-xs text-gray-500 mt-2">Admin tokens work with: keyword delete, niche count, title exists, and all admin endpoints.</p>
            </div>
          </div>
        </div>
        </div>

        {/* Agents Tab */}
        <div style={{ display: adminSection === 'agents' ? 'block' : 'none' }}>
        <AgentsTab
          data={agentsData}
          loading={agentsLoading}
          autoRefresh={agentsAutoRefresh}
          setAutoRefresh={setAgentsAutoRefresh}
          deploy={agentsDeploy}
          setDeploy={setAgentsDeploy}
          deployMsg={agentsDeployMsg}
          setDeployMsg={setAgentsDeployMsg}
          onRefresh={() => {
            setAgentsLoading(true);
            fetch('/api/admin/agents').then(r => r.json()).then(d => { setAgentsData(d); setAgentsLoading(false); }).catch(() => setAgentsLoading(false));
          }}
          active={adminSection === 'agents'}
        />
        </div>
      </div>
    </div>
  );
}

interface DeployConfig {
  keyword: string; threads: number; apiKey: string; loopNumber: number;
  maxSearchResults: number; maxSuggestedResults: number; rofeAPIKey: string;
}

function AgentsTab({ data, loading, autoRefresh, setAutoRefresh, deploy, setDeploy, deployMsg, setDeployMsg, onRefresh, active }: {
  data: { totalActive: number; byKeyword: Array<{ keyword: string; active: number; taskIds: string[] }>; tasks: Array<{ id: string; keyword: string; startedAt: string | null }> } | null;
  loading: boolean;
  autoRefresh: boolean;
  setAutoRefresh: (v: boolean) => void;
  deploy: DeployConfig;
  setDeploy: React.Dispatch<React.SetStateAction<DeployConfig>>;
  deployMsg: string | null;
  setDeployMsg: (v: string | null) => void;
  onRefresh: () => void;
  active: boolean;
}) {
  // Load defaults from admin config on first render
  useEffect(() => {
    if (!active) return;
    fetch('/api/admin/config').then(r => r.json()).then(d => {
      if (d.config) {
        setDeploy(prev => ({
          ...prev,
          apiKey: prev.apiKey || d.config.agent_api_key || '',
          rofeAPIKey: prev.rofeAPIKey || d.config.agent_rofe_api_key || '',
          loopNumber: parseInt(d.config.agent_loop_number) || prev.loopNumber,
          maxSearchResults: parseInt(d.config.agent_max_search_results) || prev.maxSearchResults,
          maxSuggestedResults: parseInt(d.config.agent_max_suggested_results) || prev.maxSuggestedResults,
        }));
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  // Auto-refresh polling
  useEffect(() => {
    if (!active || !autoRefresh) return;
    const interval = setInterval(onRefresh, 5000);
    return () => clearInterval(interval);
  }, [active, autoRefresh, onRefresh]);

  const deployAgents = async () => {
    if (!deploy.keyword.trim()) return;
    setDeployMsg(null);
    try {
      // Save defaults to admin config
      fetch('/api/admin/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: {
          agent_api_key: deploy.apiKey,
          agent_rofe_api_key: deploy.rofeAPIKey,
          agent_loop_number: String(deploy.loopNumber),
          agent_max_search_results: String(deploy.maxSearchResults),
          agent_max_suggested_results: String(deploy.maxSuggestedResults),
        }}),
      }).catch(() => {});

      const res = await fetch('/api/admin/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: deploy.keyword.trim(),
          threads: deploy.threads,
          apiKey: deploy.apiKey,
          loopNumber: deploy.loopNumber,
          maxSearchResultsBeforeFallback: deploy.maxSearchResults,
          maxSuggestedResultsBeforeFallback: deploy.maxSuggestedResults,
          rofeAPIKey: deploy.rofeAPIKey,
        }),
      });
      const d = await res.json();
      if (d.ok) {
        setDeployMsg(`Deployed ${d.deployed} agents for "${d.keyword}"`);
        setTimeout(onRefresh, 2000);
      } else {
        setDeployMsg(`Error: ${d.error}`);
      }
    } catch (err) {
      setDeployMsg(`Error: ${err instanceof Error ? err.message : 'Failed'}`);
    }
    setTimeout(() => setDeployMsg(null), 5000);
  };

  const addThread = async (keyword: string) => {
    try {
      const res = await fetch('/api/admin/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword, threads: 1,
          apiKey: deploy.apiKey, loopNumber: deploy.loopNumber,
          maxSearchResultsBeforeFallback: deploy.maxSearchResults,
          maxSuggestedResultsBeforeFallback: deploy.maxSuggestedResults,
          rofeAPIKey: deploy.rofeAPIKey,
        }),
      });
      const d = await res.json();
      if (d.ok) setTimeout(onRefresh, 2000);
    } catch { /* ok */ }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-white">Agent Monitor</h2>
            <p className="text-gray-400 text-sm">Track and control xgodo data collection agents</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`text-2xl font-bold ${data && data.totalActive > 0 ? 'text-green-400' : 'text-gray-500'}`}>
              {loading ? '...' : data?.totalActive ?? 0}
            </span>
            <span className="text-sm text-gray-400">running</span>
            <label className="flex items-center gap-2 ml-4 cursor-pointer">
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)}
                className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-green-600 focus:ring-green-500" />
              <span className="text-xs text-gray-400">Auto-refresh</span>
            </label>
            <button onClick={onRefresh} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm">
              Refresh
            </button>
          </div>
        </div>

        {/* Per-keyword thread cards */}
        {data && data.byKeyword.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.byKeyword.map(kw => (
              <div key={kw.keyword} className="bg-gray-900/60 border border-gray-700 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-white">{kw.keyword}</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-2xl font-bold text-green-400">{kw.active}</span>
                    <span className="text-xs text-gray-500">threads</span>
                  </div>
                </div>
                <button onClick={() => addThread(kw.keyword)}
                  className="w-8 h-8 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center justify-center text-lg font-bold transition"
                  title="Add 1 thread"
                >+</button>
              </div>
            ))}
          </div>
        ) : !loading ? (
          <div className="text-center py-8 text-gray-500">
            <div className="text-4xl mb-2">🤖</div>
            No active agents. Deploy some below.
          </div>
        ) : (
          <div className="text-center py-8">
            <div className="w-6 h-6 border-2 border-green-400 border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        )}
      </div>

      {/* Deploy Agents */}
      <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
        <h3 className="text-sm font-bold text-white mb-3">Deploy Agents</h3>

        {/* Row 1: Keyword + Threads */}
        <div className="flex items-end gap-3 mb-3">
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">Keyword</label>
            <input type="text" value={deploy.keyword} onChange={e => setDeploy(p => ({ ...p, keyword: e.target.value }))}
              placeholder="e.g. youtube automation"
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500" />
          </div>
          <div className="w-24">
            <label className="block text-xs text-gray-500 mb-1">Threads</label>
            <input type="number" min={1} max={20} value={deploy.threads} onChange={e => setDeploy(p => ({ ...p, threads: parseInt(e.target.value) || 1 }))}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500" />
          </div>
        </div>

        {/* Row 2: API Key */}
        <div className="mb-3">
          <label className="block text-xs text-gray-500 mb-1">API Key</label>
          <input type="password" value={deploy.apiKey} onChange={e => setDeploy(p => ({ ...p, apiKey: e.target.value }))}
            placeholder="sk_live_..."
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 font-mono" />
        </div>

        {/* Row 3: rofeAPIKey */}
        <div className="mb-3">
          <label className="block text-xs text-gray-500 mb-1">rofe API Key</label>
          <input type="password" value={deploy.rofeAPIKey} onChange={e => setDeploy(p => ({ ...p, rofeAPIKey: e.target.value }))}
            placeholder="hba_..."
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 font-mono" />
        </div>

        {/* Row 4: Loop Number + Max Search + Max Suggested */}
        <div className="flex items-end gap-3 mb-4">
          <div className="w-28">
            <label className="block text-xs text-gray-500 mb-1">Loop Number</label>
            <input type="number" min={1} max={100} value={deploy.loopNumber} onChange={e => setDeploy(p => ({ ...p, loopNumber: parseInt(e.target.value) || 30 }))}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div className="w-36">
            <label className="block text-xs text-gray-500 mb-1">Max Search Results</label>
            <input type="number" min={1} max={200} value={deploy.maxSearchResults} onChange={e => setDeploy(p => ({ ...p, maxSearchResults: parseInt(e.target.value) || 50 }))}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div className="w-36">
            <label className="block text-xs text-gray-500 mb-1">Max Suggested Results</label>
            <input type="number" min={1} max={200} value={deploy.maxSuggestedResults} onChange={e => setDeploy(p => ({ ...p, maxSuggestedResults: parseInt(e.target.value) || 50 }))}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500" />
          </div>
          <button onClick={deployAgents}
            className="px-5 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition ml-auto">
            Deploy
          </button>
        </div>
        {deployMsg && (
          <div className={`mt-3 text-sm ${deployMsg.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
            {deployMsg}
          </div>
        )}
      </div>

      {/* Data Collection — Sync + Enrich */}
      <DataCollection />

      {/* Thread Targets (Thermostat) */}
      <ThreadTargets />

      {/* Active Tasks Table */}
      {data && data.tasks.length > 0 && (
        <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
          <h3 className="text-sm font-bold text-white mb-3">Active Tasks ({data.tasks.length})</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-left">
                  <th className="px-3 py-2 text-xs text-gray-500 uppercase">Task ID</th>
                  <th className="px-3 py-2 text-xs text-gray-500 uppercase">Keyword</th>
                  <th className="px-3 py-2 text-xs text-gray-500 uppercase">Running</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {data.tasks.map((t: Record<string, unknown>) => {
                  const dur = t.duration as number | null;
                  const fmtDur = dur != null
                    ? dur < 60 ? `${dur}s` : dur < 3600 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${Math.floor(dur / 3600)}h ${Math.floor((dur % 3600) / 60)}m`
                    : '—';
                  return (
                    <tr key={t.id as string} className="hover:bg-gray-700/20">
                      <td className="px-3 py-2 text-gray-400 font-mono text-xs">{(t.id as string).slice(-8)}</td>
                      <td className="px-3 py-2 text-white">{t.keyword as string}</td>
                      <td className="px-3 py-2 text-green-400 font-mono text-xs">{fmtDur}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Task History Log */}
      <AgentLog />
    </div>
  );
}

/** Thread target manager — set how many threads to maintain per keyword */
function ThreadTargets() {
  const [targets, setTargets] = useState<Array<{
    id: number; keyword: string; target_threads: number; active_threads: number;
    enabled: boolean; last_deployed_at: string | null; last_checked_at: string | null;
  }>>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newTarget, setNewTarget] = useState(6);

  const fetchTargets = useCallback(() => {
    fetch('/api/admin/agents/targets').then(r => r.json()).then(d => {
      if (d.targets) setTargets(d.targets);
    }).catch(() => {});
  }, []);

  useEffect(() => { fetchTargets(); }, [fetchTargets]);

  useEffect(() => {
    const interval = setInterval(fetchTargets, 10000);
    return () => clearInterval(interval);
  }, [fetchTargets]);

  const updateTarget = async (keyword: string, targetThreads: number, enabled: boolean) => {
    await fetch('/api/admin/agents/targets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, targetThreads, enabled }),
    });
    fetchTargets();
  };

  const removeTarget = async (keyword: string) => {
    await fetch('/api/admin/agents/targets', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword }),
    });
    fetchTargets();
  };

  const addTarget = async () => {
    if (!newKeyword.trim()) return;
    await updateTarget(newKeyword.trim(), newTarget, true);
    setNewKeyword('');
  };

  return (
    <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
      <h3 className="text-sm font-bold text-white mb-1">Thread Targets</h3>
      <p className="text-xs text-gray-500 mb-4">Maintain exact thread count per keyword. Thermostat auto-deploys when threads drop below target (60s cooldown).</p>

      {targets.length > 0 && (
        <div className="space-y-2 mb-4">
          {targets.map(t => (
            <div key={t.id} className="flex items-center gap-3 bg-gray-900/60 border border-gray-700 rounded-lg px-4 py-3">
              <button onClick={() => updateTarget(t.keyword, t.target_threads, !t.enabled)}
                className={`w-3 h-3 rounded-full flex-shrink-0 ${t.enabled ? 'bg-green-500' : 'bg-gray-600'}`}
                title={t.enabled ? 'Click to pause' : 'Click to enable'} />
              <span className="text-sm text-white font-medium flex-1">{t.keyword}</span>
              <div className="flex items-center gap-1.5">
                <span className={`text-lg font-bold ${t.active_threads >= t.target_threads ? 'text-green-400' : 'text-yellow-400'}`}>
                  {t.active_threads}
                </span>
                <span className="text-xs text-gray-500">/</span>
                <input type="number" min={0} max={20} value={t.target_threads}
                  onChange={e => updateTarget(t.keyword, parseInt(e.target.value) || 0, t.enabled)}
                  className="w-14 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-white text-sm text-center focus:outline-none focus:border-green-500" />
              </div>
              {t.last_deployed_at && (
                <span className="text-[10px] text-gray-600">
                  deployed {Math.round((Date.now() - new Date(t.last_deployed_at).getTime()) / 1000)}s ago
                </span>
              )}
              <button onClick={() => removeTarget(t.keyword)} className="text-red-400 hover:text-red-300 text-xs">Remove</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">Keyword</label>
          <input type="text" value={newKeyword} onChange={e => setNewKeyword(e.target.value)}
            placeholder="e.g. youtube automation"
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
            onKeyDown={e => e.key === 'Enter' && addTarget()} />
        </div>
        <div className="w-20">
          <label className="block text-xs text-gray-500 mb-1">Threads</label>
          <input type="number" min={1} max={20} value={newTarget} onChange={e => setNewTarget(parseInt(e.target.value) || 6)}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500" />
        </div>
        <button onClick={addTarget}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition">
          Add Target
        </button>
      </div>

      <div className="mt-4 text-[10px] text-gray-600">
        Thermostat: <code className="text-gray-500">GET /api/cron/agents</code> — call every 30-60s via cron.
      </div>
    </div>
  );
}

/** Browsable task history log */
function AgentLog() {
  const [logData, setLogData] = useState<{
    tasks: Array<{ id: string; keyword: string; status: string; workerName: string; firstSeen: string; lastSeen: string; duration: number }>;
    total: number; page: number; totalPages: number;
    stats: { running: number; completed: number; total: number; avgDuration: number; maxDuration: number; minDuration: number };
  } | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');

  const fetchLog = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: '30' });
    if (statusFilter) params.set('status', statusFilter);
    fetch(`/api/admin/agents/log?${params}`).then(r => r.json()).then(d => setLogData(d)).catch(() => {});
  }, [page, statusFilter]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(fetchLog, 30000);
    return () => clearInterval(interval);
  }, [fetchLog]);

  const fmtDur = (s: number) => {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diffH = (now.getTime() - d.getTime()) / 3600000;
    if (diffH < 24) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (!logData) return null;

  return (
    <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-white">Task History</h3>
        <div className="flex items-center gap-3 text-xs">
          {logData.stats.total > 0 && (
            <div className="flex items-center gap-3 text-gray-500">
              <span>Avg: <span className="text-gray-300">{fmtDur(logData.stats.avgDuration)}</span></span>
              <span>Min: <span className="text-gray-300">{fmtDur(logData.stats.minDuration)}</span></span>
              <span>Max: <span className="text-gray-300">{fmtDur(logData.stats.maxDuration)}</span></span>
              <span className="text-green-400">{logData.stats.running} running</span>
              <span>{logData.stats.completed} completed</span>
            </div>
          )}
          <div className="flex gap-1">
            {['', 'running', 'completed'].map(s => (
              <button key={s} onClick={() => { setStatusFilter(s); setPage(1); }}
                className={`px-2 py-0.5 rounded text-[10px] ${statusFilter === s ? 'bg-white/15 text-white' : 'text-gray-600 hover:text-gray-400'}`}>
                {s || 'All'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700 text-left">
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Task ID</th>
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Keyword</th>
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Status</th>
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Duration</th>
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Started</th>
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Ended</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700/50">
            {logData.tasks.map(t => (
              <tr key={t.id} className="hover:bg-gray-700/20">
                <td className="px-3 py-2 text-gray-400 font-mono text-xs">{t.id.slice(-8)}</td>
                <td className="px-3 py-2 text-white text-xs">{t.keyword}</td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.status === 'running' ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-400'}`}>
                    {t.status}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  <span className={t.status === 'running' ? 'text-green-400' : 'text-gray-300'}>{fmtDur(t.duration)}</span>
                </td>
                <td className="px-3 py-2 text-gray-500 text-xs">{fmtTime(t.firstSeen)}</td>
                <td className="px-3 py-2 text-gray-500 text-xs">{t.status === 'completed' ? fmtTime(t.lastSeen) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {logData.totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-gray-500">{logData.total} tasks · Page {logData.page}/{logData.totalPages}</span>
          <div className="flex gap-1">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              className="px-2 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded text-xs">Prev</button>
            <button onClick={() => setPage(p => Math.min(logData.totalPages, p + 1))} disabled={page >= logData.totalPages}
              className="px-2 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded text-xs">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}


/** Data Collection controls — console-style log output */
function DataCollection() {
  const [syncing, setSyncing] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [logs, setLogs] = useState<Array<{ time: string; type: 'info' | 'success' | 'error' | 'data'; msg: string }>>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const log = (type: 'info' | 'success' | 'error' | 'data', msg: string) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => [...prev, { time, type, msg }]);
    setTimeout(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }), 50);
  };

  const runSync = async () => {
    setSyncing(true);
    log('info', '[sync] Starting — fetching completed tasks from xgodo...');
    let totalInserted = 0, totalUpdated = 0, batches = 0;
    try {
      while (true) {
        const res = await fetch('/api/niche-spy/sync', { method: 'POST' });
        const data = await res.json();
        if (data.error) { log('error', `[sync] Error: ${data.error}`); break; }
        batches++;
        totalInserted += data.videosInserted || 0;
        totalUpdated += data.videosUpdated || 0;

        log('data', `[sync] Batch ${batches}: ${data.tasksProcessed || 0} tasks processed, +${data.videosInserted || 0} new, ${data.videosUpdated || 0} updated`);

        if (data.keywordBreakdown) {
          for (const k of data.keywordBreakdown) {
            log('data', `[sync]   └ ${k.keyword}: +${k.new} new / ${k.total} total`);
          }
        }
        if (data.saturation) {
          for (const s of data.saturation.slice(0, 5)) {
            log('data', `[sync]   └ saturation ${s.keyword}: run=${s.runSatPct}% +${s.A} new`);
          }
        }
        if (data.totalLocal) log('info', `[sync] DB total: ${data.totalLocal} videos, ${data.totalKeywords || '?'} keywords`);

        if (data.status === 'idle' || data.tasksProcessed === 0) {
          log('success', `[sync] Complete — +${totalInserted} new, ${totalUpdated} updated across ${batches} batches`);
          break;
        }
        if (data.tasksProcessed < 100) {
          log('success', `[sync] Complete (partial batch) — +${totalInserted} new, ${totalUpdated} updated`);
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      log('error', `[sync] Failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setSyncing(false);
  };

  const runEnrich = async () => {
    setEnriching(true);
    log('info', '[enrich] Checking how many videos need enrichment...');
    let totalV = 0, totalC = 0, totalErr = 0, round = 0;
    try {
      const checkRes = await fetch('/api/niche-spy/enrich');
      const checkData = await checkRes.json();
      const needed = parseInt(checkData.need_enrichment) || 0;
      if (needed === 0) {
        log('success', '[enrich] All videos already enriched.');
        setEnriching(false);
        return;
      }
      const rounds = Math.ceil(needed / 200);
      log('info', `[enrich] ${needed} videos need enrichment (~${rounds} rounds of 200)`);

      while (true) {
        round++;
        const pct = needed > 0 ? Math.round((totalV / needed) * 100) : 0;
        log('info', `[enrich] Round ${round}/${rounds} starting... (${pct}% done, ${needed - totalV} remaining)`);

        const res = await fetch('/api/niche-spy/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 200 }),
        });
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buf = '', rv = 0, rc = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              try {
                const d = JSON.parse(line.slice(6));
                if (d.step === 'videos' && d.done) {
                  rv = d.enriched || 0;
                  log('data', `[enrich]   └ videos: ${rv} enriched`);
                } else if (d.step === 'videos' && d.error) {
                  log('error', `[enrich]   └ video error: ${d.error}`);
                } else if (d.step === 'channels' && !d.done && !d.error) {
                  log('data', `[enrich]   └ fetching subscriber counts...`);
                } else if (d.step === 'channels' && d.done) {
                  rc = d.enriched || 0;
                  log('data', `[enrich]   └ channels: ${rc} subscriber counts fetched`);
                } else if (d.step === 'channels' && d.error) {
                  log('error', `[enrich]   └ channel error: ${d.error}`);
                } else if (d.step === 'complete') {
                  rv = d.enrichedVideos || 0;
                  rc = d.enrichedChannels || 0;
                  totalErr += d.errors || 0;
                  log('success', `[enrich] Round ${round} done: ${rv} videos, ${rc} channels${d.errors ? `, ${d.errors} errors` : ''}`);
                }
              } catch { /* skip */ }
            }
          }
        }
        totalV += rv; totalC += rc;
        if (rv === 0) {
          log('info', '[enrich] No more videos to enrich in this round');
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      log('success', `[enrich] All done! ${totalV} videos, ${totalC} channels enriched across ${round} rounds${totalErr ? `, ${totalErr} errors` : ''}`);
    } catch (err) {
      log('error', `[enrich] Failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setEnriching(false);
  };

  const typeColors: Record<string, string> = {
    info: 'text-blue-300',
    success: 'text-green-400',
    error: 'text-red-400',
    data: 'text-gray-400',
  };

  return (
    <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-bold text-white">Data Collection</h3>
          <p className="text-xs text-gray-500">Pull completed task data from xgodo and enrich with YouTube API.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={runSync} disabled={syncing || enriching}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 text-white rounded-lg text-sm font-medium transition">
            {syncing ? 'Syncing...' : 'Sync'}
          </button>
          <button onClick={runEnrich} disabled={enriching || syncing}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white rounded-lg text-sm font-medium transition">
            {enriching ? 'Enriching...' : 'Enrich'}
          </button>
          {logs.length > 0 && (
            <button onClick={() => setLogs([])}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg text-xs transition">
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Console log */}
      {logs.length > 0 && (
        <div ref={logRef} className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-3 font-mono text-xs max-h-72 overflow-y-auto space-y-0.5">
          {logs.map((l, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-[#555] flex-shrink-0">{l.time}</span>
              <span className={typeColors[l.type] || 'text-gray-400'}>{l.msg}</span>
            </div>
          ))}
          {(syncing || enriching) && (
            <div className="flex items-center gap-2 mt-1">
              <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-blue-300">Processing...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
