'use client';

import React, { useState, useEffect, useCallback } from 'react';
import XPostPreview from '../../../components/admin/XPostPreview';
import XThread from '../../../components/admin/XThread';
import LeaderboardCard from '../../../components/admin/LeaderboardCard';
import ChannelSpotlightCard from '../../../components/admin/ChannelSpotlightCard';

interface Video {
  video_id: string;
  title: string;
  view_count: number;
  like_count: number;
  comment_count: number;
}

interface Channel {
  channel_id: string;
  channel_name: string;
  channel_url: string;
  avatar_url: string | null;
  subscriber_count: number | null;
  total_video_count: number | null;
  channel_creation_date: string;
  first_seen_at: string;
  niche: string;
  age_days: number | null;
  total_views: number;
  velocity: number;
  videos: Video[];
}

interface Stats {
  totalChannels: number;
  totalViews: number;
  avgAgeDays: number;
  topNiche: string;
}

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '?';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function formatAge(days: number | null): string {
  if (days === null) return '?';
  if (days < 30) return `${days} days`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  return `${(days / 365).toFixed(1)} years`;
}

function formatAgeShort(days: number | null): string {
  if (days === null) return '?';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

function getThumbnails(videos: Video[], count = 4): string[] {
  return videos
    .slice(0, count)
    .map(v => `https://img.youtube.com/vi/${v.video_id}/hqdefault.jpg`);
}

function getTopVideo(videos: Video[]): Video | null {
  if (!videos || videos.length === 0) return null;
  return videos.reduce((best, v) =>
    (Number(v.view_count) || 0) > (Number(best.view_count) || 0) ? v : best
  , videos[0]);
}

const HOOKS = [
  'The Shorts algorithm is unreal.',
  'This is just getting started.',
  'Pure organic growth.',
  'No slowing down.',
  'Wild growth rate.',
];

function CollapsibleSection({ title, subtitle, children, defaultOpen = true }: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-5 text-left hover:bg-gray-800/50 transition"
      >
        <div>
          <h3 className="text-white font-bold text-lg">{title}</h3>
          {subtitle && <p className="text-gray-500 text-sm mt-0.5">{subtitle}</p>}
        </div>
        <svg
          className={`w-5 h-5 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-5 pb-5 space-y-4">{children}</div>}
    </div>
  );
}

export default function XPostsPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('');

  // Auth check
  useEffect(() => {
    fetch('/api/admin/auth')
      .then(res => res.json())
      .then(data => { if (data.authenticated) setAuthenticated(true); })
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
    if (data.success) setAuthenticated(true);
    else setLoginError('Invalid credentials');
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/x-posts?date=${date}`);
      const data = await res.json();
      setChannels(data.channels || []);
      setStats(data.stats || null);
    } catch (err) {
      console.error('Failed to fetch x-posts data:', err);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    if (authenticated) fetchData();
  }, [authenticated, fetchData]);

  const showCopyFeedback = (msg: string) => {
    setCopyFeedback(msg);
    setTimeout(() => setCopyFeedback(''), 2000);
  };

  const copyAllTexts = (texts: string[]) => {
    navigator.clipboard.writeText(texts.join('\n\n---\n\n'));
    showCopyFeedback('All tweets copied!');
  };

  // --- Generate post content ---

  // 1. Daily Leaderboard Thread (5 tweets)
  const generateThread = (): { text: string; media?: string[] }[] => {
    if (channels.length === 0) return [];
    const top5 = channels.slice(0, 5);
    const tweets: { text: string; media?: string[] }[] = [];

    // T1
    tweets.push({
      text: `We just discovered ${stats?.totalChannels || channels.length} new YouTube Shorts channels today.\n\nHere are the fastest growing ones`,
      media: [], // leaderboard card rendered separately
    });

    // T2-4: individual channels
    top5.slice(0, 3).forEach((ch, i) => {
      const topVideo = getTopVideo(ch.videos);
      tweets.push({
        text: `${ch.channel_name}\n${ch.niche} · ${formatAge(ch.age_days)} old\n${formatNumber(ch.subscriber_count)} subscribers\nTop video: ${formatNumber(Number(topVideo?.view_count) || 0)} views\n\n${HOOKS[i % HOOKS.length]}`,
        media: getThumbnails(ch.videos, 4),
      });
    });

    // T5
    tweets.push({
      text: `We track these daily at rofe.ai\n\nFollow @rofe_ai for tomorrow's drop`,
    });

    return tweets;
  };

  // 2. Single Banger Post
  const generateSingleBanger = (): { text: string; media: string[] } | null => {
    if (channels.length === 0) return null;
    const ch = channels[0];
    const topVideo = getTopVideo(ch.videos);

    return {
      text: `This Shorts channel didn't exist ${formatAge(ch.age_days)} ago.\n\n${ch.channel_name} — ${ch.niche}\n▸ ${formatNumber(ch.subscriber_count)} subscribers\n▸ ${ch.total_video_count ?? '?'} videos\n▸ Top video: ${formatNumber(Number(topVideo?.view_count) || 0)} views\n\nThe Shorts algorithm is unreal.`,
      media: getThumbnails(ch.videos, 4),
    };
  };

  // 3. Stats-Only Post
  const generateStatsPost = (): { text: string } | null => {
    if (!stats || channels.length === 0) return null;
    const topCh = channels[0];
    return {
      text: `Today's YouTube Shorts discovery:\n\n${stats.totalChannels} new channels found\nAverage age: ${stats.avgAgeDays} days\nCombined views: ${formatNumber(stats.totalViews)}\nTop niche: ${stats.topNiche}\n\nThe fastest one hit ${formatNumber(topCh.subscriber_count)} subs in ${topCh.age_days ?? '?'} days.`,
    };
  };

  // 4. Niche Roundup
  const generateNicheRoundups = (): { niche: string; text: string; media: string[] }[] => {
    const nicheMap: Record<string, Channel[]> = {};
    for (const ch of channels) {
      if (!nicheMap[ch.niche]) nicheMap[ch.niche] = [];
      nicheMap[ch.niche].push(ch);
    }

    return Object.entries(nicheMap)
      .filter(([, chs]) => chs.length >= 2)
      .map(([niche, chs]) => {
        const totalViews = chs.reduce((sum, ch) => sum + ch.total_views, 0);
        const listed = chs.slice(0, 4).map(ch =>
          `• ${ch.channel_name} — ${formatNumber(ch.subscriber_count)} subs (${formatAgeShort(ch.age_days)})`
        ).join('\n');

        return {
          niche,
          text: `${niche} Shorts are exploding.\n\nWe found ${chs.length} channels today:\n${listed}\n\nCombined: ${formatNumber(totalViews)} views`,
          media: getThumbnails(chs[0].videos, 4),
        };
      });
  };

  // --- Render ---

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
            <p className="text-sm text-gray-400 mt-1">rofe.ai control panel</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="text" value={username} onChange={e => setUsername(e.target.value)}
              placeholder="Username"
              className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              autoFocus
            />
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
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

  const threadTweets = generateThread();
  const singleBanger = generateSingleBanger();
  const statsPost = generateStatsPost();
  const nicheRoundups = generateNicheRoundups();

  return (
    <div className="min-h-screen bg-gray-950">
      <div className="max-w-2xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Daily X Posts</h1>
            <p className="text-gray-400 text-sm">Preview &amp; copy post content</p>
          </div>
          <a href="/admin" className="px-4 py-2 bg-gray-800 text-gray-300 rounded-xl hover:bg-gray-700 transition text-sm">
            Back to Admin
          </a>
        </div>

        {/* Date picker */}
        <div className="flex items-center gap-3 mb-6">
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
          />
          <button
            onClick={fetchData}
            disabled={loading}
            className="px-4 py-2.5 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition text-sm"
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          {copyFeedback && (
            <span className="text-green-400 text-sm animate-pulse">{copyFeedback}</span>
          )}
        </div>

        {/* Stats bar */}
        {stats && stats.totalChannels > 0 && (
          <div className="grid grid-cols-4 gap-3 mb-8">
            {[
              { label: 'Channels', value: stats.totalChannels.toString(), color: 'text-purple-400' },
              { label: 'Total Views', value: formatNumber(stats.totalViews), color: 'text-blue-400' },
              { label: 'Avg Age', value: `${stats.avgAgeDays}d`, color: 'text-orange-400' },
              { label: 'Top Niche', value: stats.topNiche, color: 'text-green-400' },
            ].map((s, i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
                <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Empty state */}
        {!loading && channels.length === 0 && (
          <div className="text-center py-20">
            <div className="text-gray-600 text-6xl mb-4">0</div>
            <div className="text-gray-400 text-lg font-medium">No channels discovered on this date</div>
            <p className="text-gray-600 text-sm mt-2">Try picking a different date</p>
          </div>
        )}

        {/* Post sections */}
        {!loading && channels.length > 0 && (
          <div className="space-y-6">
            {/* 1. Daily Leaderboard Thread */}
            <CollapsibleSection
              title="Daily Leaderboard Thread"
              subtitle={`${threadTweets.length} tweets`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-500">Thread preview</span>
                <button
                  onClick={() => copyAllTexts(threadTweets.map(t => t.text))}
                  className="px-3 py-1.5 text-xs bg-gray-800 text-gray-400 rounded-lg hover:bg-gray-700 hover:text-white transition"
                >
                  Copy All
                </button>
              </div>

              {/* Leaderboard card for T1 */}
              <LeaderboardCard channels={channels.slice(0, 5)} date={date} />

              <div className="mt-4">
                <XThread tweets={threadTweets} />
              </div>
            </CollapsibleSection>

            {/* 2. Single Banger Post */}
            {singleBanger && (
              <CollapsibleSection
                title="Single Banger Post"
                subtitle="Best channel feature"
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs text-gray-500">Single tweet</span>
                  <button
                    onClick={() => { navigator.clipboard.writeText(singleBanger.text); showCopyFeedback('Copied!'); }}
                    className="px-3 py-1.5 text-xs bg-gray-800 text-gray-400 rounded-lg hover:bg-gray-700 hover:text-white transition"
                  >
                    Copy All
                  </button>
                </div>

                {/* Spotlight card */}
                <ChannelSpotlightCard
                  channelName={channels[0].channel_name}
                  avatarUrl={channels[0].avatar_url}
                  niche={channels[0].niche}
                  subscriberCount={channels[0].subscriber_count}
                  ageDays={channels[0].age_days}
                  totalViews={channels[0].total_views}
                  videoCount={channels[0].total_video_count}
                  thumbnails={getThumbnails(channels[0].videos, 4)}
                />

                <div className="mt-4">
                  <XPostPreview
                    text={singleBanger.text}
                    media={singleBanger.media}
                    onCopy={() => showCopyFeedback('Copied!')}
                  />
                </div>
              </CollapsibleSection>
            )}

            {/* 3. Stats-Only Post */}
            {statsPost && (
              <CollapsibleSection
                title="Stats-Only Post"
                subtitle="Numbers only, no media"
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs text-gray-500">Single tweet</span>
                  <button
                    onClick={() => { navigator.clipboard.writeText(statsPost.text); showCopyFeedback('Copied!'); }}
                    className="px-3 py-1.5 text-xs bg-gray-800 text-gray-400 rounded-lg hover:bg-gray-700 hover:text-white transition"
                  >
                    Copy All
                  </button>
                </div>
                <XPostPreview
                  text={statsPost.text}
                  onCopy={() => showCopyFeedback('Copied!')}
                />
              </CollapsibleSection>
            )}

            {/* 4. Niche Roundup */}
            {nicheRoundups.length > 0 && (
              <CollapsibleSection
                title="Niche Roundup"
                subtitle={`${nicheRoundups.length} niche${nicheRoundups.length !== 1 ? 's' : ''} with 2+ channels`}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs text-gray-500">{nicheRoundups.length} tweet{nicheRoundups.length !== 1 ? 's' : ''}</span>
                  <button
                    onClick={() => copyAllTexts(nicheRoundups.map(r => r.text))}
                    className="px-3 py-1.5 text-xs bg-gray-800 text-gray-400 rounded-lg hover:bg-gray-700 hover:text-white transition"
                  >
                    Copy All
                  </button>
                </div>
                <div className="space-y-4">
                  {nicheRoundups.map((roundup, i) => (
                    <XPostPreview
                      key={i}
                      text={roundup.text}
                      media={roundup.media}
                      onCopy={() => showCopyFeedback('Copied!')}
                    />
                  ))}
                </div>
              </CollapsibleSection>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
