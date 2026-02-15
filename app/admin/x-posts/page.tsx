'use client';

import React, { useState, useEffect, useCallback } from 'react';
import XPostPreview from '../../../components/admin/XPostPreview';
import XThread from '../../../components/admin/XThread';
import LeaderboardCard from '../../../components/admin/LeaderboardCard';
import ChannelSpotlightCard from '../../../components/admin/ChannelSpotlightCard';
import VideoRenderButton from '../../../components/admin/VideoRenderButton';

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
  is_posted: boolean;
  posted_at: string | null;
  post_type: string | null;
  ai_category: string | null;
  ai_niche: string | null;
  ai_sub_niche: string | null;
  content_style: string | null;
  is_ai_generated: boolean | null;
  channel_summary: string | null;
  ai_tags: string[] | null;
  ai_language: string | null;
  avg_duration: number | null;
  analysis_status: string | null;
  analysis_error: string | null;
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

// Pain-point hooks mapped to the 5 core user questions
const HOOKS_DISCOVERY = [
  'You\'ve never heard of this channel. Nobody has — yet.',
  'This channel doesn\'t show up in any "top creators" list. It will.',
];
const HOOKS_SPEED = [
  'Can a Shorts channel really blow up this fast?',
  'Most creators spend years building an audience. This one didn\'t.',
  'This is how fast a new channel can actually grow on Shorts.',
];
const HOOKS_NICHE = [
  'Wondering what actually works on Shorts right now?',
  'Everyone\'s guessing which niches are hot. We have the data.',
  'This is what\'s working on YouTube Shorts right now.',
];
const HOOKS_DOABLE = [
  'Could you start a channel like this tomorrow?',
  'No fancy setup. No big team. Just Shorts.',
  'This channel barely exists and it\'s already outgrowing creators with years of content.',
];
const HOOKS_AI = [
  'Is AI-generated content actually working on Shorts? Look at this.',
  'People keep asking if AI content can grow on Shorts. Here\'s your answer.',
];

function pickHook(pool: string[], seed: number): string {
  return pool[seed % pool.length];
}

function CollapsibleSection({ title, subtitle, children, defaultOpen = true, headerRight }: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  headerRight?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between p-5">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-3 text-left hover:opacity-80 transition flex-1"
        >
          <svg
            className={`w-5 h-5 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
          <div>
            <h3 className="text-white font-bold text-lg">{title}</h3>
            {subtitle && <p className="text-gray-500 text-sm mt-0.5">{subtitle}</p>}
          </div>
        </button>
        {headerRight && <div className="ml-3 flex-shrink-0">{headerRight}</div>}
      </div>
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
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Filters — defaults match Feed Spy defaults
  const [maxAge, setMaxAge] = useState('90');
  const [minSubs, setMinSubs] = useState('10000');
  const [maxSubs, setMaxSubs] = useState('0');
  const [minViews, setMinViews] = useState('0');

  // Posted tracking
  const [hidePosted, setHidePosted] = useState(true);
  const [markingSection, setMarkingSection] = useState<string | null>(null);
  const [postedChannels, setPostedChannels] = useState<Channel[]>([]);
  const [postedLoading, setPostedLoading] = useState(false);

  // AI Analysis
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyPreview, setApiKeyPreview] = useState<string | null>(null);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [ytApiKeyInput, setYtApiKeyInput] = useState('');
  const [ytApiKeyPreview, setYtApiKeyPreview] = useState<string | null>(null);
  const [ytApiKeySaving, setYtApiKeySaving] = useState(false);
  const [concurrency, setConcurrency] = useState('3');
  const [analysisPrompt, setAnalysisPrompt] = useState('');
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<{
    total: number; done: number; failed: number; analyzing: number; pending: number;
  } | null>(null);
  const [analysisResults, setAnalysisResults] = useState<Record<string, {
    status: string; category?: string; niche?: string; sub_niche?: string; content_style?: string;
    channel_summary?: string; tags?: string[]; language?: string;
    error_message?: string;
  }>>({});

  // Auth check
  useEffect(() => {
    fetch('/api/admin/auth')
      .then(res => res.json())
      .then(data => { if (data.authenticated) setAuthenticated(true); })
      .finally(() => setChecking(false));
  }, []);

  // Fetch API key config
  useEffect(() => {
    if (!authenticated) return;
    fetch('/api/admin/x-posts/analyze')
      .then(res => res.json())
      .then(data => {
        if (data.apiKeyPreview) setApiKeyPreview(data.apiKeyPreview);
        if (data.youtubeApiKeyPreview) setYtApiKeyPreview(data.youtubeApiKeyPreview);
        if (data.analysisPrompt) setAnalysisPrompt(data.analysisPrompt);
        if (data.defaultPrompt) setDefaultPrompt(data.defaultPrompt);
      })
      .catch(() => {});
  }, [authenticated]);

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
      const params = new URLSearchParams({
        date, maxAge, minSubs, maxSubs, minViews,
        includePosted: hidePosted ? 'false' : 'true',
      });
      const res = await fetch(`/api/admin/x-posts?${params}`);
      const data = await res.json();
      setChannels(data.channels || []);
      setStats(data.stats || null);
    } catch (err) {
      console.error('Failed to fetch x-posts data:', err);
    } finally {
      setLoading(false);
    }
  }, [date, maxAge, minSubs, maxSubs, minViews, hidePosted]);

  const fetchPostedChannels = useCallback(async () => {
    setPostedLoading(true);
    try {
      const params = new URLSearchParams({
        date, maxAge: '0', minSubs: '0', maxSubs: '0', minViews: '0',
        includePosted: 'true',
      });
      const res = await fetch(`/api/admin/x-posts?${params}`);
      const data = await res.json();
      setPostedChannels((data.channels || []).filter((ch: Channel) => ch.is_posted));
    } catch (err) {
      console.error('Failed to fetch posted channels:', err);
    } finally {
      setPostedLoading(false);
    }
  }, [date]);

  useEffect(() => {
    if (authenticated) fetchData();
  }, [authenticated, fetchData]);

  useEffect(() => {
    if (authenticated) fetchPostedChannels();
  }, [authenticated, fetchPostedChannels]);

  const showCopyFeedback = (msg: string) => {
    setCopyFeedback(msg);
    setTimeout(() => setCopyFeedback(''), 2000);
  };

  const copyAllTexts = (texts: string[]) => {
    navigator.clipboard.writeText(texts.join('\n\n---\n\n'));
    showCopyFeedback('All tweets copied!');
  };

  const markAsPosted = async (channelIds: string[], postType: string) => {
    setMarkingSection(postType);
    try {
      const res = await fetch('/api/admin/x-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelIds, postType }),
      });
      const data = await res.json();
      if (data.success) {
        showCopyFeedback(`Marked ${data.marked} channel${data.marked !== 1 ? 's' : ''} as posted`);
        fetchData();
        fetchPostedChannels();
      }
    } catch (err) {
      console.error('Failed to mark as posted:', err);
    } finally {
      setMarkingSection(null);
    }
  };

  const unmarkChannel = async (channelId: string) => {
    try {
      const res = await fetch('/api/admin/x-posts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId }),
      });
      const data = await res.json();
      if (data.success) {
        showCopyFeedback('Channel unmarked');
        fetchData();
        fetchPostedChannels();
      }
    } catch (err) {
      console.error('Failed to unmark channel:', err);
    }
  };

  // --- AI Analysis ---
  const pollAnalysis = useCallback(async (ids: string[]) => {
    try {
      const res = await fetch(`/api/admin/x-posts/analyze?channelIds=${ids.join(',')}`);
      const data = await res.json();
      if (data.progress) setAnalysisProgress(data.progress);
      if (data.analyses) setAnalysisResults(data.analyses);
      return data.isComplete;
    } catch (err) {
      console.error('Poll analysis error:', err);
      return false;
    }
  }, []);

  const startAnalysis = async (rerunFailed = false) => {
    const ids = channels.map(ch => ch.channel_id);
    if (ids.length === 0) return;
    setAnalyzing(true);
    setAnalysisProgress({ total: ids.length, done: 0, failed: 0, analyzing: 0, pending: ids.length });

    // Fire POST (runs analysis server-side)
    fetch('/api/admin/x-posts/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelIds: ids, rerunFailed, concurrency: parseInt(concurrency) || 3 }),
    }).then(() => {
      // Final poll after completion
      pollAnalysis(ids).then(() => {
        setAnalyzing(false);
        fetchData();
      });
    }).catch(err => {
      console.error('Analysis error:', err);
      setAnalyzing(false);
    });

    // Start polling for progress
    const interval = setInterval(async () => {
      const complete = await pollAnalysis(ids);
      if (complete) {
        clearInterval(interval);
      }
    }, 2000);

    // Safety: clear interval after 10 minutes
    setTimeout(() => clearInterval(interval), 600000);
  };

  const saveApiKey = async () => {
    if (!apiKeyInput.trim()) return;
    setApiKeySaving(true);
    try {
      const res = await fetch('/api/admin/x-posts/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setApiKeyPreview(`${apiKeyInput.trim().slice(0, 8)}...${apiKeyInput.trim().slice(-4)}`);
        setApiKeyInput('');
        showCopyFeedback('API key saved');
      }
    } catch (err) {
      console.error('Failed to save API key:', err);
    } finally {
      setApiKeySaving(false);
    }
  };

  const saveYtApiKey = async () => {
    if (!ytApiKeyInput.trim()) return;
    setYtApiKeySaving(true);
    try {
      const res = await fetch('/api/admin/x-posts/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeApiKey: ytApiKeyInput.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setYtApiKeyPreview(`${ytApiKeyInput.trim().slice(0, 8)}...${ytApiKeyInput.trim().slice(-4)}`);
        setYtApiKeyInput('');
        showCopyFeedback('YouTube API key saved');
      }
    } catch (err) {
      console.error('Failed to save YouTube API key:', err);
    } finally {
      setYtApiKeySaving(false);
    }
  };

  const savePrompt = async () => {
    if (!analysisPrompt.trim()) return;
    setPromptSaving(true);
    try {
      const res = await fetch('/api/admin/x-posts/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysisPrompt: analysisPrompt.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        showCopyFeedback('Prompt saved');
      }
    } catch (err) {
      console.error('Failed to save prompt:', err);
    } finally {
      setPromptSaving(false);
    }
  };

  // --- Generate post content ---

  // Filter out posted channels for generation
  const freshChannels = channels.filter(ch => !ch.is_posted);

  // 1. Daily Leaderboard Thread (5 tweets)
  const generateThread = (): { text: string; media?: string[] }[] => {
    if (freshChannels.length === 0) return [];
    const top5 = freshChannels.slice(0, 5);
    const tweets: { text: string; media?: string[] }[] = [];

    // T1 — hook: discovery pain point
    tweets.push({
      text: `${pickHook(HOOKS_DISCOVERY, Date.now())}\n\nWe just found ${stats?.totalChannels || freshChannels.length} Shorts channels that most people won't discover for months.\n\nHere are the fastest growing ones`,
      media: [],
    });

    // T2-4: individual channels — rotate through pain-point hooks
    const channelHookPools = [HOOKS_SPEED, HOOKS_DOABLE, HOOKS_NICHE];
    top5.slice(0, 3).forEach((ch, i) => {
      const topVideo = getTopVideo(ch.videos);
      const nicheLabel = [ch.ai_category, ch.ai_niche].filter(Boolean).join(' · ') || ch.niche;
      const style = ch.content_style ? ch.content_style.replace('_', ' ') : '';
      const langLabel = ch.ai_language ? ` · ${ch.ai_language.toUpperCase()}` : '';
      const durationLabel = ch.avg_duration ? ` · ~${ch.avg_duration}s avg` : '';
      const summaryLine = ch.channel_summary ? `\n\n${ch.channel_summary}` : '';
      const tagLine = ch.ai_tags?.length ? `\n\n${ch.ai_tags.slice(0, 4).map(t => `#${t}`).join(' ')}` : '';
      const hook = pickHook(channelHookPools[i % channelHookPools.length], i + Date.now());
      tweets.push({
        text: `${hook}\n\n${ch.channel_name}\n${nicheLabel}${style ? ` · ${style}` : ''}${langLabel} · ${formatAge(ch.age_days)} old\n${formatNumber(ch.subscriber_count)} subscribers${durationLabel}\nTop video: ${formatNumber(Number(topVideo?.view_count) || 0)} views${summaryLine}${tagLine}`,
        media: getThumbnails(ch.videos, 4),
      });
    });

    // T5
    tweets.push({
      text: `You're seeing these channels before anyone else.\n\nFollow @rofe_ai — we find them every day.`,
    });

    return tweets;
  };

  // 2. Single Banger Post (thread: T1 teases without channel name, T2 reveals)
  const generateSingleBanger = (): { text: string; media?: string[] }[] | null => {
    if (freshChannels.length === 0) return null;
    const ch = freshChannels[0];
    const topVideo = getTopVideo(ch.videos);

    const nicheLabel = [ch.ai_category, ch.ai_niche, ch.ai_sub_niche].filter(Boolean).join(' › ') || ch.niche;
    const style = ch.content_style ? `\n▸ Style: ${ch.content_style.replace('_', ' ')}` : '';
    const lang = ch.ai_language ? `\n▸ Language: ${ch.ai_language.toUpperCase()}` : '';
    const duration = ch.avg_duration ? `\n▸ Avg video: ~${ch.avg_duration}s` : '';
    const summaryLine = ch.channel_summary ? `\n\n${ch.channel_summary}` : '';
    const tagLine = ch.ai_tags?.length ? `\n\n${ch.ai_tags.slice(0, 5).map(t => `#${t}`).join(' ')}` : '';

    // Pick hook based on channel characteristics
    const isAI = ch.is_ai_generated === true;
    const isYoung = (ch.age_days || 999) < 30;
    let hook: string;
    if (isAI) hook = pickHook(HOOKS_AI, Date.now());
    else if (isYoung) hook = pickHook(HOOKS_SPEED, Date.now());
    else hook = ch.age_days ? `This channel didn't exist ${formatAge(ch.age_days)} ago.` : pickHook(HOOKS_DISCOVERY, Date.now());

    const tweets: { text: string; media?: string[] }[] = [];

    const videosPerDay = ch.total_video_count && ch.age_days && ch.age_days > 0
      ? (ch.total_video_count / ch.age_days).toFixed(1)
      : null;
    const videosLine = videosPerDay
      ? `\n▸ ${ch.total_video_count} videos (~${videosPerDay}/day)`
      : `\n▸ ${ch.total_video_count ?? '?'} videos`;

    // Only show total views if meaningfully different from top video
    const topVideoViews = Number(topVideo?.view_count) || 0;
    const totalViewsLine = ch.total_views && ch.total_views > topVideoViews * 1.1
      ? `\n▸ ${formatNumber(ch.total_views)} total views` : '';

    // Composite thumbnail: 3 Shorts side-by-side (endpoint fetches more from YT API if needed)
    const knownVideoIds = [...new Set(ch.videos.map(v => v.video_id))].slice(0, 3);
    const compositeParams = new URLSearchParams();
    if (knownVideoIds.length > 0) compositeParams.set('ids', knownVideoIds.join(','));
    compositeParams.set('channelId', ch.channel_id);
    const mediaUrls = [`/api/admin/x-posts/composite-thumb?${compositeParams.toString()}`];

    // T1: Hook + stats, NO channel name, CTA to read thread
    tweets.push({
      text: `${hook}\n\nThis ${nicheLabel} channel is just ${formatAge(ch.age_days)} old.\n▸ ${formatNumber(ch.subscriber_count)} subscribers${videosLine}${totalViewsLine}\n▸ Top video: ${formatNumber(topVideoViews)} views${style}${lang}${duration}${summaryLine}\n\nRead the thread to get the channel name.`,
      media: mediaUrls,
    });

    // T2: Reveal channel name + tags
    tweets.push({
      text: `The channel: ${ch.channel_name}\n\n${ch.channel_url}${tagLine}\n\nFollow @rofe_ai — we find channels like this every day.`,
    });

    return tweets;
  };

  // 3. Stats-Only Post
  const generateStatsPost = (): { text: string } | null => {
    if (!stats || freshChannels.length === 0) return null;
    const topCh = freshChannels[0];

    // Count content styles
    const styles: Record<string, number> = {};
    for (const ch of freshChannels) {
      const s = ch.content_style?.replace('_', ' ') || 'unknown';
      styles[s] = (styles[s] || 0) + 1;
    }
    const styleBreakdown = Object.entries(styles)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s, n]) => `${n} ${s}`)
      .join(', ');

    // Unique categories
    const categories = [...new Set(freshChannels.map(ch => ch.ai_category).filter(Boolean))];
    const categoryLine = categories.length > 0 ? `\nCategories: ${categories.join(', ')}` : '';

    return {
      text: `${pickHook(HOOKS_NICHE, Date.now())}\n\nToday's data:\n▸ ${stats.totalChannels} new channels discovered\n▸ Average channel age: ${stats.avgAgeDays} days\n▸ Combined views: ${formatNumber(stats.totalViews)}\n▸ Content styles: ${styleBreakdown}${categoryLine}\n\nThe fastest one hit ${formatNumber(topCh.subscriber_count)} subscribers in just ${topCh.age_days ?? '?'} days.`,
    };
  };

  // 4. Niche Roundup
  const generateNicheRoundups = (): { niche: string; text: string; media: string[]; channelIds: string[] }[] => {
    const nicheMap: Record<string, Channel[]> = {};
    for (const ch of freshChannels) {
      const nicheKey = ch.ai_category || ch.ai_niche || ch.niche;
      if (!nicheMap[nicheKey]) nicheMap[nicheKey] = [];
      nicheMap[nicheKey].push(ch);
    }

    return Object.entries(nicheMap)
      .filter(([, chs]) => chs.length >= 2)
      .map(([niche, chs]) => {
        const totalViews = chs.reduce((sum, ch) => sum + ch.total_views, 0);
        const listed = chs.slice(0, 4).map(ch => {
          const subNiche = ch.ai_sub_niche || ch.ai_niche || '';
          const style = ch.content_style ? ` · ${ch.content_style.replace('_', ' ')}` : '';
          const lang = ch.ai_language ? ` · ${ch.ai_language.toUpperCase()}` : '';
          return `• ${ch.channel_name} — ${subNiche}${style}${lang}\n  ${formatNumber(ch.subscriber_count)} subs · ${formatAge(ch.age_days)} old`;
        }).join('\n');

        return {
          niche,
          text: `${pickHook(HOOKS_NICHE, chs.length)}\n\n${chs.length} fresh ${niche} channels discovered today:\n\n${listed}\n\nCombined: ${formatNumber(totalViews)} views`,
          media: getThumbnails(chs[0].videos, 4),
          channelIds: chs.map(ch => ch.channel_id),
        };
      });
  };

  // Get channel IDs used in each section
  const getThreadChannelIds = () => freshChannels.slice(0, 5).map(ch => ch.channel_id);
  const getBangerChannelIds = () => freshChannels.length > 0 ? [freshChannels[0].channel_id] : [];
  const getStatsChannelIds = () => freshChannels.length > 0 ? [freshChannels[0].channel_id] : [];

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

        {/* Date picker + Hide posted toggle */}
        <div className="flex items-center gap-3 mb-6 flex-wrap">
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
          <label className="flex items-center gap-2 ml-auto cursor-pointer select-none">
            <div className="relative">
              <input
                type="checkbox"
                checked={hidePosted}
                onChange={e => setHidePosted(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-gray-700 rounded-full peer-checked:bg-green-600 transition-colors" />
              <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
            </div>
            <span className="text-sm text-gray-400">Hide posted</span>
          </label>
          {copyFeedback && (
            <span className="text-green-400 text-sm animate-pulse">{copyFeedback}</span>
          )}
        </div>

        {/* Filters */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl mb-6 overflow-hidden">
          <button
            onClick={() => setFiltersOpen(!filtersOpen)}
            className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-gray-800/50 transition"
          >
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
              </svg>
              <span className="text-sm font-medium text-gray-300">Channel Filters</span>
              <span className="text-xs text-gray-600">
                ({maxAge !== '0' ? `≤${maxAge}d` : 'any age'}
                {minSubs !== '0' ? `, ≥${Number(minSubs).toLocaleString()} subs` : ''}
                {maxSubs !== '0' ? `, ≤${Number(maxSubs).toLocaleString()} subs` : ''}
                {minViews !== '0' ? `, ≥${Number(minViews).toLocaleString()} views` : ''})
              </span>
            </div>
            <svg
              className={`w-4 h-4 text-gray-500 transition-transform ${filtersOpen ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {filtersOpen && (
            <div className="px-5 pb-5 pt-2 border-t border-gray-800">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Max channel age (days)</label>
                  <input
                    type="number" min={0} value={maxAge}
                    onChange={e => setMaxAge(e.target.value)}
                    placeholder="0 = no limit"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <p className="text-[10px] text-gray-600 mt-0.5">0 = no limit</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Min subscribers</label>
                  <input
                    type="number" min={0} value={minSubs}
                    onChange={e => setMinSubs(e.target.value)}
                    placeholder="0 = no limit"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <p className="text-[10px] text-gray-600 mt-0.5">0 = no limit</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Max subscribers</label>
                  <input
                    type="number" min={0} value={maxSubs}
                    onChange={e => setMaxSubs(e.target.value)}
                    placeholder="0 = no limit"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <p className="text-[10px] text-gray-600 mt-0.5">0 = no limit</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Min views (top video)</label>
                  <input
                    type="number" min={0} value={minViews}
                    onChange={e => setMinViews(e.target.value)}
                    placeholder="0 = no limit"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <p className="text-[10px] text-gray-600 mt-0.5">0 = no limit</p>
                </div>
              </div>
              <div className="flex items-center gap-3 mt-4">
                <button
                  onClick={fetchData}
                  disabled={loading}
                  className="px-4 py-2 bg-purple-600 text-white text-sm font-semibold rounded-lg hover:bg-purple-700 disabled:opacity-50 transition"
                >
                  Apply Filters
                </button>
                <button
                  onClick={() => { setMaxAge('90'); setMinSubs('10000'); setMaxSubs('0'); setMinViews('0'); }}
                  className="px-4 py-2 bg-gray-800 text-gray-400 text-sm rounded-lg hover:bg-gray-700 hover:text-white transition"
                >
                  Reset to Defaults
                </button>
              </div>
            </div>
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

        {/* AI Channel Analysis */}
        {!loading && channels.length > 0 && (
          <div className="mb-6">
            <CollapsibleSection
              title="AI Channel Analysis"
              subtitle={analysisProgress
                ? `${analysisProgress.done + analysisProgress.failed}/${analysisProgress.total} analyzed`
                : `${channels.length} channels`}
              defaultOpen={false}
              headerRight={
                <div className="flex items-center gap-2">
                  {analysisProgress && analysisProgress.failed > 0 && !analyzing && (
                    <button
                      onClick={() => startAnalysis(true)}
                      className="px-3 py-1.5 text-xs bg-orange-900/50 text-orange-400 border border-orange-800 rounded-lg hover:bg-orange-900 transition"
                    >
                      Retry {analysisProgress.failed} Failed
                    </button>
                  )}
                  <button
                    onClick={() => startAnalysis(false)}
                    disabled={analyzing}
                    className="px-3 py-1.5 text-xs bg-purple-900/50 text-purple-400 border border-purple-800 rounded-lg hover:bg-purple-900 disabled:opacity-50 transition"
                  >
                    {analyzing ? 'Analyzing...' : 'Analyze All Channels'}
                  </button>
                </div>
              }
            >
              {/* API Keys + Concurrency */}
              <div className="space-y-2 mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-500 w-16 flex-shrink-0">Gemini</span>
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={e => setApiKeyInput(e.target.value)}
                    placeholder={apiKeyPreview ? `Current: ${apiKeyPreview}` : 'Enter PapaiAPI key...'}
                    className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    onKeyDown={e => e.key === 'Enter' && saveApiKey()}
                  />
                  <button
                    onClick={saveApiKey}
                    disabled={!apiKeyInput.trim() || apiKeySaving}
                    className="px-3 py-2 text-xs bg-gray-800 text-gray-400 border border-gray-700 rounded-lg hover:bg-gray-700 hover:text-white disabled:opacity-50 transition whitespace-nowrap"
                  >
                    {apiKeySaving ? 'Saving...' : 'Save'}
                  </button>
                  {apiKeyPreview && !apiKeyInput && (
                    <span className="text-[10px] text-green-500 whitespace-nowrap">OK</span>
                  )}
                  <div className="flex items-center gap-1.5 ml-2">
                    <label className="text-[10px] text-gray-500 whitespace-nowrap">Threads</label>
                    <input
                      type="number" min={1} max={10}
                      value={concurrency}
                      onChange={e => setConcurrency(e.target.value)}
                      className="w-14 px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm text-center focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-500 w-16 flex-shrink-0">YouTube</span>
                  <input
                    type="password"
                    value={ytApiKeyInput}
                    onChange={e => setYtApiKeyInput(e.target.value)}
                    placeholder={ytApiKeyPreview ? `Current: ${ytApiKeyPreview}` : 'Enter YouTube Data API key (for language detection)...'}
                    className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    onKeyDown={e => e.key === 'Enter' && saveYtApiKey()}
                  />
                  <button
                    onClick={saveYtApiKey}
                    disabled={!ytApiKeyInput.trim() || ytApiKeySaving}
                    className="px-3 py-2 text-xs bg-gray-800 text-gray-400 border border-gray-700 rounded-lg hover:bg-gray-700 hover:text-white disabled:opacity-50 transition whitespace-nowrap"
                  >
                    {ytApiKeySaving ? 'Saving...' : 'Save'}
                  </button>
                  {ytApiKeyPreview && !ytApiKeyInput && (
                    <span className="text-[10px] text-green-500 whitespace-nowrap">OK</span>
                  )}
                </div>
              </div>

              {/* Analysis Prompt Editor */}
              <div className="border border-gray-700/50 rounded-xl overflow-hidden">
                <button
                  onClick={() => setPromptExpanded(!promptExpanded)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-gray-800/50 transition"
                >
                  <div className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                    </svg>
                    <span className="text-xs font-medium text-gray-400">Analysis Prompt</span>
                    {analysisPrompt !== defaultPrompt && (
                      <span className="text-[10px] text-purple-400 bg-purple-900/30 px-1.5 py-0.5 rounded">customized</span>
                    )}
                  </div>
                  <svg
                    className={`w-3.5 h-3.5 text-gray-500 transition-transform ${promptExpanded ? 'rotate-180' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {promptExpanded && (
                  <div className="px-4 pb-4 pt-1 border-t border-gray-700/50">
                    <p className="text-[10px] text-gray-500 mb-2">
                      Use <code className="bg-gray-800 px-1 py-0.5 rounded text-purple-400">{'{{VIDEO_URL}}'}</code> as placeholder for the video URL.
                    </p>
                    <textarea
                      value={analysisPrompt}
                      onChange={e => setAnalysisPrompt(e.target.value)}
                      rows={12}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-xs font-mono placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-y leading-relaxed"
                      placeholder="Enter analysis prompt..."
                    />
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={savePrompt}
                        disabled={promptSaving}
                        className="px-3 py-1.5 text-xs bg-purple-900/50 text-purple-400 border border-purple-800 rounded-lg hover:bg-purple-900 disabled:opacity-50 transition"
                      >
                        {promptSaving ? 'Saving...' : 'Save Prompt'}
                      </button>
                      <button
                        onClick={() => setAnalysisPrompt(defaultPrompt)}
                        className="px-3 py-1.5 text-xs bg-gray-800 text-gray-400 border border-gray-700 rounded-lg hover:bg-gray-700 hover:text-white transition"
                      >
                        Reset to Default
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Progress bar */}
              {analysisProgress && analysisProgress.total > 0 && (
                <div className="mb-4">
                  <div className="flex items-center justify-between text-xs text-gray-400 mb-1.5">
                    <span>{analysisProgress.done} done, {analysisProgress.failed} failed, {analysisProgress.analyzing} analyzing, {analysisProgress.pending} pending</span>
                    <span>{Math.round(((analysisProgress.done + analysisProgress.failed) / analysisProgress.total) * 100)}%</span>
                  </div>
                  <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                    <div className="h-full flex">
                      <div
                        className="bg-green-500 transition-all duration-500"
                        style={{ width: `${(analysisProgress.done / analysisProgress.total) * 100}%` }}
                      />
                      <div
                        className="bg-red-500 transition-all duration-500"
                        style={{ width: `${(analysisProgress.failed / analysisProgress.total) * 100}%` }}
                      />
                      <div
                        className="bg-purple-500 animate-pulse transition-all duration-500"
                        style={{ width: `${(analysisProgress.analyzing / analysisProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Per-channel status grid */}
              <div className="space-y-2">
                {channels.map(ch => {
                  const result = analysisResults[ch.channel_id];
                  const status = result?.status || ch.analysis_status || null;
                  return (
                    <div
                      key={ch.channel_id}
                      className="flex items-start gap-3 px-4 py-3 bg-gray-800/50 border border-gray-700/50 rounded-xl"
                    >
                      {ch.avatar_url && (
                        <img src={ch.avatar_url} alt="" className="w-8 h-8 rounded-full flex-shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-white text-sm font-medium truncate">{ch.channel_name}</span>
                          {status === 'done' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-900/50 text-green-400 border border-green-800">Done</span>
                          )}
                          {status === 'failed' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-900/50 text-red-400 border border-red-800">Failed</span>
                          )}
                          {status === 'analyzing' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-900/50 text-purple-400 border border-purple-800 animate-pulse">Analyzing</span>
                          )}
                          {status === 'pending' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-700/50 text-gray-400 border border-gray-600">Pending</span>
                          )}
                        </div>
                        {(status === 'done') && (
                          <div className="text-xs text-gray-400 space-y-0.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-gray-300">{[result?.category || ch.ai_category, result?.niche || ch.ai_niche, result?.sub_niche || ch.ai_sub_niche].filter(Boolean).join(' > ')}</span>
                              {(result?.content_style || ch.content_style) && (
                                <span className="text-gray-500">· {(result?.content_style || ch.content_style)?.replace('_', ' ')}</span>
                              )}
                              {(result?.language || ch.ai_language) && (
                                <span className="text-blue-400/70">· {(result?.language || ch.ai_language)?.toUpperCase()}</span>
                              )}
                              {ch.avg_duration && (
                                <span className="text-gray-500">· ~{ch.avg_duration}s</span>
                              )}
                              {(result?.tags || ch.ai_tags) && (
                                <span className="text-gray-600">
                                  {(result?.tags || ch.ai_tags || []).slice(0, 4).map((t: string) => `#${t}`).join(' ')}
                                </span>
                              )}
                            </div>
                            {(result?.channel_summary || ch.channel_summary) && (
                              <p className="text-gray-500 line-clamp-1">{result?.channel_summary || ch.channel_summary}</p>
                            )}
                          </div>
                        )}
                        {status === 'failed' && (
                          <p className="text-xs text-red-400/70 line-clamp-1">
                            {result?.error_message || ch.analysis_error}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CollapsibleSection>
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
            <p className="text-gray-600 text-sm mt-2">Try picking a different date{hidePosted ? ' or toggle "Hide posted" off' : ''}</p>
          </div>
        )}

        {/* Post sections */}
        {!loading && channels.length > 0 && (
          <div className="space-y-6">
            {/* Posted badges helper */}
            {!hidePosted && channels.some(ch => ch.is_posted) && (
              <div className="text-xs text-gray-500 flex items-center gap-2">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-900/50 text-green-400 border border-green-800">Posted</span>
                <span>= already posted to X</span>
              </div>
            )}

            {/* 1. Daily Leaderboard Thread */}
            <CollapsibleSection
              title="Daily Leaderboard Thread"
              subtitle={`${threadTweets.length} tweets`}
              defaultOpen={false}
              headerRight={
                getThreadChannelIds().length > 0 && (
                  <button
                    onClick={() => markAsPosted(getThreadChannelIds(), 'thread')}
                    disabled={markingSection === 'thread'}
                    className="px-3 py-1.5 text-xs bg-green-900/50 text-green-400 border border-green-800 rounded-lg hover:bg-green-900 disabled:opacity-50 transition"
                  >
                    {markingSection === 'thread' ? 'Marking...' : 'Mark as Posted'}
                  </button>
                )
              }
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

              {/* Channel badges */}
              {!hidePosted && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {freshChannels.slice(0, 5).map(ch => (
                    <span key={ch.channel_id} className="text-xs text-gray-400">
                      {ch.channel_name}
                      {ch.is_posted && (
                        <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-900/50 text-green-400 border border-green-800">Posted</span>
                      )}
                    </span>
                  ))}
                </div>
              )}

              {/* Leaderboard card for T1 */}
              <LeaderboardCard channels={freshChannels.slice(0, 5)} date={date} />

              <VideoRenderButton
                compositionId="LeaderboardVideo"
                inputProps={{
                  channels: freshChannels.slice(0, 5).map(ch => ({
                    channel_name: ch.channel_name,
                    avatar_url: ch.avatar_url,
                    subscriber_count: ch.subscriber_count,
                    age_days: ch.age_days,
                    velocity: ch.velocity,
                    niche: ch.niche,
                    total_views: ch.total_views,
                  })),
                  date,
                  postText: threadTweets[0]?.text || '',
                }}
                channelIds={getThreadChannelIds()}
                label="Render Leaderboard Video"
              />

              <div className="mt-4">
                <XThread tweets={threadTweets} />
              </div>
            </CollapsibleSection>

            {/* 2. Single Banger Post (Thread) */}
            {singleBanger && (
              <CollapsibleSection
                title="Single Banger Post"
                subtitle={`${singleBanger.length} tweets`}
                defaultOpen={false}
                headerRight={
                  getBangerChannelIds().length > 0 && (
                    <button
                      onClick={() => markAsPosted(getBangerChannelIds(), 'banger')}
                      disabled={markingSection === 'banger'}
                      className="px-3 py-1.5 text-xs bg-green-900/50 text-green-400 border border-green-800 rounded-lg hover:bg-green-900 disabled:opacity-50 transition"
                    >
                      {markingSection === 'banger' ? 'Marking...' : 'Mark as Posted'}
                    </button>
                  )
                }
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs text-gray-500">
                    Thread preview
                    {!hidePosted && freshChannels[0]?.is_posted && (
                      <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-900/50 text-green-400 border border-green-800">Posted</span>
                    )}
                  </span>
                  <button
                    onClick={() => copyAllTexts(singleBanger.map(t => t.text))}
                    className="px-3 py-1.5 text-xs bg-gray-800 text-gray-400 rounded-lg hover:bg-gray-700 hover:text-white transition"
                  >
                    Copy All
                  </button>
                </div>

                {/* Spotlight card */}
                <ChannelSpotlightCard
                  channelName={freshChannels[0].channel_name}
                  avatarUrl={freshChannels[0].avatar_url}
                  niche={freshChannels[0].niche}
                  subscriberCount={freshChannels[0].subscriber_count}
                  ageDays={freshChannels[0].age_days}
                  totalViews={freshChannels[0].total_views}
                  videoCount={freshChannels[0].total_video_count}
                  thumbnails={getThumbnails(freshChannels[0].videos, 4)}
                />

                <VideoRenderButton
                  compositionId="ChannelSpotlightVideo"
                  inputProps={{
                    channel: {
                      channel_name: freshChannels[0].channel_name,
                      avatar_url: freshChannels[0].avatar_url,
                      niche: freshChannels[0].niche,
                      sub_niche: freshChannels[0].ai_sub_niche,
                      subscriber_count: freshChannels[0].subscriber_count,
                      age_days: freshChannels[0].age_days,
                      total_views: freshChannels[0].total_views,
                      video_count: freshChannels[0].total_video_count,
                      content_style: freshChannels[0].content_style,
                      channel_summary: freshChannels[0].channel_summary,
                      tags: freshChannels[0].ai_tags,
                    },
                    clipPaths: [],
                    postText: singleBanger[0]?.text || '',
                  }}
                  channelIds={getBangerChannelIds()}
                  label="Render Spotlight Video"
                />

                <div className="mt-4">
                  <XThread tweets={singleBanger} />
                </div>
              </CollapsibleSection>
            )}

            {/* 3. Stats-Only Post */}
            {statsPost && (
              <CollapsibleSection
                title="Stats-Only Post"
                subtitle="Numbers only, no media"
                defaultOpen={false}
                headerRight={
                  getStatsChannelIds().length > 0 && (
                    <button
                      onClick={() => markAsPosted(getStatsChannelIds(), 'stats')}
                      disabled={markingSection === 'stats'}
                      className="px-3 py-1.5 text-xs bg-green-900/50 text-green-400 border border-green-800 rounded-lg hover:bg-green-900 disabled:opacity-50 transition"
                    >
                      {markingSection === 'stats' ? 'Marking...' : 'Mark as Posted'}
                    </button>
                  )
                }
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
                <VideoRenderButton
                  compositionId="StatsVideo"
                  inputProps={{
                    totalChannels: stats?.totalChannels || 0,
                    totalViews: stats?.totalViews || 0,
                    avgAgeDays: stats?.avgAgeDays || 0,
                    contentStyles: (() => {
                      const styles: Record<string, number> = {};
                      for (const ch of freshChannels) {
                        const s = ch.content_style?.replace('_', ' ') || 'unknown';
                        styles[s] = (styles[s] || 0) + 1;
                      }
                      return styles;
                    })(),
                    categories: [...new Set(freshChannels.map(ch => ch.ai_category).filter(Boolean))],
                    topChannel: {
                      channel_name: freshChannels[0]?.channel_name || '',
                      avatar_url: freshChannels[0]?.avatar_url || null,
                      subscriber_count: freshChannels[0]?.subscriber_count || null,
                      age_days: freshChannels[0]?.age_days || null,
                    },
                    postText: statsPost.text,
                  }}
                  label="Render Stats Video"
                />

                <div className="mt-4" />

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
                defaultOpen={false}
                headerRight={
                  <button
                    onClick={() => markAsPosted(nicheRoundups.flatMap(r => r.channelIds), 'niche_roundup')}
                    disabled={markingSection === 'niche_roundup'}
                    className="px-3 py-1.5 text-xs bg-green-900/50 text-green-400 border border-green-800 rounded-lg hover:bg-green-900 disabled:opacity-50 transition"
                  >
                    {markingSection === 'niche_roundup' ? 'Marking...' : 'Mark as Posted'}
                  </button>
                }
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
                    <div key={i}>
                      <XPostPreview
                        text={roundup.text}
                        media={roundup.media}
                        onCopy={() => showCopyFeedback('Copied!')}
                      />
                      <VideoRenderButton
                        compositionId="NicheRoundupVideo"
                        inputProps={{
                          nicheName: roundup.niche,
                          channels: freshChannels
                            .filter(ch => (ch.ai_category || ch.ai_niche || ch.niche) === roundup.niche)
                            .slice(0, 6)
                            .map(ch => ({
                              channel_name: ch.channel_name,
                              avatar_url: ch.avatar_url,
                              sub_niche: ch.ai_sub_niche,
                              subscriber_count: ch.subscriber_count,
                              age_days: ch.age_days,
                            })),
                          combinedViews: freshChannels
                            .filter(ch => (ch.ai_category || ch.ai_niche || ch.niche) === roundup.niche)
                            .reduce((sum, ch) => sum + ch.total_views, 0),
                          clipPaths: [],
                          postText: roundup.text,
                        }}
                        channelIds={roundup.channelIds}
                        label={`Render ${roundup.niche} Video`}
                      />
                    </div>
                  ))}
                </div>
              </CollapsibleSection>
            )}
          </div>
        )}

        {/* Posted Channels History */}
        {postedChannels.length > 0 && (
          <div className="mt-8">
            <CollapsibleSection
              title="Posted Channels"
              subtitle={`${postedChannels.length} channel${postedChannels.length !== 1 ? 's' : ''} already posted`}
              defaultOpen={false}
            >
              {postedLoading ? (
                <div className="flex items-center justify-center py-6">
                  <div className="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <div className="space-y-2">
                  {postedChannels.map(ch => (
                    <div
                      key={ch.channel_id}
                      className="flex items-center justify-between px-4 py-3 bg-gray-800/50 border border-gray-700/50 rounded-xl"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {ch.avatar_url && (
                          <img src={ch.avatar_url} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="text-white text-sm font-medium truncate">{ch.channel_name}</div>
                          <div className="text-gray-500 text-xs flex items-center gap-2">
                            <span>{ch.post_type || 'unknown'}</span>
                            <span>·</span>
                            <span>{ch.posted_at ? new Date(ch.posted_at).toLocaleDateString() : '?'}</span>
                            <span>·</span>
                            <span>{formatNumber(ch.subscriber_count)} subs</span>
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => unmarkChannel(ch.channel_id)}
                        className="px-3 py-1.5 text-xs bg-red-900/30 text-red-400 border border-red-900/50 rounded-lg hover:bg-red-900/50 transition flex-shrink-0 ml-3"
                      >
                        Unmark
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleSection>
          </div>
        )}
      </div>
    </div>
  );
}
