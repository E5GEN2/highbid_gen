'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Image from 'next/image';
import JSZip from 'jszip';
import { useSession } from 'next-auth/react';
import { SettingsProvider, useSettings } from '../lib/settingsContext';
import { SettingsTab } from '../components/SettingsTab';
import { PageOverrideControls } from '../components/PageOverrideControls';
import { StoryboardWithOverrides, createStoryboardWithOverrides } from '../lib/storyboardOverrides';
import FeedViewer, { FeedChannel, FeedFilters, DEFAULT_FEED_FILTERS } from '../components/FeedViewer';
import AuthButton from '../components/AuthButton';
import { ApiTokenPopover } from '../components/ApiTokenPopover';
import NicheTimeline from '../components/NicheTimeline';

// Format numbers YouTube-style: 1530000 → "1.5M", 23475 → "23K", 601 → "601"
const fmtYT = (n: number): string => {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
};

// Helper function to check if URL is a video
const isVideoFile = (url: string): boolean => {
  const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
  const lowerUrl = url.toLowerCase();
  return videoExtensions.some(ext => lowerUrl.includes(ext));
};

// Helper function to calculate number of image columns needed based on audio duration
const calculateImageColumns = (durationSeconds: number): number => {
  if (!durationSeconds) return 1; // Default to 1 column if no duration
  return Math.max(1, Math.ceil(durationSeconds / 2)); // One column per 2 seconds, minimum 1
};

// Wrapper component that provides the context
export default function Home() {
  return (
    <SettingsProvider>
      <HomeContent />
    </SettingsProvider>
  );
}

// Main content component that uses the settings context
function HomeContent() {
  const { data: session } = useSession();
  const { settings } = useSettings();

  // Get API keys from context
  const apiKey = settings.apiKeys.openRouterKey;
  const elevenLabsKey = settings.apiKeys.elevenLabsKey;
  const googleTtsKey = settings.apiKeys.googleTtsKey;
  const highbidApiUrl = settings.apiKeys.highbidApiUrl;
  const kokoroUrl = settings.apiKeys.kokoroUrl;
  const papaiApiKey = settings.apiKeys.papaiApiKey;

  const [activeTab, setActiveTab] = useState('scripts');
  
  // Script Generation State
  const [scriptTitles, setScriptTitles] = useState<string[]>(['']);
  const [targetSceneCount, setTargetSceneCount] = useState(30); // Default 30 scenes
  
  interface StoryBulb {
    title: string;
    runtime_sec: number;
    tone: string;
    narration_pov: string;
    target_viewer: string;
    premise: string;
    protagonist: string;
    goal: string;
    stakes: string;
    setting: string;
    constraint: string;
    twist: string;
    call_to_action: string;
    visual_style: string;
    action_emphasis: string;
    domino_sequences: string[];
    setups_payoffs: { setup: string; payoff: string }[];
    escalation_points: string[];
    plot_threads: {
      act1: { turning_point: string; consequence: string };
      act2: { turning_point: string; consequence: string };
      act3: { turning_point: string; consequence: string };
    };
    target_scene_count: number; // Added for variable scenes
  }
  
  interface StoryboardScene {
    scene_id: number;
    start_ms: number;
    end_ms: number;
    beat: string;
    vo_text: string;
    scene_twist: string;
    caused_by: string;
    leads_to: string;
    callback_to: string;
    vo_emphasis: string;
    read_speed_wps: number;
    visual_prompt: {
      setting: string;
      characters: string;
      action: string;
      props: string;
      mood: string;
      lighting: string;
      color_palette: string;
      camera: string;
      composition: string;
      aspect_ratio: string;
      style_tags: string;
      negative_tags: string;
      model_hint: string;
      seed: number;
    };
    text_overlay: {
      content: string;
      position: string;
      weight: string;
    };
    transition_in: string;
    transition_out: string;
    music_cue: string;
  }
  
  const [generatedStories, setGeneratedStories] = useState<StoryBulb[]>([]);
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [showStoryBulbPrompt, setShowStoryBulbPrompt] = useState(false);
  const [showStoryboardPrompt, setShowStoryboardPrompt] = useState(false);
  
  // Storyboard State
  const [selectedStory, setSelectedStory] = useState<StoryBulb | null>(null);
  const [generatedStoryboard, setGeneratedStoryboard] = useState<StoryboardScene[]>([]);
  const [storyboardsLoading, setStoryboardsLoading] = useState(false);
  const [storyboardProgress, setStoryboardProgress] = useState({
    currentBatch: 0,
    totalBatches: 6,
    currentScene: 0,
    totalScenes: 30,
    status: ''
  });
  
  // Voice-over State
  const [voiceoverTexts, setVoiceoverTexts] = useState<string[]>(['']);
  const [generatedVoiceovers, setGeneratedVoiceovers] = useState<{text: string, audio: string, provider?: string}[]>([]);
  const [voiceoversLoading, setVoiceoversLoading] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<{
    voice_id: string;
    name: string;
    description: string;
    preview_url?: string;
    labels?: {
      gender?: string;
      age?: string;
      style?: string;
      type?: string;
    };
  }[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState('Kore');
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<'elevenlabs' | 'google' | 'kokoro'>('google');
  const [googleVoicesLoaded, setGoogleVoicesLoaded] = useState(false);
  
  // Load voices function (memoized with useCallback)
  const loadVoices = React.useCallback(async (provider: 'elevenlabs' | 'google' | 'kokoro' = ttsProvider) => {
    if (provider === 'elevenlabs') {
      if (!elevenLabsKey || voicesLoaded) return;
      
      try {
        const response = await fetch(`/api/generate-voiceover?apiKey=${elevenLabsKey}`);
        const data = await response.json();
        
        if (data.success && data.voices) {
          setAvailableVoices(data.voices);
          setVoicesLoaded(true);
          setSelectedVoiceId('21m00Tcm4TlvDq8ikWAM');
        }
      } catch (err) {
        console.error('Failed to load ElevenLabs voices:', err);
      }
    } else if (provider === 'google') {
      if (!googleTtsKey || googleVoicesLoaded) return;
      
      try {
        const response = await fetch(`/api/generate-google-tts?apiKey=${googleTtsKey}`);
        const data = await response.json();
        
        if (data.success && data.voices) {
          setAvailableVoices(data.voices);
          setGoogleVoicesLoaded(true);
          setSelectedVoiceId('Kore');
        }
      } catch (err) {
        console.error('Failed to load Google voices:', err);
      }
    }
  }, [ttsProvider, elevenLabsKey, googleTtsKey, voicesLoaded, googleVoicesLoaded]);

  // Helper function to update story bulb
  const updateStoryBulb = (storyIndex: number, field: keyof StoryBulb, value: string | number | string[] | object[]) => {
    setGeneratedStories(prev => prev.map((story, index) => {
      if (index === storyIndex) {
        const updated = { ...story, [field]: value };
        // Update selectedStory if it matches
        if (selectedStory === story) {
          setSelectedStory(updated);
        }
        return updated;
      }
      return story;
    }));
  };

  // Auto-load voices when API keys are available
  React.useEffect(() => {
    if (ttsProvider === 'elevenlabs' && elevenLabsKey && !voicesLoaded) {
      loadVoices('elevenlabs');
    } else if (ttsProvider === 'google' && googleTtsKey && !googleVoicesLoaded) {
      loadVoices('google');
    }
  }, [ttsProvider, elevenLabsKey, googleTtsKey, voicesLoaded, googleVoicesLoaded, loadVoices]);

  // Image Generation State
  const [imagePrompts, setImagePrompts] = useState<string[]>(['']);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imageProvider, setImageProvider] = useState<'openrouter' | 'highbid' | 'gemini'>('openrouter');
  const [imageWidth, setImageWidth] = useState(1024);
  const [imageHeight, setImageHeight] = useState(1024);
  
  // Effects State and Video Rendering
  const [finalVideos, setFinalVideos] = useState<string[]>([]);
  const [renderingVideo, setRenderingVideo] = useState(false);
  const [renderProgress, setRenderProgress] = useState({
    step: '',
    progress: 0,
    total: 100
  });
  
  const [error, setError] = useState<string | null>(null);

  // Visible tabs config
  const [visibleTabs, setVisibleTabs] = useState<string[]>(['feed']);
  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(data => {
      if (data.visibleTabs) setVisibleTabs(data.visibleTabs);
    }).catch(() => {});
  }, []);

  // Sidebar Navigation State
  const [currentView, setCurrentView] = useState<'creator' | 'library' | 'spy' | 'feed' | 'clipping' | 'niche'>('feed');
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [libraryProjects, setLibraryProjects] = useState<{
    id: string;
    title: string;
    thumbnail: string | null;
    updatedAt: string;
  }[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clipping State
  const [clippingProjects, setClippingProjects] = useState<{
    id: string;
    title: string;
    status: string;
    thumbnail_url: string | null;
    video_duration: number | null;
    created_at: string;
    updated_at: string;
  }[]>([]);
  const [clippingLoading, setClippingLoading] = useState(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [clippingStep, setClippingStep] = useState<'upload' | 'configure' | 'processing' | 'clips'>('upload');
  const [clippingProcessSteps, setClippingProcessSteps] = useState<{
    label: string;
    status: 'pending' | 'active' | 'done';
    progress?: number;
    detail?: string;
  }[]>([]);
  const [clippingFile, setClippingFile] = useState<{ name: string; size: number; type: string; rawFile?: File } | null>(null);
  const [clippingVideoDuration, setClippingVideoDuration] = useState<number | undefined>(undefined);
  const [clippingUploadProgress, setClippingUploadProgress] = useState(0);
  const [clippingRatio, setClippingRatio] = useState('9:16');
  const [clippingClipLength, setClippingClipLength] = useState('60s-90s');
  const [clippingAddEmoji, setClippingAddEmoji] = useState(true);
  const [clippingHighlightKeywords, setClippingHighlightKeywords] = useState(true);
  const [clippingRemoveSilences, setClippingRemoveSilences] = useState(false);
  const [clippingAddBrolls, setClippingAddBrolls] = useState(false);
  const [clippingFindMoment, setClippingFindMoment] = useState('');
  const [clippingCurrentProjectId, setClippingCurrentProjectId] = useState<string | null>(null);
  const [clippingGeneratedClips, setClippingGeneratedClips] = useState<{
    id: string;
    title: string;
    description: string;
    score: number;
    start_sec: number;
    end_sec: number;
    duration_sec: number;
    transcript: string;
    status: string;
    file_size_bytes: number | null;
  }[]>([]);
  const [clippingSelectedClipIdx, setClippingSelectedClipIdx] = useState(0);

  // Niche Explorer State
  const [nicheVideos, setNicheVideos] = useState<Array<{
    id: number; keyword: string; url: string; title: string; view_count: number;
    channel_name: string; posted_date: string; posted_at: string; score: number;
    subscriber_count: number; like_count: number; comment_count: number;
    top_comment: string; thumbnail: string; fetched_at: string;
  }>>([]);
  const [nicheTotal, setNicheTotal] = useState(0);
  const [nicheKeywords, setNicheKeywords] = useState<Array<{ keyword: string; cnt: string }>>([]);
  const [nicheStats, setNicheStats] = useState<{ total_videos: string; total_keywords: string; total_channels: string; avg_score: string } | null>(null);
  const [nicheFilter, setNicheFilter] = useState({ keyword: 'all', minScore: 0, maxScore: 100, sort: 'score', from: null as string | null, to: null as string | null });
  const [nicheLoading, setNicheLoading] = useState(false);
  const [nicheSyncing, setNicheSyncing] = useState(false);
  const [nicheSyncProgress, setNicheSyncProgress] = useState<{
    message: string; batches: number; totalInserted: number; totalUpdated: number;
    totalLocal: number; totalKeywords: number; tasksProcessed: number;
    keywordBreakdown?: Array<{ keyword: string; total: number; new: number }>;
    saturation?: Array<{ keyword: string; runSatPct: number; globalSatPct: number; A: number; B: number }>;
    done?: boolean;
  } | null>(null);
  const [nicheOffset, setNicheOffset] = useState(0);
  const [nicheEnriching, setNicheEnriching] = useState(false);
  const [nicheEnrichResult, setNicheEnrichResult] = useState<{ message: string; enriched: number; errors: number } | null>(null);

  const fetchNicheData = useCallback(async (offset = 0) => {
    setNicheLoading(true);
    try {
      const params = new URLSearchParams({
        keyword: nicheFilter.keyword,
        minScore: String(nicheFilter.minScore),
        maxScore: String(nicheFilter.maxScore),
        sort: nicheFilter.sort,
        limit: '60',
        offset: String(offset),
      });
      if (nicheFilter.from) params.set('from', nicheFilter.from);
      if (nicheFilter.to) params.set('to', nicheFilter.to);
      const res = await fetch(`/api/niche-spy?${params}`);
      const data = await res.json();
      if (offset === 0) {
        setNicheVideos(data.videos);
      } else {
        setNicheVideos(prev => [...prev, ...data.videos]);
      }
      setNicheTotal(data.total);
      setNicheKeywords(data.keywords);
      setNicheStats(data.stats);
      setNicheOffset(offset + data.videos.length);
    } catch (err) { console.error('Niche fetch error:', err); }
    setNicheLoading(false);
  }, [nicheFilter]);

  const syncNicheData = async () => {
    setNicheSyncing(true);
    setNicheSyncProgress({ message: 'Fetching tasks from xgodo...', batches: 0, totalInserted: 0, totalUpdated: 0, totalLocal: 0, totalKeywords: 0, tasksProcessed: 0 });
    let totalInserted = 0;
    let totalUpdated = 0;
    let batches = 0;
    try {
      while (true) {
        const res = await fetch('/api/niche-spy/sync', { method: 'POST' });
        const data = await res.json();
        if (data.error) { setNicheSyncProgress(prev => prev ? { ...prev, message: `Error: ${data.error}` } : null); break; }
        batches++;
        totalInserted += data.videosInserted || 0;
        totalUpdated += data.videosUpdated || 0;

        if (data.status === 'idle' || data.tasksProcessed === 0) {
          setNicheSyncProgress({
            message: totalInserted > 0 ? `Done! ${totalInserted} new, ${totalUpdated} updated across ${batches} batches.` : 'All caught up — no new tasks.',
            batches, totalInserted, totalUpdated,
            totalLocal: data.totalLocal || 0, totalKeywords: data.totalKeywords || 0,
            tasksProcessed: data.tasksProcessed || 0,
            keywordBreakdown: data.keywordBreakdown,
            saturation: data.saturation,
            done: true,
          });
          break;
        }

        setNicheSyncProgress({
          message: `Batch ${batches}: ${data.tasksProcessed} tasks → ${data.videosInserted} new, ${data.videosUpdated} updated, ${data.tasksConfirmed} confirmed`,
          batches, totalInserted, totalUpdated,
          totalLocal: data.totalLocal || 0, totalKeywords: data.totalKeywords || 0,
          tasksProcessed: data.tasksProcessed,
          keywordBreakdown: data.keywordBreakdown,
        });

        // Keep pulling if there might be more tasks
        if (data.tasksProcessed < 100) break; // Last batch was partial — done
        await new Promise(r => setTimeout(r, 500));
      }
      fetchNicheData(0);
    } catch (err) {
      console.error('Niche sync error:', err);
      setNicheSyncProgress(prev => prev ? { ...prev, message: `Error: ${err instanceof Error ? err.message : 'Sync failed'}` } : null);
    }
    setTimeout(() => { setNicheSyncing(false); setNicheSyncProgress(null); }, 5000);
  };

  // Load niche data when tab becomes active
  useEffect(() => {
    if (currentView === 'niche' && nicheVideos.length === 0) {
      fetchNicheData(0);
    }
  }, [currentView, fetchNicheData, nicheVideos.length]);

  // Reload when filters change
  useEffect(() => {
    if (currentView === 'niche') {
      fetchNicheData(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nicheFilter]);

  // Feed Spy State
  const [spyData, setSpyData] = useState<{
    videos: Array<{
      video_id: string; video_url: string; title: string | null; duration_seconds: number;
      upload_date: string | null; view_count: number | null; like_count: number | null;
      comment_count: number | null; collected_at: string;
      channel_id: string; channel_name: string; channel_url: string;
      channel_creation_date: string | null; sighting_count: number; avatar_url: string | null;
    }>;
    total: number;
    stats: { total_videos: string; total_channels: string; total_sightings: string; total_collections: string };
    risingStars: Array<{
      channel_id: string; channel_name: string; channel_url: string;
      channel_creation_date: string; sighting_count: number; avatar_url: string | null;
      first_seen_at: string; last_seen_at: string; subscriber_count: string | null;
      total_video_count: string | null; max_views: string; video_count: string; total_views: string;
    }>;
    risingStarsCount: { total: number; addedToday: number };
  } | null>(null);
  const [spyLoading, setSpyLoading] = useState(false);
  const [spySort, setSpySort] = useState('view_count');
  const [spyMinViews, setSpyMinViews] = useState('0');
  const [spyMaxAge, setSpyMaxAge] = useState('');

  // Rising Stars settings
  const [rsMaxChannels, setRsMaxChannels] = useState('12');
  const [rsMaxAge, setRsMaxAge] = useState('180');
  const [rsMinViews, setRsMinViews] = useState('0');

  // Shorts Feed State
  const [feedChannels, setFeedChannels] = useState<FeedChannel[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const feedLoadingRef = useRef(false);
  const [feedChannelIndex, setFeedChannelIndex] = useState(0);
  const [feedVideoIndex, setFeedVideoIndex] = useState(0);
  const [feedOffset, setFeedOffset] = useState(0);
  const [feedHasMore, setFeedHasMore] = useState(true);
  const [feedTotalChannels, setFeedTotalChannels] = useState(0);
  const [feedUnseenChannels, setFeedUnseenChannels] = useState<number | null>(null);
  const [feedFilters, setFeedFilters] = useState<FeedFilters>(DEFAULT_FEED_FILTERS);
  const prefsLoaded = useRef(false);
  const prefsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load saved preferences on sign-in
  useEffect(() => {
    if (!session?.user?.id || prefsLoaded.current) return;
    prefsLoaded.current = true;
    fetch('/api/user/preferences')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.feedFilters && Object.keys(data.feedFilters).length > 0) {
          setFeedFilters((prev) => ({ ...prev, ...data.feedFilters }));
        }
      })
      .catch(() => {});
  }, [session?.user?.id]);

  // Debounced save preferences on filter change
  useEffect(() => {
    if (!session?.user?.id || !prefsLoaded.current) return;
    if (prefsSaveTimer.current) clearTimeout(prefsSaveTimer.current);
    prefsSaveTimer.current = setTimeout(() => {
      fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedFilters }),
      }).catch(() => {});
    }, 1000);
    return () => { if (prefsSaveTimer.current) clearTimeout(prefsSaveTimer.current); };
  }, [feedFilters, session?.user?.id]);

  // Storyboard Images State
  const [storyboardImages, setStoryboardImages] = useState<{[key: string]: string}>({});
  const [uploadedFileTypes, setUploadedFileTypes] = useState<{[sceneId: number]: 'video' | 'image'}>({});
  const [imageGenerationLoading, setImageGenerationLoading] = useState<{[key: string]: boolean}>({});
  const [batchImageLoading, setBatchImageLoading] = useState(false);
  const [batchImageProgress, setBatchImageProgress] = useState({
    current: 0,
    total: 0,
    currentScene: 0,
    status: '',
    failed: 0,
    retries: 0
  });

  // Storyboard Voiceovers State
  const [storyboardVoiceovers, setStoryboardVoiceovers] = useState<{[sceneId: number]: string}>({});
  const [voiceoverDurations, setVoiceoverDurations] = useState<{[sceneId: number]: number}>({});
  const [voiceoverGenerationLoading, setVoiceoverGenerationLoading] = useState<{[sceneId: number]: boolean}>({});
  const [batchVoiceoverLoading, setBatchVoiceoverLoading] = useState(false);
  const [batchVoiceoverProgress, setBatchVoiceoverProgress] = useState({
    current: 0,
    total: 0,
    currentScene: 0,
    status: '',
    failed: 0,
    retries: 0
  });

  // Create Flux prompt from storyboard scene
  const createFluxPrompt = (scene: StoryboardScene, storyVisualStyle?: string) => {
    const vp = scene.visual_prompt;
    
    // Convert lighting enum to descriptive text
    const lightingMap: {[key: string]: string} = {
      'soft': 'soft lighting',
      'hard': 'hard lighting', 
      'noir': 'noir dramatic lighting',
      'neon': 'neon lighting',
      'golden_hour': 'golden hour lighting',
      'overcast': 'overcast lighting',
      'practical': 'practical lighting'
    };
    
    // Convert color palette enum to descriptive text
    const colorMap: {[key: string]: string} = {
      'warm': 'warm tones',
      'cool': 'cool tones',
      'monochrome': 'monochrome tones',
      'teal_orange': 'teal orange tones',
      'pastel': 'pastel tones'
    };
    
    // Build prompt components - use story-level visual style for consistency
    const components = [
      storyVisualStyle || vp.style_tags, // Use story-level visual style if available
      `${vp.mood} mood`,
      vp.setting,
      vp.characters,
      vp.action,
      vp.props,
      lightingMap[vp.lighting] || vp.lighting,
      colorMap[vp.color_palette] || vp.color_palette,
      `${vp.camera} camera`,
      `${vp.composition} composition`,
      'cinematic shot',
      `aspect ratio ${vp.aspect_ratio}`,
      `seed ${vp.seed}`
    ].filter(Boolean);
    
    return {
      prompt: components.join(', '),
      negative: vp.negative_tags
    };
  };

  const tabs = [
    { id: 'scripts', name: '1. Scripts', icon: '📝' },
    { id: 'storyboard', name: '2. Storyboard', icon: '🎨' },
    { id: 'voiceovers', name: '3. Voice-overs', icon: '🎤' },
    { id: 'images', name: '4. Images', icon: '🖼️' },
    { id: 'pages', name: '5. Pages', icon: '📄' },
    { id: 'effects', name: '6. Final Video', icon: '🎬' },
    { id: 'settings', name: 'Settings', icon: '⚙️' }
  ];

  const handleVoiceoverGeneration = async () => {
    const apiKeyRequired = ttsProvider === 'elevenlabs' ? elevenLabsKey : googleTtsKey;
    const providerName = ttsProvider === 'elevenlabs' ? 'ElevenLabs' : 'Google TTS';
    
    if (!apiKeyRequired || voiceoverTexts.filter(t => t.trim()).length === 0) {
      setError(`Please provide ${providerName} API key and at least one text`);
      return;
    }

    setVoiceoversLoading(true);
    setError(null);

    try {
      const results: {text: string, audio: string, provider?: string}[] = [];
      
      for (const text of voiceoverTexts) {
        if (!text.trim()) continue;
        
        const endpoint = ttsProvider === 'elevenlabs' 
          ? '/api/generate-voiceover' 
          : ttsProvider === 'kokoro' 
            ? '/api/generate-voiceover-kokoro'
            : '/api/generate-google-tts';
        
        const requestBody = ttsProvider === 'elevenlabs' 
          ? { text, apiKey: elevenLabsKey, voiceId: selectedVoiceId }
          : ttsProvider === 'kokoro'
            ? { text, voice: selectedVoiceId, speed: 1.0, kokoroUrl }
            : { text, apiKey: googleTtsKey, voiceName: selectedVoiceId };
        
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || `Failed to generate voice-over with ${providerName}`);
        }

        if (data.audio) {
          results.push({ text, audio: data.audio, provider: data.provider || ttsProvider });
        }
      }
      
      setGeneratedVoiceovers(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setVoiceoversLoading(false);
    }
  };

  const handleScriptGeneration = async () => {
    if (!papaiApiKey || scriptTitles.filter(t => t.trim()).length === 0) {
      setError('Please provide PapAI API key in Settings and at least one title');
      return;
    }
    
    setScriptsLoading(true);
    setError(null);
    
    try {
      const results = [];
      
      for (const title of scriptTitles) {
        if (!title.trim()) continue;
        
        const response = await fetch('/api/generate-story', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title,
            apiKey: papaiApiKey,
            targetSceneCount,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to generate story');
        }

        if (data.storyBulb) {
          // Ensure target_scene_count is set
          data.storyBulb.target_scene_count = targetSceneCount;
          results.push(data.storyBulb);
        }
      }
      
      setGeneratedStories(results);
      if (results.length > 0) {
        setSelectedStory(results[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate scripts');
    } finally {
      setScriptsLoading(false);
    }
  };
  
  const handleStoryboardGeneration = async (resumeFromScene = 1) => {
    if (!papaiApiKey || !selectedStory) {
      setError('Please provide PapAI API key and select a story');
      return;
    }
    
    setStoryboardsLoading(true);
    setError(null);
    
    // Get target scene count from selected story, default to 30 if not set
    const targetScenes = selectedStory.target_scene_count || 30;
    
    // Calculate starting point for resume functionality
    const batchSize = 5;
    const totalBatches = Math.ceil(targetScenes / batchSize);
    const startingBatch = Math.floor((resumeFromScene - 1) / batchSize);
    const existingScenes = resumeFromScene === 1 ? [] : generatedStoryboard.slice(0, resumeFromScene - 1);
    
    // Reset storyboard if starting fresh, otherwise keep existing scenes
    if (resumeFromScene === 1) {
      setGeneratedStoryboard([]);
    }
    
    setStoryboardProgress({ 
      currentBatch: startingBatch, 
      totalBatches, 
      currentScene: existingScenes.length, 
      totalScenes: targetScenes, 
      status: resumeFromScene === 1 ? 'Starting storyboard generation...' : `Resuming from scene ${resumeFromScene}...` 
    });
    
    try {
      const allScenes: StoryboardScene[] = [...existingScenes];
      
      for (let batchIndex = startingBatch; batchIndex < totalBatches; batchIndex++) {
        const startScene = batchIndex * batchSize + 1;
        const endScene = Math.min(startScene + batchSize - 1, targetScenes);
        
        setStoryboardProgress({
          currentBatch: batchIndex + 1,
          totalBatches,
          currentScene: startScene - 1,
          totalScenes: targetScenes,
          status: `Generating scenes ${startScene}-${endScene}...`
        });
        
        const response = await fetch('/api/generate-storyboard', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            storyBulb: selectedStory,
            apiKey: papaiApiKey,
            startScene,
            endScene,
            targetSceneCount: targetScenes,
            previousScenes: allScenes.slice(-10), // Send last 10 scenes for context
          }),
        });
        
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Failed to generate batch ${batchIndex + 1}`);
        }
        
        const data = await response.json();
        if (data.storyboard && Array.isArray(data.storyboard)) {
          allScenes.push(...data.storyboard);
          
          // Update storyboard in real-time as scenes are generated
          setGeneratedStoryboard(prev => [...prev, ...data.storyboard]);
          
          setStoryboardProgress({
            currentBatch: batchIndex + 1,
            totalBatches,
            currentScene: allScenes.length,
            totalScenes: targetScenes,
            status: `Generated ${allScenes.length}/${targetScenes} scenes - Populating UI...`
          });
          
          // Auto-switch to storyboard tab after first batch for immediate feedback
          if (batchIndex === 0) {
            setActiveTab('storyboard');
          }
        }
        
        // Small delay between batches to show progress
        if (batchIndex < totalBatches - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      if (allScenes.length > 0) {
        setStoryboardProgress({
          currentBatch: totalBatches,
          totalBatches,
          currentScene: allScenes.length,
          totalScenes: 30,
          status: 'Storyboard generation complete!'
        });
        setActiveTab('storyboard');
      } else {
        throw new Error('No scenes were generated');
      }
      
    } catch (err) {
      const currentScenes = generatedStoryboard.length;
      const failedAtScene = currentScenes + 1;
      const errorMsg = err instanceof Error ? err.message : 'Failed to generate storyboard';
      
      if (currentScenes > 0) {
        setError(`${errorMsg}. Generated ${currentScenes} scenes successfully. You can resume from scene ${failedAtScene}.`);
        setStoryboardProgress({ 
          currentBatch: Math.ceil(currentScenes / batchSize), 
          totalBatches, 
          currentScene: currentScenes, 
          totalScenes: 30, 
          status: `Stopped at scene ${currentScenes}. Click Resume to continue.` 
        });
      } else {
        setError(errorMsg);
        setStoryboardProgress({ currentBatch: 0, totalBatches, currentScene: 0, totalScenes: 30, status: '' });
      }
    } finally {
      setStoryboardsLoading(false);
      // Clear progress after a delay
      setTimeout(() => {
        setStoryboardProgress({ currentBatch: 0, totalBatches: 6, currentScene: 0, totalScenes: 30, status: '' });
      }, 3000);
    }
  };

  const handleImageGeneration = async () => {
    const requiredKey = imageProvider === 'openrouter' ? apiKey : 
                        imageProvider === 'gemini' ? googleTtsKey : highbidApiUrl;
    const providerName = imageProvider === 'openrouter' ? 'OpenRouter API key' : 
                         imageProvider === 'gemini' ? 'Gemini API key' : 'Highbid API URL';
    
    if (!requiredKey || imagePrompts.filter(p => p.trim()).length === 0) {
      setError(`Please provide ${providerName} and at least one image prompt`);
      return;
    }

    setImagesLoading(true);
    setError(null);

    try {
      const results: string[] = [];
      
      for (const prompt of imagePrompts) {
        if (!prompt.trim()) continue;
        
        const endpoint = imageProvider === 'openrouter' ? '/api/generate-image' : 
                        imageProvider === 'gemini' ? '/api/generate-gemini-image' : '/api/generate-highbid-image';
        const requestBody = imageProvider === 'openrouter' 
          ? { prompt, apiKey }
          : imageProvider === 'gemini'
            ? { prompt, apiKey: googleTtsKey }
            : { prompt, apiUrl: highbidApiUrl, width: imageWidth, height: imageHeight };
        
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || `Failed to generate image with ${imageProvider}`);
        }

        if (data.image) {
          results.push(data.image);
        }
      }
      
      setGeneratedImages(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setImagesLoading(false);
    }
  };

  // Generate image for a specific column of a storyboard scene
  const generateStoryboardImageColumn = async (scene: StoryboardScene, colIndex: number) => {
    const requiredKey = imageProvider === 'openrouter' ? apiKey : 
                        imageProvider === 'gemini' ? googleTtsKey : highbidApiUrl;
    const providerName = imageProvider === 'openrouter' ? 'OpenRouter API key' : 
                         imageProvider === 'gemini' ? 'Gemini API key' : 'Highbid API URL';

    if (!requiredKey) {
      setError(`${providerName} is required for storyboard image generation`);
      return;
    }

    const numColumns = calculateImageColumns(voiceoverDurations[scene.scene_id]);
    const imageKey = `${scene.scene_id}_${colIndex}`;
    
    console.log(`Generating image for scene ${scene.scene_id}, column ${colIndex + 1}/${numColumns} using ${imageProvider}`);

    setImageGenerationLoading(prev => ({ ...prev, [imageKey]: true }));
    setError(null);

    try {
      const basePrompt = createFluxPrompt(scene, selectedStory?.visual_style).prompt;
      
      // Add temporal context for multi-column images
      const timeStart = colIndex * 2;
      const timeEnd = (colIndex + 1) * 2;
      const enhancedPrompt = numColumns > 1 
        ? `${basePrompt}, temporal context: action moment at ${timeStart}-${timeEnd} seconds`
        : basePrompt;
      
      // Get dimensions from aspect ratio (only needed for Highbid)
      let width, height;
      switch (scene.visual_prompt.aspect_ratio) {
        case '16:9':
          width = 1024; height = 576;
          break;
        case '9:16':
          width = 576; height = 1024;
          break;
        case '1:1':
        default:
          width = 1024; height = 1024;
          break;
      }

      const endpoint = imageProvider === 'openrouter' ? '/api/generate-image' : 
                      imageProvider === 'gemini' ? '/api/generate-gemini-image' : '/api/generate-highbid-image';
      const requestBody = imageProvider === 'openrouter' 
        ? { prompt: enhancedPrompt, apiKey }
        : imageProvider === 'gemini'
          ? { prompt: enhancedPrompt, apiKey: googleTtsKey }
          : { prompt: enhancedPrompt, apiUrl: highbidApiUrl, width, height };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || `Failed to generate image for scene ${scene.scene_id}, column ${colIndex + 1}`);
      }
      
      // Handle different response formats
      const imageUrl = data.image || data.imageUrl || data.audioUrl;
      if (imageUrl) {
        // Store the image with the appropriate key
        const finalImageKey = numColumns === 1 ? scene.scene_id.toString() : imageKey;
        setStoryboardImages(prev => ({ ...prev, [finalImageKey]: imageUrl }));
      } else {
        throw new Error('No image data received from API');
      }
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred generating storyboard image');
    } finally {
      setImageGenerationLoading(prev => ({ ...prev, [imageKey]: false }));
    }
  };

  // Generate image for a specific storyboard scene (legacy function - now generates all columns)
  const generateStoryboardImage = async (scene: StoryboardScene) => {
    if (!highbidApiUrl) {
      setError('Highbid API URL is required for storyboard image generation');
      return;
    }

    // Calculate how many images we need based on audio duration
    const numColumns = calculateImageColumns(voiceoverDurations[scene.scene_id]);
    console.log(`Generating ${numColumns} images for scene ${scene.scene_id} (${voiceoverDurations[scene.scene_id]}s audio)`);

    setImageGenerationLoading(prev => ({ ...prev, [scene.scene_id]: true }));
    setError(null);

    try {
      const basePrompt = createFluxPrompt(scene, selectedStory?.visual_style).prompt;
      
      // Get dimensions from aspect ratio
      let width, height;
      switch (scene.visual_prompt.aspect_ratio) {
        case '16:9':
          width = 1024; height = 576;
          break;
        case '9:16':
          width = 576; height = 1024;
          break;
        case '1:1':
        default:
          width = 1024; height = 1024;
          break;
      }
      
      // Generate images for each column (time segment)
      const imagePromises = [];
      for (let colIndex = 0; colIndex < numColumns; colIndex++) {
        const startTime = colIndex * 2;
        const endTime = (colIndex + 1) * 2;
        
        // Enhance prompt with temporal context
        const timePrompt = `${basePrompt}, at ${startTime}-${endTime} seconds into the scene, progressive sequence ${colIndex + 1} of ${numColumns}`;
        
        const promise = fetch('/api/generate-highbid-image', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: timePrompt,
            apiUrl: highbidApiUrl,
            width,
            height
          }),
        }).then(async response => {
          const data = await response.json();
          return { colIndex, data, ok: response.ok };
        });
        
        imagePromises.push(promise);
      }

      // Wait for all images to generate
      const results = await Promise.all(imagePromises);
      
      // Process results and update state
      const newImages: { [key: string]: string } = {};
      let successCount = 0;
      
      for (const result of results) {
        if (result.ok && result.data.image) {
          const key = result.colIndex === 0 ? scene.scene_id.toString() : `${scene.scene_id}_${result.colIndex}`;
          newImages[key] = result.data.image;
          successCount++;
        }
      }
      
      if (successCount > 0) {
        setStoryboardImages(prev => ({ ...prev, ...newImages }));
        console.log(`Successfully generated ${successCount}/${numColumns} images for scene ${scene.scene_id}`);
      }
      
      if (successCount < numColumns) {
        setError(`Generated ${successCount}/${numColumns} images. Some failed to generate.`);
      }
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred generating storyboard images');
    } finally {
      setImageGenerationLoading(prev => ({ ...prev, [scene.scene_id]: false }));
    }
  };

  // Generate all storyboard images in batch with retry logic and progress
  const generateAllStoryboardImages = async () => {
    const requiredKey = imageProvider === 'openrouter' ? apiKey : 
                        imageProvider === 'gemini' ? googleTtsKey : highbidApiUrl;
    const providerName = imageProvider === 'openrouter' ? 'OpenRouter API key' : 
                         imageProvider === 'gemini' ? 'Gemini API key' : 'Highbid API URL';

    if (!requiredKey) {
      setError(`${providerName} is required for batch storyboard image generation`);
      return;
    }

    if (generatedStoryboard.length === 0) {
      setError('No storyboard generated yet');
      return;
    }

    setBatchImageLoading(true);
    setError(null);
    
    // Calculate total images needed across all scenes
    const totalImages = generatedStoryboard.reduce((sum, scene) => {
      const numColumns = calculateImageColumns(voiceoverDurations[scene.scene_id]);
      return sum + numColumns;
    }, 0);
    
    setBatchImageProgress({
      current: 0,
      total: totalImages,
      currentScene: 0,
      status: 'Starting batch image generation...',
      failed: 0,
      retries: 0
    });

    try {
      const maxRetries = 3;
      let totalGenerated = 0;
      
      for (let i = 0; i < generatedStoryboard.length; i++) {
        const scene = generatedStoryboard[i];
        const numColumns = calculateImageColumns(voiceoverDurations[scene.scene_id]);
        
        console.log(`Generating ${numColumns} images for scene ${scene.scene_id} (${voiceoverDurations[scene.scene_id]}s audio)`);
        
        setBatchImageProgress(prev => ({
          ...prev,
          currentScene: scene.scene_id,
          status: `Generating ${numColumns} ${numColumns === 1 ? 'image' : 'images'} for scene ${scene.scene_id}...`
        }));

        const basePrompt = createFluxPrompt(scene, selectedStory?.visual_style).prompt;
        
        // Get dimensions from aspect ratio
        let width, height;
        switch (scene.visual_prompt.aspect_ratio) {
          case '16:9':
            width = 1024; height = 576;
            break;
          case '9:16':
            width = 576; height = 1024;
            break;
          case '1:1':
          default:
            width = 1024; height = 1024;
            break;
        }

        // Generate multiple images sequentially for this scene
        const sceneImages: { [key: string]: string } = {};
        
        for (let colIndex = 0; colIndex < numColumns; colIndex++) {
          const timeStart = colIndex * 2;
          const timeEnd = (colIndex + 1) * 2;
          const timeRange = numColumns > 1 ? ` (${timeStart}-${timeEnd}s)` : '';
          
          const enhancedPrompt = numColumns > 1 
            ? `${basePrompt}, temporal context: action moment at ${timeStart}-${timeEnd} seconds${timeRange}`
            : basePrompt;

          let attempts = 0;
          let success = false;
          let imageData = null;

          while (attempts < maxRetries && !success) {
            try {
              if (attempts > 0) {
                setBatchImageProgress(prev => ({
                  ...prev,
                  status: `Retrying scene ${scene.scene_id} image ${colIndex + 1}/${numColumns} (attempt ${attempts + 1}/${maxRetries})...`,
                  retries: prev.retries + 1
                }));
                // Wait a bit before retry
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
              
              const endpoint = imageProvider === 'openrouter' ? '/api/generate-image' : 
                              imageProvider === 'gemini' ? '/api/generate-gemini-image' : '/api/generate-highbid-image';
              const requestBody = imageProvider === 'openrouter' 
                ? { prompt: enhancedPrompt, apiKey }
                : imageProvider === 'gemini'
                  ? { prompt: enhancedPrompt, apiKey: googleTtsKey }
                  : { prompt: enhancedPrompt, apiUrl: highbidApiUrl, width, height };

              const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
              });
              
              const data = await response.json();
              
              if (!response.ok) {
                throw new Error(data.error || `Failed to generate image ${colIndex + 1} for scene ${scene.scene_id}`);
              }
              
              const imageUrl = data.image || data.imageUrl || data.audioUrl;
              if (imageUrl) {
                imageData = imageUrl;
                success = true;
                totalGenerated++;
                
                setBatchImageProgress(prev => ({
                  ...prev,
                  current: totalGenerated,
                  status: `Generated image ${colIndex + 1}/${numColumns} for scene ${scene.scene_id} ✓`
                }));
                
                // Store the image immediately
                const imageKey = numColumns === 1 ? scene.scene_id.toString() : `${scene.scene_id}_${colIndex + 1}`;
                sceneImages[imageKey] = data.image;
              } else {
                throw new Error('No image data received from API');
              }
              
            } catch (err) {
              attempts++;
              console.error(`Attempt ${attempts} failed for scene ${scene.scene_id} image ${colIndex + 1}:`, err);
              
              if (attempts >= maxRetries) {
                setBatchImageProgress(prev => ({
                  ...prev,
                  failed: prev.failed + 1,
                  current: totalGenerated,
                  status: `Failed to generate image ${colIndex + 1} for scene ${scene.scene_id} after ${maxRetries} attempts ✗`
                }));
                break; // Stop trying this image and move to next
              }
            }
          }
        }
        
        setStoryboardImages(prev => ({
          ...prev,
          ...sceneImages
        }));
        
        // Small delay to show the progress update
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      setBatchImageProgress(prev => ({
        ...prev,
        status: `Batch generation complete! Generated: ${totalGenerated}, Failed: ${prev.failed}`
      }));
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred during batch generation');
    } finally {
      setBatchImageLoading(false);
      // Clear progress after 5 seconds
      setTimeout(() => {
        setBatchImageProgress({ current: 0, total: 0, currentScene: 0, status: '', failed: 0, retries: 0 });
      }, 5000);
    }
  };

  // Generate voiceover for a specific storyboard scene
  const generateStoryboardVoiceover = async (scene: StoryboardScene) => {
    const currentProvider = ttsProvider;
    const currentApiKey = currentProvider === 'elevenlabs' 
      ? elevenLabsKey 
      : currentProvider === 'kokoro' 
        ? kokoroUrl 
        : googleTtsKey;
    
    console.log('🎤 Voiceover Debug:', {
      provider: currentProvider,
      hasApiKey: !!currentApiKey,
      selectedVoiceId,
      sceneText: scene.scene_twist || scene.vo_text,
      availableVoicesCount: availableVoices.length
    });
    
    if (!currentApiKey) {
      setError(`${currentProvider === 'elevenlabs' ? 'ElevenLabs' : 'Google TTS'} API key is required for voiceover generation`);
      return;
    }

    if (!selectedVoiceId) {
      setError(`Please select a voice first. Go to Voice-overs tab to load and select voices.`);
      return;
    }

    setVoiceoverGenerationLoading(prev => ({ ...prev, [scene.scene_id]: true }));
    setError(null);

    try {
      const endpoint = currentProvider === 'elevenlabs' 
        ? '/api/generate-voiceover' 
        : currentProvider === 'kokoro'
          ? '/api/generate-voiceover-kokoro'
          : '/api/generate-google-tts';
      
      // Use scene_twist for more engaging voiceover text
      const voiceoverText = scene.scene_twist || scene.vo_text;
      
      const requestBody = currentProvider === 'elevenlabs' 
        ? { text: voiceoverText, apiKey: currentApiKey, voiceId: selectedVoiceId }
        : currentProvider === 'kokoro'
          ? { text: voiceoverText, voice: selectedVoiceId, speed: scene.read_speed_wps ? scene.read_speed_wps / 2.5 : 1.0, kokoroUrl }
          : { text: voiceoverText, apiKey: currentApiKey, voiceName: selectedVoiceId };

      console.log('🎤 Making request:', { endpoint, requestBody: { ...requestBody, apiKey: '***' } });

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();
      console.log('🎤 Response:', { ok: response.ok, status: response.status, hasAudio: !!data.audio });

      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate storyboard voiceover');
      }

      const audioUrl = data.audioUrl || data.audio;
      if (audioUrl) {
        setStoryboardVoiceovers(prev => ({
          ...prev,
          [scene.scene_id]: audioUrl
        }));
        console.log('🎤 Voiceover saved for scene:', scene.scene_id);
      } else {
        throw new Error('No audio data received from API');
      }
    } catch (err) {
      console.error('🎤 Voiceover error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred generating storyboard voiceover');
    } finally {
      setVoiceoverGenerationLoading(prev => ({ ...prev, [scene.scene_id]: false }));
    }
  };

  // Generate all storyboard voiceovers in batch with retry logic and progress
  const generateAllStoryboardVoiceovers = async () => {
    const currentProvider = ttsProvider;
    const currentApiKey = currentProvider === 'elevenlabs' 
      ? elevenLabsKey 
      : currentProvider === 'kokoro' 
        ? kokoroUrl 
        : googleTtsKey;
    
    if (!currentApiKey) {
      setError(`${currentProvider === 'elevenlabs' ? 'ElevenLabs' : 'Google TTS'} API key is required for batch voiceover generation`);
      return;
    }

    if (generatedStoryboard.length === 0) {
      setError('No storyboard generated yet');
      return;
    }

    setBatchVoiceoverLoading(true);
    setError(null);
    
    const totalScenes = generatedStoryboard.length;
    setBatchVoiceoverProgress({
      current: 0,
      total: totalScenes,
      currentScene: 0,
      status: 'Starting batch voiceover generation...',
      failed: 0,
      retries: 0
    });

    try {
      const maxRetries = 3;
      
      for (let i = 0; i < generatedStoryboard.length; i++) {
        const scene = generatedStoryboard[i];
        let attempts = 0;
        let success = false;

        setBatchVoiceoverProgress(prev => ({
          ...prev,
          currentScene: scene.scene_id,
          status: `Generating voiceover for scene ${scene.scene_id}...`
        }));

        while (attempts < maxRetries && !success) {
          try {
            if (attempts > 0) {
              setBatchVoiceoverProgress(prev => ({
                ...prev,
                status: `Retrying scene ${scene.scene_id} (attempt ${attempts + 1}/${maxRetries})...`,
                retries: prev.retries + 1
              }));
              // Wait a bit before retry
              await new Promise(resolve => setTimeout(resolve, 2000));
            }

            const endpoint = currentProvider === 'elevenlabs' 
              ? '/api/generate-voiceover' 
              : currentProvider === 'kokoro'
                ? '/api/generate-voiceover-kokoro'
                : '/api/generate-google-tts';
            
            // Use scene_twist for more engaging voiceover text
            const voiceoverText = scene.scene_twist || scene.vo_text;
            
            const requestBody = currentProvider === 'elevenlabs' 
              ? { text: voiceoverText, apiKey: currentApiKey, voiceId: selectedVoiceId }
              : currentProvider === 'kokoro'
                ? { text: voiceoverText, voice: selectedVoiceId, speed: scene.read_speed_wps ? scene.read_speed_wps / 2.5 : 1.0, kokoroUrl }
                : { text: voiceoverText, apiKey: currentApiKey, voiceName: selectedVoiceId };

            const response = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestBody),
            });

            const data = await response.json();

            if (!response.ok) {
              throw new Error(data.error || `Failed to generate voiceover for scene ${scene.scene_id}`);
            }

            const audioUrl = data.audioUrl || data.audio;
            if (audioUrl) {
              // Update the storyboard voiceovers immediately to show progress
              setStoryboardVoiceovers(prev => ({
                ...prev,
                [scene.scene_id]: audioUrl
              }));
              success = true;
              
              setBatchVoiceoverProgress(prev => ({
                ...prev,
                current: prev.current + 1,
                status: `Generated voiceover for scene ${scene.scene_id} ✓`
              }));
              
              // Small delay to show the progress update
              await new Promise(resolve => setTimeout(resolve, 500));
            } else {
              throw new Error('No audio data received from API');
            }
            
          } catch (err) {
            attempts++;
            console.error(`Attempt ${attempts} failed for scene ${scene.scene_id}:`, err);
            
            if (attempts >= maxRetries) {
              setBatchVoiceoverProgress(prev => ({
                ...prev,
                failed: prev.failed + 1,
                current: prev.current + 1,
                status: `Failed to generate voiceover for scene ${scene.scene_id} after ${maxRetries} attempts ✗`
              }));
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
      }

      setBatchVoiceoverProgress(prev => ({
        ...prev,
        status: `Batch generation complete! Generated: ${prev.current - prev.failed}, Failed: ${prev.failed}`
      }));
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred during batch voiceover generation');
    } finally {
      setBatchVoiceoverLoading(false);
      // Clear progress after 5 seconds
      setTimeout(() => {
        setBatchVoiceoverProgress({ current: 0, total: 0, currentScene: 0, status: '', failed: 0, retries: 0 });
      }, 5000);
    }
  };

  // Handle video rendering using project ZIP
  const handleVideoRender = async () => {
    if (!selectedStory || generatedStoryboard.length === 0) {
      setError('Please generate a storyboard first');
      return;
    }

    setRenderingVideo(true);
    setError(null);
    setRenderProgress({ step: 'Preparing video data...', progress: 0, total: 100 });

    try {
      // Create a project ZIP in memory for rendering
      setRenderProgress({ step: 'Creating project package...', progress: 10, total: 100 });
      
      const zip = new JSZip();
      
      // Create project metadata
      const projectData = {
        projectName: selectedStory.title,
        createdAt: new Date().toISOString(),
        targetSceneCount: selectedStory.target_scene_count || generatedStoryboard.length,
        storyBulb: selectedStory,
        storyboard: generatedStoryboard,
        contentCounts: {
          scenes: generatedStoryboard.length,
          images: Object.keys(storyboardImages).length,
          voiceovers: Object.keys(storyboardVoiceovers).length
        }
      };
      
      zip.file('project-metadata.json', JSON.stringify(projectData, null, 2));
      zip.file('storyboard.json', JSON.stringify(generatedStoryboard, null, 2));
      
      // Add images with detailed progress
      const imagesFolder = zip.folder('images');
      const imageEntries = Object.entries(storyboardImages);
      console.log(`📦 Packaging ${imageEntries.length} images...`);
      
      for (let i = 0; i < imageEntries.length; i++) {
        const [sceneId, imageUrl] = imageEntries[i];
        if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('data:image/')) {
          const base64Data = imageUrl.split(',')[1];
          const extension = imageUrl.includes('data:image/png') ? 'png' : 'jpg';
          // Use base64 directly instead of converting to binary - JSZip can handle it
          imagesFolder?.file(`scene-${sceneId}.${extension}`, base64Data, { base64: true });
          
          // Update progress for each image (15-25% range for images)
          const imageProgress = 15 + Math.floor((i / imageEntries.length) * 10);
          setRenderProgress({ 
            step: `Packaging images... (${i + 1}/${imageEntries.length})`, 
            progress: imageProgress, 
            total: 100 
          });
          
          if (i % 5 === 0) {
            console.log(`  ✓ Packaged ${i + 1}/${imageEntries.length} images`);
          }
        }
      }
      console.log(`✅ All ${imageEntries.length} images packaged`);
      
      // Add voiceovers with detailed progress
      const voicesFolder = zip.folder('voiceovers');
      const voiceEntries = Object.entries(storyboardVoiceovers);
      console.log(`📦 Packaging ${voiceEntries.length} voiceovers...`);
      
      for (let i = 0; i < voiceEntries.length; i++) {
        const [sceneId, audioUrl] = voiceEntries[i];
        if (audioUrl && typeof audioUrl === 'string' && audioUrl.startsWith('data:audio/')) {
          const base64Data = audioUrl.split(',')[1];
          const extension = audioUrl.includes('data:audio/wav') ? 'wav' : 'mp3';
          // Use base64 directly instead of converting to binary - JSZip can handle it
          voicesFolder?.file(`scene-${sceneId}.${extension}`, base64Data, { base64: true });
          
          // Update progress for each voiceover (26-30% range for audio)
          const audioProgress = 26 + Math.floor((i / voiceEntries.length) * 4);
          setRenderProgress({ 
            step: `Packaging audio... (${i + 1}/${voiceEntries.length})`, 
            progress: audioProgress, 
            total: 100 
          });
        }
      }
      console.log(`✅ All ${voiceEntries.length} voiceovers packaged`);

      // Generate ZIP blob with progress reporting
      console.log('⏳ Starting ZIP generation...', new Date().toISOString());
      setRenderProgress({ step: 'Compressing project files...', progress: 31, total: 100 });
      
      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 1 } // Fast compression
      }, (metadata) => {
        // Progress callback during ZIP generation
        const zipProgress = 31 + Math.floor(metadata.percent * 0.19); // 31-50% range
        setRenderProgress({ 
          step: `Compressing project files... (${Math.floor(metadata.percent)}%)`, 
          progress: zipProgress, 
          total: 100 
        });
      });
      
      console.log('✅ ZIP generated:', zipBlob.size, 'bytes', new Date().toISOString());
      
      setRenderProgress({ step: 'Uploading to render service...', progress: 50, total: 100 });

      const formData = new FormData();
      formData.append('projectZip', zipBlob, `${selectedStory.title.replace(/[^a-z0-9]/gi, '-')}-render.zip`);

      console.log('📤 Sending ZIP to render API...', zipBlob.size, 'bytes');
      console.log('🌐 Starting fetch request to /api/render-video');

      const xhr = new XMLHttpRequest();

      const uploadPromise = new Promise<Response>((resolve, reject) => {
        let uploadComplete = false;
        let processingInterval: NodeJS.Timeout;

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percentComplete = (e.loaded / e.total) * 100;
            const uploadProgress = 50 + Math.floor(percentComplete * 0.2); // 50-70% range
            console.log(`📤 Upload progress: ${e.loaded}/${e.total} bytes (${percentComplete.toFixed(1)}%)`);
            setRenderProgress({
              step: `Uploading to render service... (${percentComplete.toFixed(0)}%)`,
              progress: uploadProgress,
              total: 100
            });

            // When upload is complete, start processing indicator
            if (percentComplete >= 100 && !uploadComplete) {
              uploadComplete = true;
              console.log('✅ Upload finished, waiting for server processing...');
              setRenderProgress({ step: 'Processing video on server (this may take 1-2 minutes)...', progress: 70, total: 100 });

              // Slowly increment progress while waiting
              let waitProgress = 70;
              processingInterval = setInterval(() => {
                if (waitProgress < 95) {
                  waitProgress += 1;
                  setRenderProgress({
                    step: `Processing video on server (this may take 1-2 minutes)... ${waitProgress - 70}s`,
                    progress: waitProgress,
                    total: 100
                  });
                }
              }, 1000);
            }
          }
        });

        xhr.addEventListener('load', () => {
          clearInterval(processingInterval);
          console.log('✅ Upload complete, status:', xhr.status);
          console.log('📥 Response received, length:', xhr.responseText?.length || 0, 'bytes');
          if (xhr.status >= 200 && xhr.status < 300) {
            setRenderProgress({ step: 'Server processing complete!', progress: 95, total: 100 });
            resolve(new Response(xhr.responseText, {
              status: xhr.status,
              statusText: xhr.statusText,
              headers: new Headers({
                'Content-Type': 'application/json'
              })
            }));
          } else {
            console.error('❌ Upload failed with status:', xhr.status);
            console.error('❌ Response text:', xhr.responseText);
            reject(new Error(`Upload failed with status: ${xhr.status}`));
          }
        });

        xhr.addEventListener('error', () => {
          console.error('❌ Network error during upload');
          reject(new Error('Network error during upload'));
        });

        xhr.addEventListener('timeout', () => {
          console.error('❌ Upload timeout');
          reject(new Error('Upload timeout'));
        });

        xhr.open('POST', '/api/render-video');
        xhr.send(formData);
      });

      const response = await uploadPromise;

      if (!response.ok) {
        const errorData = await response.json();
        console.error('❌ Render API error:', errorData);
        throw new Error(errorData.error || 'Video rendering failed');
      }

      const result = await response.json();
      console.log('✅ Render job created:', result);

      // Check if we got a job ID (background processing)
      if (result.jobId) {
        const jobId = result.jobId;
        console.log('🎬 Starting to poll for job status:', jobId);

        setRenderingVideo(true);
        setRenderProgress({ step: 'Initializing video render...', progress: 0, total: 100 });

        // Poll for job status
        const pollInterval = setInterval(async () => {
          try {
            const statusResponse = await fetch(`/api/render-status/${jobId}`);
            const statusData = await statusResponse.json();

            if (statusData.success && statusData.job) {
              const job = statusData.job;
              console.log(`📊 Job ${jobId} status:`, job.status, `(${job.progress}%)`);

              // Update progress
              const newProgress = {
                step: job.status === 'processing' ? `Rendering video... (${job.progress}%)` : job.status,
                progress: job.progress,
                total: 100
              };
              console.log('🔄 Updating renderProgress:', newProgress);
              setRenderProgress(newProgress);

              // Check if complete
              if (job.status === 'completed') {
                clearInterval(pollInterval);
                console.log('✅ Video rendering complete!');

                try {
                  setRenderProgress({ step: 'Fetching video...', progress: 95, total: 100 });
                  const videoResponse = await fetch(`/api/get-video/${jobId}`);
                  const videoData = await videoResponse.json();

                  if (videoData.success && videoData.videoUrl) {
                    console.log('📹 Setting final video URL:', videoData.videoUrl.substring(0, 100) + '...');
                    setFinalVideos([videoData.videoUrl]);
                    setRenderProgress({ step: 'Processing complete!', progress: 100, total: 100 });
                    setRenderingVideo(false);
                    setActiveTab('effects');
                    console.log('✅ Switched to effects tab');
                  } else {
                    throw new Error('Failed to retrieve video URL');
                  }
                } catch (videoError) {
                  console.error('❌ Failed to fetch video:', videoError);
                  throw new Error('Failed to retrieve completed video');
                }
              } else if (job.status === 'failed') {
                clearInterval(pollInterval);
                setRenderingVideo(false);
                throw new Error(job.error || 'Video rendering failed');
              }
            }
          } catch (pollError) {
            clearInterval(pollInterval);
            setRenderingVideo(false);
            console.error('❌ Polling error:', pollError);
            throw pollError;
          }
        }, 2000); // Poll every 2 seconds

        // Set a maximum timeout of 10 minutes
        setTimeout(() => {
          clearInterval(pollInterval);
          setRenderingVideo(false);
          console.error('❌ Rendering timeout after 10 minutes');
          setError('Video rendering timeout - please try again');
        }, 600000);
      } else {
        throw new Error('No job ID returned from server');
      }

    } catch (err) {
      console.error('❌ Video rendering error:', err);
      console.error('❌ Error type:', err instanceof Error ? err.constructor.name : typeof err);
      console.error('❌ Error message:', err instanceof Error ? err.message : String(err));
      console.error('❌ Error stack:', err instanceof Error ? err.stack : 'No stack trace');
      setError(err instanceof Error ? err.message : 'Failed to render video');
      setRenderingVideo(false);
      // Clear progress after a delay
      setTimeout(() => {
        setRenderProgress({ step: '', progress: 0, total: 100 });
      }, 3000);
    }
  };

  const addPrompt = (type: 'script' | 'image' | 'voiceover') => {
    if (type === 'script') {
      setScriptTitles([...scriptTitles, '']);
    } else if (type === 'image') {
      setImagePrompts([...imagePrompts, '']);
    } else {
      setVoiceoverTexts([...voiceoverTexts, '']);
    }
  };

  const removePrompt = (type: 'script' | 'image' | 'voiceover', index: number) => {
    if (type === 'script') {
      setScriptTitles(scriptTitles.filter((_, i) => i !== index));
    } else if (type === 'image') {
      setImagePrompts(imagePrompts.filter((_, i) => i !== index));
    } else {
      setVoiceoverTexts(voiceoverTexts.filter((_, i) => i !== index));
    }
  };

  const updatePrompt = (type: 'script' | 'image' | 'voiceover', index: number, value: string) => {
    if (type === 'script') {
      const updated = [...scriptTitles];
      updated[index] = value;
      setScriptTitles(updated);
    } else if (type === 'image') {
      const updated = [...imagePrompts];
      updated[index] = value;
      setImagePrompts(updated);
    } else {
      const updated = [...voiceoverTexts];
      updated[index] = value;
      setVoiceoverTexts(updated);
    }
  };

  // Download all generated content as ZIP
  const downloadProjectAsZip = async () => {
    if (!selectedStory || generatedStoryboard.length === 0) {
      setError('No content to download. Generate a storyboard first.');
      return;
    }

    try {
      const zip = new JSZip();
      
      // Create project metadata
      const projectData = {
        projectName: selectedStory.title,
        createdAt: new Date().toISOString(),
        targetSceneCount: selectedStory.target_scene_count || generatedStoryboard.length,
        storyBulb: selectedStory,
        storyboard: generatedStoryboard,
        contentCounts: {
          scenes: generatedStoryboard.length,
          images: Object.keys(storyboardImages).length,
          voiceovers: Object.keys(storyboardVoiceovers).length
        }
      };
      
      // Add project metadata
      zip.file('project-metadata.json', JSON.stringify(projectData, null, 2));
      
      // Add storyboard data
      zip.file('storyboard.json', JSON.stringify(generatedStoryboard, null, 2));
      
      // Add images folder
      const imagesFolder = zip.folder('images');
      for (const [sceneId, imageUrl] of Object.entries(storyboardImages)) {
        if (imageUrl && typeof imageUrl === 'string') {
          try {
            // Convert base64 to binary for images
            if (imageUrl.startsWith('data:image/')) {
              const base64Data = imageUrl.split(',')[1];
              const binaryData = atob(base64Data);
              const bytes = new Uint8Array(binaryData.length);
              for (let i = 0; i < binaryData.length; i++) {
                bytes[i] = binaryData.charCodeAt(i);
              }
              const extension = imageUrl.includes('data:image/png') ? 'png' : 'jpg';
              imagesFolder?.file(`scene-${sceneId}.${extension}`, bytes);
            }
          } catch (err) {
            console.warn(`Failed to process image for scene ${sceneId}:`, err);
          }
        }
      }
      
      // Add voiceovers folder
      const voicesFolder = zip.folder('voiceovers');
      for (const [sceneId, audioUrl] of Object.entries(storyboardVoiceovers)) {
        if (audioUrl && typeof audioUrl === 'string') {
          try {
            // Convert base64 to binary for audio
            if (audioUrl.startsWith('data:audio/')) {
              const base64Data = audioUrl.split(',')[1];
              const binaryData = atob(base64Data);
              const bytes = new Uint8Array(binaryData.length);
              for (let i = 0; i < binaryData.length; i++) {
                bytes[i] = binaryData.charCodeAt(i);
              }
              const extension = audioUrl.includes('data:audio/wav') ? 'wav' : 'mp3';
              voicesFolder?.file(`scene-${sceneId}.${extension}`, bytes);
            }
          } catch (err) {
            console.warn(`Failed to process audio for scene ${sceneId}:`, err);
          }
        }
      }
      
      // Generate and download ZIP
      const content = await zip.generateAsync({type: 'blob'});
      const url = window.URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${selectedStory.title.replace(/[^a-z0-9]/gi, '-')}-project.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      console.log('Project downloaded successfully as ZIP');
    } catch (error) {
      console.error('Failed to create ZIP:', error);
      setError('Failed to create download. Please try again.');
    }
  };

  // Upload and restore project from ZIP
  const uploadProjectFromZip = async (file: File) => {
    console.log('🔄 Starting ZIP upload process...', file.name, file.size);
    try {
      const zip = await JSZip.loadAsync(file);
      console.log('✅ ZIP loaded successfully');
      
      // Read project metadata
      const metadataFile = zip.file('project-metadata.json');
      if (!metadataFile) {
        throw new Error('Invalid project file: missing metadata');
      }
      
      const metadata = JSON.parse(await metadataFile.async('string'));
      const storyboardFile = zip.file('storyboard.json');
      if (!storyboardFile) {
        throw new Error('Invalid project file: missing storyboard data');
      }
      
      const storyboardData = JSON.parse(await storyboardFile.async('string'));
      
      // Restore story bulb and storyboard
      setSelectedStory(metadata.storyBulb);
      setGeneratedStoryboard(storyboardData);
      setTargetSceneCount(metadata.targetSceneCount || 30);
      
      // Restore images - iterate through all ZIP files and filter for images folder
      const images: { [key: string]: string } = {};
      console.log('🖼️ Processing images...');
      
      for (const [filename, file] of Object.entries(zip.files)) {
        if (!file.dir && filename.startsWith('images/') && filename.match(/\.(png|jpg|jpeg)$/i)) {
          // Extract the key (e.g., "1_0" from "images/scene-1_0.png")
          const baseName = filename.split('/').pop() || filename;
          const imageKey = baseName.replace(/\.(png|jpg|jpeg)$/i, '').replace(/^scene-/, '');
          console.log('🔍 Processing image:', filename, 'Key:', imageKey);
          
          try {
            const base64 = await file.async('base64');
            const extension = filename.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
            images[imageKey] = `data:image/${extension};base64,${base64}`;
            console.log('✅ Successfully processed image:', imageKey);
          } catch (err) {
            console.error('❌ Failed to process image:', filename, err);
          }
        }
      }
      console.log('Restored images:', Object.keys(images));
      setStoryboardImages(images);
      
      // Restore voiceovers - iterate through all ZIP files and filter for voiceovers folder  
      const voiceovers: { [key: string]: string } = {};
      console.log('🎤 Processing voiceovers...');
      
      for (const [filename, file] of Object.entries(zip.files)) {
        if (!file.dir && filename.startsWith('voiceovers/') && filename.match(/\.(wav|mp3|mpeg)$/i)) {
          const sceneId = filename.match(/scene-(\d+)/)?.[1];
          console.log('🔍 Processing voiceover:', filename, 'Scene ID:', sceneId);
          if (sceneId) {
            try {
              const base64 = await file.async('base64');
              const extension = filename.toLowerCase().endsWith('.wav') ? 'wav' : 'mpeg';
              voiceovers[parseInt(sceneId)] = `data:audio/${extension};base64,${base64}`;
              console.log('✅ Successfully processed voiceover:', sceneId);
            } catch (err) {
              console.error('❌ Failed to process voiceover:', filename, err);
            }
          }
        }
      }
      console.log('Restored voiceovers:', Object.keys(voiceovers));
      setStoryboardVoiceovers(voiceovers);
      
      // Switch to storyboard tab to show loaded content
      setActiveTab('storyboard');
      
      console.log('Project loaded successfully from ZIP');
      console.log('Final state - Storyboard scenes:', storyboardData.length);
      console.log('Final state - Images count:', Object.keys(images).length);  
      console.log('Final state - Voiceovers count:', Object.keys(voiceovers).length);
    } catch (error) {
      console.error('Failed to load ZIP:', error);
      setError(`Failed to load project file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  // Generate a unique project ID
  const generateProjectId = () => {
    return `proj_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  };

  // Save project to database
  const saveProject = useCallback(async () => {
    if (!selectedStory) return;

    // Generate ID if this is a new project
    const projectId = currentProjectId || generateProjectId();
    if (!currentProjectId) {
      setCurrentProjectId(projectId);
    }

    setIsSaving(true);
    try {
      // Get first scene image as thumbnail
      const thumbnail = storyboardImages['1_0'] || storyboardImages['1'] || null;

      const projectData = {
        storyBulb: selectedStory,
        storyboard: generatedStoryboard,
        storyboardImages,
        storyboardVoiceovers,
        voiceoverDurations,
        activeTab
      };

      const response = await fetch('/api/projects/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          title: selectedStory.title,
          thumbnail,
          projectData
        })
      });

      const data = await response.json();
      if (data.success) {
        setLastSaved(new Date());
        console.log('Project saved:', projectId);
      } else {
        console.error('Failed to save project:', data.error);
      }
    } catch (err) {
      console.error('Error saving project:', err);
    } finally {
      setIsSaving(false);
    }
  }, [selectedStory, currentProjectId, generatedStoryboard, storyboardImages, storyboardVoiceovers, voiceoverDurations, activeTab]);

  // Debounced auto-save
  const debouncedSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveProject();
    }, 2000);
  }, [saveProject]);

  // Load project from database
  const loadProject = async (projectId: string) => {
    try {
      const response = await fetch(`/api/projects/${projectId}`);
      const data = await response.json();

      if (data.success && data.project) {
        const { projectData } = data.project;

        // Restore all state
        if (projectData.storyBulb) {
          setGeneratedStories([projectData.storyBulb]);
          setSelectedStory(projectData.storyBulb);
        }
        if (projectData.storyboard) {
          setGeneratedStoryboard(projectData.storyboard);
        }
        if (projectData.storyboardImages) {
          setStoryboardImages(projectData.storyboardImages);
        }
        if (projectData.storyboardVoiceovers) {
          setStoryboardVoiceovers(projectData.storyboardVoiceovers);
        }
        if (projectData.voiceoverDurations) {
          setVoiceoverDurations(projectData.voiceoverDurations);
        }
        if (projectData.activeTab) {
          setActiveTab(projectData.activeTab);
        }

        setCurrentProjectId(projectId);
        setCurrentView('creator');
        setLastSaved(new Date(data.project.updatedAt));
        console.log('Project loaded:', projectId);
      }
    } catch (err) {
      console.error('Error loading project:', err);
      setError('Failed to load project');
    }
  };

  // Delete project from database
  const deleteProject = async (projectId: string) => {
    if (!confirm('Are you sure you want to delete this project?')) return;

    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE'
      });
      const data = await response.json();

      if (data.success) {
        // Refresh library
        fetchLibraryProjects();
        // If we deleted the current project, clear it
        if (currentProjectId === projectId) {
          setCurrentProjectId(null);
        }
      }
    } catch (err) {
      console.error('Error deleting project:', err);
    }
  };

  // Fetch library projects
  const fetchLibraryProjects = async () => {
    setLibraryLoading(true);
    try {
      const response = await fetch('/api/projects');
      const data = await response.json();

      if (data.success) {
        setLibraryProjects(data.projects);
      }
    } catch (err) {
      console.error('Error fetching projects:', err);
    } finally {
      setLibraryLoading(false);
    }
  };

  // Clipping: fetch projects
  const fetchClippingProjects = async () => {
    setClippingLoading(true);
    try {
      const response = await fetch('/api/clipping/projects');
      const data = await response.json();
      if (data.projects) {
        setClippingProjects(data.projects);
      }
    } catch (err) {
      console.error('Error fetching clipping projects:', err);
    } finally {
      setClippingLoading(false);
    }
  };

  const createClippingProject = async () => {
    try {
      const response = await fetch('/api/clipping/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newProjectTitle || 'Untitled' }),
      });
      const data = await response.json();
      if (data.project) {
        setClippingProjects(prev => [data.project, ...prev]);
      }
    } catch (err) {
      console.error('Error creating clipping project:', err);
    }
  };

  const startClippingAnalysis = async (projectId: string, videoUrl: string, videoDuration?: number) => {
    try {
      console.log('[clipping] Starting analysis:', { projectId, videoUrl: videoUrl?.substring(0, 50), videoDuration });
      const response = await fetch('/api/clipping/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, videoUrl, videoDuration }),
      });

      console.log('[clipping] Analyze response:', response.status, response.statusText);
      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Failed to start analysis: ${response.status} ${errText}`);
      }

      const reader = response.body.getReader();
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
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'progress') {
                setClippingProcessSteps(prev =>
                  prev.map(s => {
                    if (s.label === data.step) {
                      const pct = data.progress || 0;
                      return { ...s, status: data.status, progress: pct };
                    }
                    return s;
                  })
                );
              } else if (eventType === 'complete') {
                // Analysis done — now generate clips
                startClipGeneration(projectId);
              } else if (eventType === 'error') {
                console.error('Analysis error:', data.error);
                setClippingProcessSteps(prev =>
                  prev.map(s => s.status === 'active' ? { ...s, status: 'pending' } : s)
                );
              }
            } catch { /* skip malformed */ }
          }
        }
      }
    } catch (err) {
      console.error('Error in clipping analysis:', err);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setClippingProcessSteps(prev =>
        prev.map(s => s.status === 'active' ? { ...s, detail: `Error: ${msg}` } : s)
      );
    }
  };

  const startClipGeneration = async (projectId: string) => {
    setClippingProcessSteps(prev => [
      ...prev.map(s => ({ ...s, status: 'done' as const })),
      { label: 'Selecting clips', status: 'active' as const },
      { label: 'Cutting clips', status: 'pending' as const },
    ]);

    try {
      const response = await fetch('/api/clipping/generate-clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, clipLength: clippingClipLength }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to start clip generation');
      }

      const reader = response.body.getReader();
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
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'progress') {
                setClippingProcessSteps(prev =>
                  prev.map(s => {
                    if (s.label === data.step) {
                      const detail = data.total
                        ? `${data.completed || 0}/${data.total} clips`
                        : undefined;
                      return { ...s, status: data.status, progress: data.progress, detail };
                    }
                    return s;
                  })
                );
              } else if (eventType === 'complete') {
                // Fetch generated clips and show clips view
                const clipsRes = await fetch(`/api/clipping/clips?projectId=${projectId}`);
                const clipsData = await clipsRes.json();
                if (clipsData.clips) {
                  setClippingGeneratedClips(clipsData.clips);
                  setClippingSelectedClipIdx(0);
                  setClippingStep('clips');
                }
              } else if (eventType === 'error') {
                console.error('Clip generation error:', data.error);
              }
            } catch { /* skip malformed */ }
          }
        }
      }
    } catch (err) {
      console.error('Error in clip generation:', err);
    }
  };

  const deleteClippingProject = async (id: string) => {
    try {
      await fetch(`/api/clipping/projects/${id}`, { method: 'DELETE' });
      setClippingProjects(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      console.error('Error deleting clipping project:', err);
    }
  };

  // Feed Spy: fetch data from our DB
  const fetchSpyData = useCallback(async () => {
    setSpyLoading(true);
    try {
      const params = new URLSearchParams({ sort: spySort, limit: '200', minViews: spyMinViews, rsMaxChannels, rsMaxAge, rsMinViews });
      if (spyMaxAge) params.set('maxChannelAge', spyMaxAge);
      const response = await fetch(`/api/feed-spy?${params}`);
      const data = await response.json();
      if (data.success) {
        setSpyData(data);
      }
    } catch (err) {
      console.error('Error fetching spy data:', err);
    } finally {
      setSpyLoading(false);
    }
  }, [spySort, spyMinViews, spyMaxAge, rsMaxChannels, rsMaxAge, rsMinViews]);

  // Build feed query params from filters
  const buildFeedParams = useCallback((offset: number) => {
    const params = new URLSearchParams({ limit: '50', offset: String(offset) });
    if (feedFilters.maxAge !== '0') params.set('maxAge', feedFilters.maxAge);
    if (feedFilters.minSubs !== '0') params.set('minSubs', feedFilters.minSubs);
    if (feedFilters.maxSubs !== '0') params.set('maxSubs', feedFilters.maxSubs);
    if (feedFilters.minViews !== '0') params.set('minViews', feedFilters.minViews);
    if (feedFilters.sort !== 'velocity') params.set('sort', feedFilters.sort);
    if (session?.user?.id) params.set('userId', session.user.id);
    return params.toString();
  }, [feedFilters, session?.user?.id]);

  // Shorts Feed: fetch channels with nested videos
  const feedAbortRef = useRef<AbortController | null>(null);
  const fetchFeedData = useCallback(async () => {
    // Cancel any in-flight feed request
    if (feedAbortRef.current) feedAbortRef.current.abort();
    const controller = new AbortController();
    feedAbortRef.current = controller;
    setFeedLoading(true);
    try {
      const response = await fetch(`/api/feed-spy/feed?${buildFeedParams(0)}`, {
        signal: controller.signal,
      });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (data.success) {
        setFeedChannels(data.channels);
        setFeedOffset(data.channels.length);
        setFeedHasMore(data.hasMore);
        setFeedTotalChannels(data.totalChannels ?? 0);
        if (data.unseenChannels != null) setFeedUnseenChannels(data.unseenChannels);
        else setFeedUnseenChannels(null);
        setFeedChannelIndex(0);
        setFeedVideoIndex(0);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('Error fetching feed data:', err);
    } finally {
      if (!controller.signal.aborted) setFeedLoading(false);
    }
  }, [buildFeedParams]);

  const loadMoreFeedData = useCallback(async () => {
    if (feedLoadingRef.current || !feedHasMore) return;
    feedLoadingRef.current = true;
    setFeedLoading(true);
    try {
      const response = await fetch(`/api/feed-spy/feed?${buildFeedParams(feedOffset)}`);
      const data = await response.json();
      if (data.success) {
        setFeedChannels((prev) => [...prev, ...data.channels]);
        setFeedOffset((prev) => prev + data.channels.length);
        setFeedHasMore(data.hasMore);
      }
    } catch (err) {
      console.error('Error loading more feed data:', err);
    } finally {
      feedLoadingRef.current = false;
      setFeedLoading(false);
    }
  }, [feedHasMore, feedOffset, buildFeedParams]);

  // Fetch full shorts catalog for a channel via YouTube Data API
  const fetchChannelVideos = useCallback(async (channelId: string) => {
    try {
      const response = await fetch(`/api/feed-spy/channel-videos?channelId=${encodeURIComponent(channelId)}`);
      const data = await response.json();
      if (data.success && data.videos) {
        const resolved = data.resolvedChannelId || channelId;
        setFeedChannels((prev) =>
          prev.map((ch) => {
            if (ch.channel_id !== channelId) return ch;
            // Merge: keep existing videos, add new ones by video_id
            const existingIds = new Set(ch.videos.map((v) => v.video_id));
            const newVideos = data.videos.filter((v: { video_id: string }) => !existingIds.has(v.video_id));
            if (newVideos.length === 0) return ch;
            // Update channel_id if it was resolved from @handle to UC...
            return { ...ch, channel_id: resolved, videos: [...ch.videos, ...newVideos] };
          })
        );
      }
    } catch (err) {
      console.error('Error fetching channel videos:', err);
    }
  }, []);

  // Mark a channel as seen (logged-in users only)
  const markChannelSeen = useCallback((channelId: string) => {
    if (!session?.user?.id) return;
    fetch('/api/user/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId }),
    }).then(() => {
      setFeedUnseenChannels((prev) => prev != null ? Math.max(0, prev - 1) : null);
    }).catch(() => {});
  }, [session?.user?.id]);

  // Re-fetch feed when filters change or session loads
  const feedFiltersKey = JSON.stringify(feedFilters);
  const sessionUserId = session?.user?.id || '';
  useEffect(() => {
    if (currentView === 'feed') {
      fetchFeedData();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedFiltersKey, sessionUserId]);

  // Start a new project
  const startNewProject = () => {
    setCurrentProjectId(null);
    setGeneratedStories([]);
    setSelectedStory(null);
    setGeneratedStoryboard([]);
    setStoryboardImages({});
    setStoryboardVoiceovers({});
    setVoiceoverDurations({});
    setActiveTab('scripts');
    setLastSaved(null);
    setCurrentView('creator');
  };

  // Auto-save triggers - save when story bulb is generated (don't require storyboard)
  useEffect(() => {
    if (selectedStory) {
      debouncedSave();
    }
  }, [selectedStory, generatedStoryboard, storyboardImages, storyboardVoiceovers, debouncedSave]);

  // Fetch data when switching views or filters change
  useEffect(() => {
    if (currentView === 'library') {
      fetchLibraryProjects();
    } else if (currentView === 'spy') {
      fetchSpyData();
    } else if (currentView === 'feed' && feedChannels.length === 0) {
      fetchFeedData();
    } else if (currentView === 'clipping') {
      fetchClippingProjects();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, fetchSpyData]);

  // Save on page unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (selectedStory) {
        // Synchronous save attempt (may not complete)
        saveProject();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [selectedStory, saveProject]);

  return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 flex">
        {/* Sidebar Navigation — hidden on mobile when in feed view */}
        <aside className={`w-16 bg-gray-900/80 border-r border-gray-700 flex flex-col items-center py-4 fixed h-full z-50 transition-transform ${
          currentView === 'feed' ? 'max-md:-translate-x-full' : ''
        }`}>
          {/* Logo */}
          <div className="mb-6">
            <div className="w-10 h-10 bg-gradient-to-br from-purple-600 to-pink-600 rounded-xl flex items-center justify-center text-white font-bold text-lg">
              H
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 flex flex-col gap-2">
            {visibleTabs.includes('creator') && (
              <button
                onClick={() => setCurrentView('creator')}
                className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                  currentView === 'creator'
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                }`}
                title="Creator"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
            )}
            {visibleTabs.includes('library') && (
              <button
                onClick={() => setCurrentView('library')}
                className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                  currentView === 'library'
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                }`}
                title="Library"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </button>
            )}
            {visibleTabs.includes('spy') && (
              <button
                onClick={() => setCurrentView('spy')}
                className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                  currentView === 'spy'
                    ? 'bg-red-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                }`}
                title="Feed Spy"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </button>
            )}
            {visibleTabs.includes('feed') && (
              <button
                onClick={() => setCurrentView('feed')}
                className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                  currentView === 'feed'
                    ? 'bg-pink-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                }`}
                title="Shorts Feed"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            )}
            {visibleTabs.includes('clipping') && (
              <button
                onClick={() => setCurrentView('clipping')}
                className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                  currentView === 'clipping'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                }`}
                title="Clipping"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
                </svg>
              </button>
            )}
            {visibleTabs.includes('niche') && (
              <button
                onClick={() => setCurrentView('niche')}
                className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                  currentView === 'niche'
                    ? 'bg-amber-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                }`}
                title="Niche Explorer"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </button>
            )}
          </nav>

          {/* Bottom Section */}
          <div className="flex flex-col gap-2 items-center">
            {/* Save Status */}
            {currentView === 'creator' && selectedStory && (
              <div className="w-10 h-10 flex items-center justify-center" title={lastSaved ? `Last saved: ${lastSaved.toLocaleTimeString()}` : 'Not saved'}>
                {isSaving ? (
                  <div className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                ) : lastSaved ? (
                  <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                  </svg>
                )}
              </div>
            )}

            {/* API Token */}
            <ApiTokenPopover />

            {/* Auth */}
            <AuthButton variant="sidebar" />

            {/* New Project */}
            <button
              onClick={startNewProject}
              className="w-10 h-10 bg-gray-800 text-gray-400 hover:bg-purple-600 hover:text-white rounded-xl flex items-center justify-center transition-all"
              title="New Project"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        </aside>

        {/* Shorts Feed View — edge to edge, sidebar floats on top */}
        {currentView === 'feed' && (
          <FeedViewer
            channels={feedChannels}
            loading={feedLoading}
            channelIndex={feedChannelIndex}
            videoIndex={feedVideoIndex}
            onChannelChange={setFeedChannelIndex}
            onVideoChange={setFeedVideoIndex}
            onLoadMore={loadMoreFeedData}
            onFetchChannelVideos={fetchChannelVideos}
            filters={feedFilters}
            onFiltersChange={setFeedFilters}
            totalChannels={feedTotalChannels}
            unseenChannels={feedUnseenChannels}
            onChannelSeen={markChannelSeen}
          />
        )}

        {/* Main Content Area */}
        <div className="flex-1 ml-16">
          {currentView === 'spy' ? (
            /* Feed Spy View */
            <div className="container mx-auto px-4 py-8 max-w-7xl">
              {/* Header */}
              <div className="mb-8">
                <h1 className="text-3xl font-bold text-white mb-2">
                  <span className="bg-gradient-to-r from-red-400 to-orange-500 bg-clip-text text-transparent">Feed Spy</span>
                </h1>
                <p className="text-gray-400">YouTube Shorts intelligence — discover trending niches and rising channels</p>
              </div>

              {/* Stats Bar */}
              {spyData?.stats && (
                <div className="grid grid-cols-4 gap-4 mb-8">
                  {[
                    { label: 'Videos Tracked', value: parseInt(spyData.stats.total_videos).toLocaleString(), color: 'from-blue-500 to-cyan-500' },
                    { label: 'Channels', value: parseInt(spyData.stats.total_channels).toLocaleString(), color: 'from-purple-500 to-pink-500' },
                    { label: 'Data Points', value: parseInt(spyData.stats.total_sightings).toLocaleString(), color: 'from-orange-500 to-red-500' },
                    { label: 'Collections', value: parseInt(spyData.stats.total_collections).toLocaleString(), color: 'from-green-500 to-emerald-500' },
                  ].map((stat, i) => (
                    <div key={i} className="bg-gray-800/50 rounded-xl border border-gray-700 p-4">
                      <div className={`text-2xl font-bold bg-gradient-to-r ${stat.color} bg-clip-text text-transparent`}>{stat.value}</div>
                      <div className="text-sm text-gray-400">{stat.label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Rising Stars */}
              {spyData?.risingStars && spyData.risingStars.length > 0 && (
                <div className="mb-8">
                  <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2 flex-wrap">
                      <span className="text-2xl">🚀</span> Rising Stars
                      {spyData.risingStarsCount && (
                        <span className="text-sm font-normal text-gray-400">
                          — {spyData.risingStarsCount.total} total
                          {spyData.risingStarsCount.addedToday > 0 && (
                            <span className="text-green-400 ml-1">(+{spyData.risingStarsCount.addedToday} today)</span>
                          )}
                        </span>
                      )}
                    </h2>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs text-gray-500">Show</label>
                        <select value={rsMaxChannels} onChange={(e) => setRsMaxChannels(e.target.value)} className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-white text-xs">
                          <option value="4">4</option>
                          <option value="8">8</option>
                          <option value="12">12</option>
                          <option value="20">20</option>
                          <option value="50">50</option>
                        </select>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs text-gray-500">Max age</label>
                        <select value={rsMaxAge} onChange={(e) => setRsMaxAge(e.target.value)} className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-white text-xs">
                          <option value="30">30 days</option>
                          <option value="90">90 days</option>
                          <option value="180">6 months</option>
                          <option value="365">1 year</option>
                          <option value="730">2 years</option>
                        </select>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs text-gray-500">Min views</label>
                        <select value={rsMinViews} onChange={(e) => setRsMinViews(e.target.value)} className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-white text-xs">
                          <option value="0">All</option>
                          <option value="1000">1K+</option>
                          <option value="10000">10K+</option>
                          <option value="100000">100K+</option>
                          <option value="1000000">1M+</option>
                        </select>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    {[...spyData.risingStars].sort((a, b) => {
                      const ageA = a.channel_creation_date ? Date.now() - new Date(a.channel_creation_date).getTime() : Infinity;
                      const ageB = b.channel_creation_date ? Date.now() - new Date(b.channel_creation_date).getTime() : Infinity;
                      return ageA - ageB;
                    }).map((star) => {
                      const ageDays = star.channel_creation_date
                        ? Math.floor((Date.now() - new Date(star.channel_creation_date).getTime()) / 86400000)
                        : null;
                      const isNew = star.first_seen_at && new Date(star.first_seen_at).toDateString() === new Date().toDateString();
                      return (
                        <div key={star.channel_id} className={`bg-gradient-to-br from-gray-800/80 to-gray-900/80 rounded-xl border p-4 hover:border-orange-500/60 transition relative ${isNew ? 'border-green-500/50' : 'border-orange-500/30'}`}>
                          {isNew && (
                            <span className="absolute -top-2 -right-2 bg-green-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-lg">
                              NEW!
                            </span>
                          )}
                          <div className="flex items-start gap-3 mb-2">
                            {star.avatar_url ? (
                              <img src={star.avatar_url} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
                            ) : (
                              <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center text-gray-400 text-sm font-bold flex-shrink-0">
                                {star.channel_name?.charAt(0)?.toUpperCase() || '?'}
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <a href={star.channel_url} target="_blank" rel="noopener noreferrer" className="text-white font-semibold hover:text-orange-400 transition truncate block">
                                {star.channel_name}
                              </a>
                              {ageDays !== null && (
                                <span className="text-xs text-orange-300/70">{ageDays}d old</span>
                              )}
                            </div>
                          </div>
                          <div className="text-2xl font-bold text-orange-400">{parseInt(star.total_views).toLocaleString()}</div>
                          <div className="text-xs text-gray-400">total views across {star.video_count} video{parseInt(star.video_count) !== 1 ? 's' : ''}</div>
                          {(star.subscriber_count || star.total_video_count) && (
                            <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
                              {star.subscriber_count && (
                                <span>
                                  {parseInt(star.subscriber_count) >= 1000000
                                    ? `${(parseInt(star.subscriber_count) / 1000000).toFixed(1)}M subs`
                                    : parseInt(star.subscriber_count) >= 1000
                                      ? `${(parseInt(star.subscriber_count) / 1000).toFixed(1)}K subs`
                                      : `${parseInt(star.subscriber_count)} subs`}
                                </span>
                              )}
                              {star.subscriber_count && star.total_video_count && (
                                <span className="text-gray-600">|</span>
                              )}
                              {star.total_video_count && (
                                <span>{parseInt(star.total_video_count).toLocaleString()} videos</span>
                              )}
                            </div>
                          )}
                          <div className="mt-2 flex items-center justify-between">
                            <div className="text-xs text-gray-500">
                              Best: {parseInt(star.max_views).toLocaleString()} views | Seen {star.sighting_count}x
                            </div>
                            <div className="relative group">
                              <svg className="w-4 h-4 text-gray-600 hover:text-gray-400 cursor-help transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <div className="absolute bottom-full right-0 mb-2 w-48 bg-gray-900 border border-gray-700 rounded-lg p-2.5 text-xs hidden group-hover:block z-10 shadow-xl">
                                <div className="text-gray-400 space-y-1">
                                  <div>First seen: <span className="text-gray-200">{new Date(star.first_seen_at).toLocaleDateString()}</span></div>
                                  <div>Last updated: <span className="text-gray-200">{new Date(star.last_seen_at).toLocaleDateString()}</span></div>
                                  {star.channel_creation_date && (
                                    <div>Created: <span className="text-gray-200">{new Date(star.channel_creation_date).toLocaleDateString()}</span></div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Filters */}
              <div className="bg-gray-800/50 rounded-xl border border-gray-700 p-4 mb-6 flex flex-wrap gap-4 items-center">
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Sort by</label>
                  <select
                    value={spySort}
                    onChange={(e) => { setSpySort(e.target.value); }}
                    className="bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-white text-sm"
                  >
                    <option value="view_count">Views</option>
                    <option value="like_count">Likes</option>
                    <option value="comment_count">Comments</option>
                    <option value="duration_seconds">Duration</option>
                    <option value="collected_at">Recently Collected</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Min Views</label>
                  <select
                    value={spyMinViews}
                    onChange={(e) => { setSpyMinViews(e.target.value); }}
                    className="bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-white text-sm"
                  >
                    <option value="0">All</option>
                    <option value="1000">1K+</option>
                    <option value="10000">10K+</option>
                    <option value="100000">100K+</option>
                    <option value="1000000">1M+</option>
                    <option value="10000000">10M+</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Channel Age</label>
                  <select
                    value={spyMaxAge}
                    onChange={(e) => { setSpyMaxAge(e.target.value); }}
                    className="bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-white text-sm"
                  >
                    <option value="">Any age</option>
                    <option value="30">Under 30 days</option>
                    <option value="90">Under 90 days</option>
                    <option value="180">Under 6 months</option>
                    <option value="365">Under 1 year</option>
                  </select>
                </div>
                <button
                  onClick={fetchSpyData}
                  className="mt-4 px-4 py-1.5 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition text-sm"
                >
                  Apply Filters
                </button>
                {spyData && <span className="mt-4 text-sm text-gray-400">{spyData.total} results</span>}
              </div>

              {/* Video Table */}
              {spyLoading ? (
                <div className="flex items-center justify-center py-20">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-500" />
                </div>
              ) : !spyData || spyData.videos.length === 0 ? (
                <div className="text-center py-20">
                  <div className="text-6xl mb-4">📡</div>
                  <h3 className="text-xl font-semibold text-white mb-2">No data yet</h3>
                  <p className="text-gray-400 mb-6">Click &quot;Sync New Data&quot; to pull data from the feed spy</p>
                </div>
              ) : (
                <div className="bg-gray-800/50 rounded-xl border border-gray-700 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-gray-700 text-left">
                          <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Video</th>
                          <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Channel</th>
                          <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Views</th>
                          <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Likes</th>
                          <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Comments</th>
                          <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Duration</th>
                          <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Ch. Age</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-700/50">
                        {spyData.videos.map((video, idx) => {
                          const ageDays = video.channel_creation_date
                            ? Math.floor((Date.now() - new Date(video.channel_creation_date).getTime()) / 86400000)
                            : null;
                          const isNewChannel = ageDays !== null && ageDays < 180;
                          return (
                            <tr key={`${video.video_id}-${idx}`} className={`hover:bg-gray-700/30 transition ${isNewChannel ? 'bg-orange-500/5' : ''}`}>
                              <td className="px-4 py-3 max-w-xs">
                                <a href={video.video_url} target="_blank" rel="noopener noreferrer" className="text-sm text-white hover:text-blue-400 transition line-clamp-2">
                                  {video.title || video.video_id}
                                </a>
                                {video.upload_date && <div className="text-xs text-gray-500 mt-0.5">{video.upload_date}</div>}
                              </td>
                              <td className="px-4 py-3">
                                <a href={video.channel_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-gray-300 hover:text-white transition">
                                  {video.avatar_url ? (
                                    <img src={video.avatar_url} alt="" className="w-6 h-6 rounded-full flex-shrink-0" />
                                  ) : (
                                    <div className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center text-gray-400 text-[10px] font-bold flex-shrink-0">
                                      {video.channel_name?.charAt(0)?.toUpperCase() || '?'}
                                    </div>
                                  )}
                                  {video.channel_name}
                                </a>
                              </td>
                              <td className="px-4 py-3 text-right">
                                {video.view_count ? (
                                  <span className={`text-sm font-medium ${video.view_count >= 10000000 ? 'text-orange-400' : video.view_count >= 1000000 ? 'text-yellow-400' : 'text-white'}`}>
                                    {video.view_count >= 1000000
                                      ? `${(video.view_count / 1000000).toFixed(1)}M`
                                      : video.view_count >= 1000
                                        ? `${(video.view_count / 1000).toFixed(1)}K`
                                        : video.view_count.toLocaleString()
                                    }
                                  </span>
                                ) : <span className="text-gray-600">—</span>}
                              </td>
                              <td className="px-4 py-3 text-right text-sm text-gray-300">
                                {video.like_count ? `${(video.like_count / 1000).toFixed(1)}K` : '—'}
                              </td>
                              <td className="px-4 py-3 text-right text-sm text-gray-300">
                                {video.comment_count ? video.comment_count.toLocaleString() : '—'}
                              </td>
                              <td className="px-4 py-3 text-right text-sm text-gray-300">{video.duration_seconds}s</td>
                              <td className="px-4 py-3 text-right">
                                {ageDays !== null ? (
                                  <span className={`text-sm ${isNewChannel ? 'text-orange-400 font-medium' : 'text-gray-400'}`}>
                                    {ageDays < 30 ? `${ageDays}d` : ageDays < 365 ? `${Math.floor(ageDays / 30)}mo` : `${Math.floor(ageDays / 365)}y`}
                                  </span>
                                ) : <span className="text-gray-600">—</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : currentView === 'clipping' ? (
            /* Clipping View */
            showNewProjectModal ? (
              /* New Project Flow */
              <div className="flex flex-col items-center min-h-screen px-4">
                {/* Back button */}
                <div className="fixed top-4 left-20 z-10">
                  <button
                    onClick={() => {
                      if (clippingStep === 'configure' || clippingStep === 'processing') {
                        setClippingStep(clippingStep === 'processing' ? 'configure' : 'upload');
                      } else {
                        setShowNewProjectModal(false);
                        setClippingStep('upload');
                        setClippingFile(null);
                        setClippingUploadProgress(0);
                      }
                    }}
                    className="flex items-center gap-2 text-gray-400 hover:text-white transition"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    <span className="text-sm font-medium">{clippingStep === 'upload' ? 'Back to projects' : 'Back'}</span>
                  </button>
                </div>

                {clippingStep === 'upload' ? (
                  /* Step 1: Upload */
                  <div className="w-full max-w-2xl space-y-6 mt-32">
                    {/* Video link input */}
                    <div className="flex items-center bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3 gap-3 focus-within:border-blue-500 transition">
                      <svg className="w-5 h-5 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                      <input
                        type="text"
                        value={newProjectTitle}
                        onChange={e => setNewProjectTitle(e.target.value)}
                        placeholder="Drop a video link"
                        className="flex-1 bg-transparent text-white placeholder-gray-500 focus:outline-none text-sm"
                        onKeyDown={e => {
                          if (e.key === 'Enter' && newProjectTitle) {
                            setClippingFile({ name: newProjectTitle, size: 0, type: 'link' });
                            setClippingUploadProgress(100);
                            setClippingStep('configure');
                          }
                        }}
                      />
                      <button
                        onClick={() => {
                          if (newProjectTitle) {
                            setClippingFile({ name: newProjectTitle, size: 0, type: 'link' });
                            setClippingUploadProgress(100);
                            setClippingStep('configure');
                          }
                        }}
                        className="px-5 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition font-medium flex-shrink-0"
                      >
                        Continue
                      </button>
                    </div>

                    {/* Upload area */}
                    <label
                      className="block border-2 border-dashed border-gray-700 rounded-2xl py-20 cursor-pointer hover:border-blue-500/50 transition-colors group"
                      onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-blue-500', 'bg-blue-500/5'); }}
                      onDragLeave={e => { e.currentTarget.classList.remove('border-blue-500', 'bg-blue-500/5'); }}
                      onDrop={e => {
                        e.preventDefault();
                        e.currentTarget.classList.remove('border-blue-500', 'bg-blue-500/5');
                        const file = e.dataTransfer.files?.[0];
                        if (file && (file.type.startsWith('video/') || file.type.startsWith('audio/'))) {
                          const name = file.name.replace(/\.[^.]+$/, '');
                          setNewProjectTitle(name);
                          setClippingFile({ name: file.name, size: file.size, type: file.type, rawFile: file });
                          // Get video duration
                          const el = document.createElement('video');
                          el.preload = 'metadata';
                          el.onloadedmetadata = () => { setClippingVideoDuration(el.duration); URL.revokeObjectURL(el.src); };
                          el.src = URL.createObjectURL(file);
                          // Simulate upload progress
                          setClippingUploadProgress(0);
                          let p = 0;
                          const iv = setInterval(() => { p += Math.random() * 30 + 10; if (p >= 100) { p = 100; clearInterval(iv); setTimeout(() => setClippingStep('configure'), 300); } setClippingUploadProgress(Math.min(p, 100)); }, 200);
                        }
                      }}
                    >
                      <input
                        type="file"
                        accept="video/*,audio/*"
                        className="hidden"
                        onChange={e => {
                          const file = e.target.files?.[0];
                          if (file) {
                            const name = file.name.replace(/\.[^.]+$/, '');
                            setNewProjectTitle(name);
                            setClippingFile({ name: file.name, size: file.size, type: file.type, rawFile: file });
                            // Get video duration
                            const el = document.createElement('video');
                            el.preload = 'metadata';
                            el.onloadedmetadata = () => { setClippingVideoDuration(el.duration); URL.revokeObjectURL(el.src); };
                            el.src = URL.createObjectURL(file);
                            setClippingUploadProgress(0);
                            let p = 0;
                            const iv = setInterval(() => { p += Math.random() * 30 + 10; if (p >= 100) { p = 100; clearInterval(iv); setTimeout(() => setClippingStep('configure'), 300); } setClippingUploadProgress(Math.min(p, 100)); }, 200);
                          }
                        }}
                      />
                      <div className="flex flex-col items-center gap-4">
                        <div className="w-16 h-14 bg-blue-600/20 rounded-xl flex items-center justify-center">
                          <svg className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                          </svg>
                        </div>
                        <div className="text-center">
                          <p className="text-gray-300">
                            <span className="text-blue-400 font-medium group-hover:text-blue-300 transition">Click to browse</span>
                            {' '}or drag & drop
                          </p>
                          <p className="text-gray-500 text-sm mt-1">
                            Supported file type: video, audio
                          </p>
                        </div>
                      </div>
                    </label>

                    {/* Upload progress (shown when uploading) */}
                    {clippingFile && clippingUploadProgress > 0 && clippingUploadProgress < 100 && (
                      <div className="bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-gray-700 rounded-lg flex items-center justify-center flex-shrink-0">
                            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white truncate">{clippingFile.name}</p>
                            <div className="w-full bg-gray-700 rounded-full h-1.5 mt-1.5">
                              <div className="bg-blue-500 h-1.5 rounded-full transition-all" style={{ width: `${clippingUploadProgress}%` }} />
                            </div>
                            <p className="text-xs text-gray-500 mt-1">Uploading...{Math.round(clippingUploadProgress)}%</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : clippingStep === 'configure' ? (
                  /* Step 2: Configure */
                  <div className="w-full max-w-3xl mt-16 space-y-6">
                    {/* Upload status bar */}
                    {clippingFile && (
                      <div className="flex items-center justify-center">
                        <div className="bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3 flex items-center gap-3 max-w-lg w-full">
                          <div className="w-12 h-9 bg-gray-700 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
                            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm text-white truncate">{clippingFile.name}</p>
                              {clippingFile.type !== 'link' && (
                                <span className="text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded flex-shrink-0">1080p</span>
                              )}
                            </div>
                            <div className="w-full bg-gray-700 rounded-full h-1 mt-1.5">
                              <div className="bg-green-500 h-1 rounded-full" style={{ width: '100%' }} />
                            </div>
                          </div>
                          <button
                            onClick={() => { setClippingStep('upload'); setClippingFile(null); setClippingUploadProgress(0); }}
                            className="text-gray-500 hover:text-gray-300 transition flex-shrink-0"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Ratio & Clip Length */}
                    <div className="flex gap-4">
                      <div className="flex-1 bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3 flex items-center justify-between">
                        <span className="text-sm text-gray-400">Ratio</span>
                        <select
                          value={clippingRatio}
                          onChange={e => setClippingRatio(e.target.value)}
                          className="bg-transparent text-white text-sm font-medium focus:outline-none cursor-pointer"
                        >
                          <option value="9:16" className="bg-gray-800">9:16</option>
                          <option value="16:9" className="bg-gray-800">16:9</option>
                          <option value="1:1" className="bg-gray-800">1:1</option>
                        </select>
                      </div>
                      <div className="flex-1 bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3 flex items-center justify-between">
                        <span className="text-sm text-gray-400">Clip length</span>
                        <select
                          value={clippingClipLength}
                          onChange={e => setClippingClipLength(e.target.value)}
                          className="bg-transparent text-white text-sm font-medium focus:outline-none cursor-pointer"
                        >
                          <option value="15s-30s" className="bg-gray-800">15s-30s</option>
                          <option value="30s-60s" className="bg-gray-800">30s-60s</option>
                          <option value="60s-90s" className="bg-gray-800">60s-90s</option>
                          <option value="90s-180s" className="bg-gray-800">90s-3min</option>
                        </select>
                      </div>
                    </div>

                    {/* Template Section */}
                    <div className="bg-gray-800/40 border border-gray-700 rounded-2xl p-6">
                      <div className="flex items-center gap-6 mb-5 border-b border-gray-700 pb-3">
                        <span className="text-sm font-medium text-blue-400 border-b-2 border-blue-400 pb-3 -mb-3.5">9:16 template</span>
                      </div>

                      {/* Template cards */}
                      <div className="flex gap-4 overflow-x-auto pb-2">
                        <div className="flex flex-col items-center gap-2 flex-shrink-0">
                          <div className="w-32 h-56 bg-gradient-to-br from-gray-700 to-gray-800 rounded-xl border-2 border-blue-500 flex items-center justify-center relative overflow-hidden">
                            <div className="absolute top-2 right-2 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            </div>
                            <div className="text-center px-3">
                              <div className="text-[10px] text-gray-300 bg-gray-900/60 rounded px-2 py-1 mb-8">Your video title is here</div>
                              <div className="text-[10px] text-blue-300 bg-blue-900/40 rounded px-2 py-1">Here is my subtitle</div>
                            </div>
                          </div>
                          <span className="text-sm text-blue-400 font-medium">Default</span>
                        </div>
                      </div>
                    </div>

                    {/* Options checkboxes */}
                    <div className="bg-gray-800/40 border border-gray-700 rounded-2xl px-6 py-4">
                      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
                        <label className="flex items-center gap-2 cursor-pointer group">
                          <input type="checkbox" checked={clippingAddEmoji} onChange={e => setClippingAddEmoji(e.target.checked)}
                            className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
                          <span className="text-sm text-gray-300 group-hover:text-white transition">Add emoji</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer group">
                          <input type="checkbox" checked={clippingHighlightKeywords} onChange={e => setClippingHighlightKeywords(e.target.checked)}
                            className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
                          <span className="text-sm text-gray-300 group-hover:text-white transition">Highlight keywords</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer group">
                          <input type="checkbox" checked={clippingRemoveSilences} onChange={e => setClippingRemoveSilences(e.target.checked)}
                            className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
                          <span className="text-sm text-gray-300 group-hover:text-white transition">Remove silences</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer group">
                          <input type="checkbox" checked={clippingAddBrolls} onChange={e => setClippingAddBrolls(e.target.checked)}
                            className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
                          <span className="text-sm text-gray-300 group-hover:text-white transition">Add B-rolls</span>
                        </label>
                      </div>
                    </div>

                    {/* Find clip moment */}
                    <div className="bg-gray-800/40 border border-gray-700 rounded-2xl px-6 py-4">
                      <p className="text-sm text-gray-400 mb-2">Find clip moment (optional)</p>
                      <input
                        type="text"
                        value={clippingFindMoment}
                        onChange={e => setClippingFindMoment(e.target.value)}
                        placeholder="Only want specific parts? Type for example: when Sam talks about GPT-5."
                        className="w-full bg-transparent text-white placeholder-gray-600 text-sm focus:outline-none"
                      />
                    </div>

                    {/* Generate button */}
                    <button
                      onClick={async () => {
                        setClippingProcessSteps([
                          { label: 'Upload', status: clippingFile?.rawFile ? 'active' : 'done' },
                          { label: 'Create project', status: clippingFile?.rawFile ? 'pending' : 'active' },
                          { label: 'Process video', status: 'pending' },
                          { label: 'Finding best parts', status: 'pending' },
                          { label: 'Edit clips', status: 'pending' },
                          { label: 'Finalize', status: 'pending' },
                        ]);
                        setClippingStep('processing');

                        try {
                          // Step 1: Upload file first (if local file)
                          let videoUrl: string;
                          const tempId = crypto.randomUUID();

                          if (clippingFile?.rawFile) {
                            const formData = new FormData();
                            formData.append('file', clippingFile.rawFile);
                            formData.append('projectId', tempId);

                            const uploadData = await new Promise<{ url: string }>((resolve, reject) => {
                              const xhr = new XMLHttpRequest();
                              xhr.open('POST', '/api/clipping/upload');
                              xhr.upload.onprogress = (e) => {
                                if (e.lengthComputable) {
                                  const pct = Math.round((e.loaded / e.total) * 100);
                                  setClippingProcessSteps(prev =>
                                    prev.map(s => s.label === 'Upload' ? { ...s, detail: `${pct}%`, progress: pct } : s)
                                  );
                                }
                              };
                              xhr.onload = () => {
                                if (xhr.status >= 200 && xhr.status < 300) {
                                  resolve(JSON.parse(xhr.responseText));
                                } else {
                                  reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
                                }
                              };
                              xhr.onerror = () => reject(new Error('Upload network error'));
                              xhr.send(formData);
                            });

                            videoUrl = uploadData.url;
                            setClippingProcessSteps(prev =>
                              prev.map(s => {
                                if (s.label === 'Upload') return { ...s, status: 'done', detail: undefined };
                                if (s.label === 'Create project') return { ...s, status: 'active' };
                                return s;
                              })
                            );
                          } else if (newProjectTitle.match(/(?:youtube\.com|youtu\.be)/i)) {
                            // YouTube URL — download via yt-dlp with SSE progress
                            setClippingProcessSteps(prev =>
                              prev.map(s => s.label === 'Upload' ? { ...s, status: 'active', detail: 'Fetching video info...' } : s)
                            );
                            const tempId = crypto.randomUUID();
                            const ytRes = await fetch('/api/clipping/download-yt', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ projectId: tempId, url: newProjectTitle }),
                            });

                            if (!ytRes.ok || !ytRes.body) {
                              const errData = await ytRes.json().catch(() => ({}));
                              throw new Error(errData.error || 'YouTube download failed');
                            }

                            // Read SSE stream for progress
                            const ytResult = await new Promise<{ url: string; title?: string; duration?: number }>((resolve, reject) => {
                              const reader = ytRes.body!.getReader();
                              const decoder = new TextDecoder();
                              let buf = '';

                              const read = async () => {
                                while (true) {
                                  const { done, value } = await reader.read();
                                  if (done) { reject(new Error('Stream ended without result')); return; }
                                  buf += decoder.decode(value, { stream: true });
                                  const lines = buf.split('\n');
                                  buf = lines.pop() || '';
                                  let evtType = '';
                                  for (const line of lines) {
                                    if (line.startsWith('event: ')) evtType = line.slice(7);
                                    else if (line.startsWith('data: ')) {
                                      try {
                                        const d = JSON.parse(line.slice(6));
                                        if (evtType === 'progress') {
                                          setClippingProcessSteps(prev =>
                                            prev.map(s => s.label === 'Upload' ? {
                                              ...s, status: 'active',
                                              detail: d.message || 'Downloading...',
                                              progress: d.percent,
                                            } : s)
                                          );
                                          if (d.title) setNewProjectTitle(d.title);
                                          if (d.duration) setClippingVideoDuration(d.duration);
                                        } else if (evtType === 'complete') {
                                          resolve(d);
                                          return;
                                        } else if (evtType === 'error') {
                                          reject(new Error(d.error || 'Download failed'));
                                          return;
                                        }
                                      } catch { /* skip */ }
                                    }
                                  }
                                }
                              };
                              read();
                            });

                            videoUrl = ytResult.url;
                            if (ytResult.duration) setClippingVideoDuration(ytResult.duration);
                            if (ytResult.title) setNewProjectTitle(ytResult.title);
                          } else {
                            videoUrl = newProjectTitle;
                          }

                          // Step 2: Create project (only after upload succeeds)
                          const res = await fetch('/api/clipping/projects', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ title: newProjectTitle || 'Untitled' }),
                          });
                          const data = await res.json();
                          if (!data.project) throw new Error('Failed to create project');

                          const projectId = data.project.id;
                          setClippingProjects(prev => [data.project, ...prev]);
                          setClippingCurrentProjectId(projectId);
                          setClippingProcessSteps(prev =>
                            prev.map(s => {
                              if (s.label === 'Create project') return { ...s, status: 'done' };
                              if (s.label === 'Process video') return { ...s, status: 'active' };
                              return s;
                            })
                          );

                          // Step 3: Start analysis via SSE
                          console.log('[clipping] Starting analysis:', { projectId, videoUrl: videoUrl?.substring(0, 80), duration: clippingVideoDuration });
                          setClippingProcessSteps(prev =>
                            prev.map(s => s.label === 'Process video' ? { ...s, detail: `Analyzing ${Math.round(clippingVideoDuration || 0)}s video...` } : s)
                          );
                          await startClippingAnalysis(projectId, videoUrl, clippingVideoDuration);

                        } catch (err) {
                          console.error('Error in clipping pipeline:', err);
                          const msg = err instanceof Error ? err.message : 'Unknown error';
                          setClippingProcessSteps(prev =>
                            prev.map(s => s.status === 'active'
                              ? { ...s, status: 'pending', detail: `Error: ${msg}` }
                              : s)
                          );
                        }
                      }}
                      className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-blue-500 text-white rounded-xl hover:from-blue-700 hover:to-blue-600 transition font-semibold text-base"
                    >
                      Generate Clips
                    </button>
                  </div>
                ) : clippingStep === 'processing' ? (
                  /* Step 3: Processing */
                  <div className="w-full max-w-4xl mt-16 flex gap-8">
                    {/* Left: Progress */}
                    <div className="flex-1 space-y-8">
                      {/* Upload status bar */}
                      {clippingFile && (
                        <div className="bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3 flex items-center gap-3 max-w-lg">
                          <div className="w-12 h-9 bg-gray-700 rounded-lg flex items-center justify-center flex-shrink-0">
                            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm text-white truncate">{clippingFile.name}</p>
                              {clippingFile.type !== 'link' && (
                                <span className="text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded flex-shrink-0">1080p</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 mt-1 flex items-center gap-1.5">
                              Upload successful
                              <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                            </p>
                          </div>
                        </div>
                      )}

                      {/* Analysis status */}
                      <div>
                        <div className="text-2xl mb-1">✨</div>
                        <h2 className="text-xl font-bold text-white mb-1">Analyzing content and finding clips</h2>
                        <p className="text-sm text-gray-400">
                          You can safely leave this page. We&apos;ll notify you when clips are ready.
                        </p>
                      </div>

                      {/* Progress steps */}
                      <div className="space-y-3">
                        {clippingProcessSteps.map((step, i) => (
                          <div key={i} className="flex items-center gap-3">
                            {step.status === 'done' ? (
                              <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                            ) : step.status === 'active' ? (
                              <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center">
                                <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                              </div>
                            ) : (
                              <div className="w-5 h-5 rounded-full border-2 border-gray-600 flex-shrink-0" />
                            )}
                            <div className="flex flex-col">
                              <span className={`text-sm ${
                                step.status === 'done' ? 'text-white' :
                                step.status === 'active' ? 'text-white font-medium' :
                                'text-gray-600'
                              }`}>
                                {step.label}{step.status === 'active' && step.progress != null ? `...${step.progress}%` : ''}
                              </span>
                              {step.detail && (
                                <span className={`text-xs mt-0.5 ${step.detail.startsWith('Error') ? 'text-red-400' : 'text-gray-500'}`}>{step.detail}</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Right: Info panel */}
                    <div className="hidden lg:block w-80 flex-shrink-0">
                      <div className="bg-gray-800/40 border border-gray-700 rounded-2xl p-6">
                        <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">How it works</p>
                        <h3 className="text-lg font-bold text-white mb-4">Turn long videos into shorts in a click</h3>
                        <div className="bg-gray-900/60 rounded-xl h-48 flex items-center justify-center mb-4">
                          <svg className="w-12 h-12 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                        <p className="text-sm text-gray-400">
                          Our AI will transcribe and analyze your video to find the best parts and create professional-looking clips, ready to share.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : clippingStep === 'clips' ? (
                  /* Step 4: Clips Results */
                  <div className="w-full max-w-6xl mt-8 flex gap-0 h-[calc(100vh-8rem)]">
                    {/* Left sidebar: clip list */}
                    <div className="w-56 flex-shrink-0 border-r border-gray-800 overflow-y-auto pr-2 space-y-1">
                      <div className="flex items-center justify-between px-2 mb-3">
                        <button
                          onClick={() => { setShowNewProjectModal(false); setClippingStep('upload'); setClippingFile(null); }}
                          className="text-sm text-gray-400 hover:text-white flex items-center gap-1"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                          </svg>
                          Back
                        </button>
                        <span className="text-xs text-gray-500">{clippingGeneratedClips.length} clips</span>
                      </div>
                      {clippingGeneratedClips.map((clip, i) => (
                        <button
                          key={clip.id}
                          onClick={() => setClippingSelectedClipIdx(i)}
                          className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-all ${
                            i === clippingSelectedClipIdx
                              ? 'bg-blue-600/20 border border-blue-500/40'
                              : 'hover:bg-gray-800/60 border border-transparent'
                          }`}
                        >
                          <div className="relative w-14 h-10 bg-gray-800 rounded-md overflow-hidden flex-shrink-0">
                            <img
                              src={`/api/clipping/serve?clipId=${clip.id}&type=thumbnail`}
                              alt=""
                              className="w-full h-full object-cover"
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                            <span className="absolute bottom-0 right-0 text-[9px] bg-black/70 text-gray-300 px-1 rounded-tl">
                              {Math.floor(clip.duration_sec / 60)}:{String(Math.floor(clip.duration_sec % 60)).padStart(2, '0')}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={`text-xs truncate ${i === clippingSelectedClipIdx ? 'text-white' : 'text-gray-300'}`}>
                              {clip.title}
                            </p>
                            <div className="flex items-center gap-1 mt-0.5">
                              <span className="text-[10px] text-yellow-400 font-medium">{clip.score}/10</span>
                            </div>
                          </div>
                          <span className="text-xs text-gray-600 font-mono flex-shrink-0">#{i + 1}</span>
                        </button>
                      ))}
                    </div>

                    {/* Main: selected clip detail */}
                    {clippingGeneratedClips[clippingSelectedClipIdx] && (() => {
                      const clip = clippingGeneratedClips[clippingSelectedClipIdx];
                      return (
                        <div className="flex-1 overflow-y-auto pl-6">
                          {/* Header */}
                          <div className="flex items-start justify-between mb-4">
                            <div>
                              <h2 className="text-xl font-bold text-white">{clip.title}</h2>
                              <div className="flex items-center gap-3 mt-1">
                                <span className="text-sm text-gray-400">
                                  #{clippingSelectedClipIdx + 1}
                                </span>
                                <span className="text-sm text-gray-500">&bull;</span>
                                <span className="text-sm text-gray-400">
                                  {Math.floor(clip.start_sec / 60)}:{String(Math.floor(clip.start_sec % 60)).padStart(2, '0')} &ndash; {Math.floor(clip.end_sec / 60)}:{String(Math.floor(clip.end_sec % 60)).padStart(2, '0')}
                                </span>
                              </div>
                            </div>
                            <div className="text-center">
                              <div className="text-3xl font-black text-white">{clip.score.toFixed(1)}</div>
                              <div className="text-xs text-gray-500">/10</div>
                            </div>
                          </div>

                          {/* Video preview */}
                          <div className="relative bg-black rounded-xl overflow-hidden mb-4" style={{ aspectRatio: '16/9', maxHeight: '360px' }}>
                            {clip.status === 'done' ? (
                              <video
                                key={clip.id}
                                controls
                                className="w-full h-full object-contain"
                                src={`/api/clipping/serve?clipId=${clip.id}&type=video`}
                                poster={`/api/clipping/serve?clipId=${clip.id}&type=thumbnail`}
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                                {clip.status === 'cutting' ? 'Cutting...' : clip.status === 'error' ? 'Error' : 'Pending'}
                              </div>
                            )}
                          </div>

                          {/* Action buttons */}
                          <div className="flex items-center gap-3 mb-6">
                            {clip.status === 'done' && (
                              <a
                                href={`/api/clipping/serve?clipId=${clip.id}&type=video`}
                                download
                                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm font-medium"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                                Download
                              </a>
                            )}
                            {clip.file_size_bytes && (
                              <span className="text-xs text-gray-500">
                                {(clip.file_size_bytes / 1e6).toFixed(1)} MB
                              </span>
                            )}
                          </div>

                          {/* Description */}
                          {clip.description && (
                            <div className="bg-gray-800/40 border border-gray-700 rounded-xl px-5 py-4 mb-4">
                              <p className="text-sm text-gray-300">{clip.description}</p>
                            </div>
                          )}

                          {/* Transcript */}
                          {clip.transcript && (
                            <div className="mb-6">
                              <h3 className="text-sm font-medium text-gray-400 mb-2">Transcript</h3>
                              <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                                {clip.transcript}
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                ) : null}
              </div>
            ) : (
              /* Projects List */
              <div className="container mx-auto px-4 py-8 max-w-7xl">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h1 className="text-4xl font-bold text-white mb-2 bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
                      Clipping
                    </h1>
                    <p className="text-gray-400">
                      Upload videos and let AI create clips for you
                    </p>
                  </div>
                  <div className="flex gap-3">
                    <button
                      className="px-4 py-2.5 bg-gray-800 text-gray-300 rounded-xl border border-gray-700 hover:bg-gray-700 hover:text-white transition-all flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                      New folder
                    </button>
                    <button
                      onClick={() => { setNewProjectTitle(''); setShowNewProjectModal(true); }}
                      className="px-4 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all flex items-center gap-2 font-medium"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      New project
                    </button>
                  </div>
                </div>

                {/* Folders Section */}
                <div className="mb-8">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-white">Folders</h2>
                    <span className="text-sm text-gray-500">0 folders</span>
                  </div>
                  <div className="text-gray-600 text-sm py-4 border border-dashed border-gray-700 rounded-xl text-center">
                    No folders yet
                  </div>
                </div>

                {/* Projects Section */}
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-white">Projects</h2>
                    <div className="flex items-center gap-4">
                      <span className="text-sm text-gray-500">{clippingProjects.length} project{clippingProjects.length !== 1 ? 's' : ''}</span>
                      <span className="text-sm text-gray-600">Last modified</span>
                    </div>
                  </div>

                  {clippingLoading ? (
                    <div className="flex items-center justify-center py-20">
                      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
                    </div>
                  ) : clippingProjects.length === 0 ? (
                    <div className="text-center py-20">
                      <div className="text-6xl mb-4">✂️</div>
                      <h3 className="text-xl font-semibold text-white mb-2">No projects yet</h3>
                      <p className="text-gray-400 mb-6">Create your first clipping project to get started</p>
                      <button
                        onClick={() => { setNewProjectTitle(''); setShowNewProjectModal(true); }}
                        className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition font-medium"
                      >
                        New project
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                      {clippingProjects.map((project) => (
                        <div
                          key={project.id}
                          className="bg-gray-800/50 rounded-xl border border-gray-700 overflow-hidden hover:border-blue-500 transition-all group"
                        >
                          {/* Thumbnail */}
                          <div className="aspect-video bg-gray-900 flex items-center justify-center relative cursor-pointer">
                            {project.thumbnail_url ? (
                              <img
                                src={project.thumbnail_url}
                                alt={project.title}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="text-4xl text-gray-700">🎬</div>
                            )}
                            {/* Duration badge */}
                            {project.video_duration && (
                              <span className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded font-medium">
                                {Math.floor(project.video_duration / 60)}:{String(Math.floor(project.video_duration % 60)).padStart(2, '0')}
                              </span>
                            )}
                            {/* Status badge */}
                            <span className={`absolute top-2 right-2 text-xs px-2 py-0.5 rounded font-medium ${
                              project.status === 'done' ? 'bg-green-600/80 text-white' :
                              project.status === 'processing' ? 'bg-yellow-600/80 text-white' :
                              'bg-gray-700/80 text-gray-300'
                            }`}>
                              {project.status === 'done' ? 'Done' : project.status === 'processing' ? 'Processing' : 'Draft'}
                            </span>
                          </div>

                          {/* Info */}
                          <div className="p-4">
                            <p className="text-sm text-gray-400">
                              {new Date(project.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} {new Date(project.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </p>
                            <h3 className="font-semibold text-white mt-1 truncate">
                              {project.title}
                            </h3>

                            {/* Actions */}
                            <div className="flex gap-2 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={async () => {
                                  setClippingCurrentProjectId(project.id);
                                  setClippingStep('clips');
                                  setShowNewProjectModal(true);
                                  try {
                                    const res = await fetch(`/api/clipping/clips?projectId=${project.id}`);
                                    const data = await res.json();
                                    if (data.clips) setClippingGeneratedClips(data.clips);
                                  } catch (err) {
                                    console.error('Failed to load clips:', err);
                                  }
                                }}
                                className="flex-1 px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition"
                              >
                                Open
                              </button>
                              <button
                                onClick={() => deleteClippingProject(project.id)}
                                className="px-3 py-2 bg-red-600/20 text-red-400 text-sm rounded-lg hover:bg-red-600/40 transition"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          ) : currentView === 'niche' ? (
            /* Niche Explorer View */
            <div className="container mx-auto px-4 py-6 max-w-7xl">
              {/* Timeline */}
              <NicheTimeline
                keyword={nicheFilter.keyword !== 'all' ? nicheFilter.keyword : undefined}
                minScore={nicheFilter.minScore}
                maxScore={nicheFilter.maxScore}
                onRangeChange={(from, to) => setNicheFilter(prev => ({ ...prev, from, to }))}
              />

              {/* Header */}
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl px-6 py-4 mb-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <span className="text-2xl font-bold text-white">{nicheStats ? parseInt(nicheStats.total_videos).toLocaleString() : '...'}</span>
                    <span className="text-gray-400 ml-2">stored videos</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        setNicheEnriching(true);
                        setNicheEnrichResult(null);
                        let totalEnrichedV = 0, totalEnrichedC = 0, totalErrors = 0, round = 0;
                        try {
                          while (true) {
                            round++;
                            setNicheEnrichResult({ message: `Round ${round}: fetching data from YouTube API...`, enriched: totalEnrichedV, errors: totalErrors });
                            const res = await fetch('/api/niche-spy/enrich', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ keyword: nicheFilter.keyword !== 'all' ? nicheFilter.keyword : undefined, limit: 200 }),
                            });
                            const reader = res.body?.getReader();
                            const decoder = new TextDecoder();
                            let buf = '';
                            let roundVideos = 0, roundChannels = 0;
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
                                    if (d.step === 'videos' && !d.done && !d.error) {
                                      setNicheEnrichResult({ message: `Round ${round}: video stats batch ${d.batch}/${d.total}...`, enriched: totalEnrichedV, errors: totalErrors });
                                    } else if (d.step === 'videos' && d.done) {
                                      roundVideos = d.enriched || 0;
                                      setNicheEnrichResult({ message: `Round ${round}: ${roundVideos} videos done, fetching channels...`, enriched: totalEnrichedV + roundVideos, errors: totalErrors });
                                    } else if (d.step === 'channels' && !d.done && !d.error) {
                                      setNicheEnrichResult({ message: `Round ${round}: subscriber counts batch ${d.batch}/${d.total}...`, enriched: totalEnrichedV + roundVideos, errors: totalErrors });
                                    } else if (d.step === 'complete') {
                                      roundVideos = d.enrichedVideos || 0;
                                      roundChannels = d.enrichedChannels || 0;
                                      totalErrors += d.errors || 0;
                                    }
                                  } catch { /* skip */ }
                                }
                              }
                            }
                            totalEnrichedV += roundVideos;
                            totalEnrichedC += roundChannels;
                            setNicheEnrichResult({ message: `Round ${round} done: +${roundVideos} videos, +${roundChannels} channels (total: ${totalEnrichedV} videos, ${totalEnrichedC} channels)`, enriched: totalEnrichedV, errors: totalErrors });
                            if (roundVideos === 0) break; // No more to enrich
                            await new Promise(r => setTimeout(r, 500));
                          }
                          setNicheEnrichResult({ message: `All done! ${totalEnrichedV} videos, ${totalEnrichedC} channels enriched across ${round} rounds.`, enriched: totalEnrichedV, errors: totalErrors });
                          fetchNicheData(0);
                        } catch (err) {
                          setNicheEnrichResult({ message: `Error: ${err instanceof Error ? err.message : 'Failed'}`, enriched: totalEnrichedV, errors: totalErrors + 1 });
                        }
                        setNicheEnriching(false);
                        setTimeout(() => setNicheEnrichResult(null), 8000);
                      }}
                      disabled={nicheEnriching}
                      className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white rounded-lg text-sm font-medium"
                    >
                      {nicheEnriching ? 'Enriching...' : 'Enrich Data'}
                    </button>
                    <button
                      onClick={syncNicheData}
                      disabled={nicheSyncing}
                      className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 text-white rounded-lg text-sm font-medium"
                    >
                      {nicheSyncing ? 'Syncing...' : 'Refresh'}
                    </button>
                  </div>
                </div>

                {/* Enrich result */}
                {nicheEnrichResult && (
                  <div className={`border rounded-lg px-4 py-2.5 mb-3 ${nicheEnrichResult.errors ? 'bg-yellow-900/20 border-yellow-600/40' : 'bg-purple-900/20 border-purple-600/40'}`}>
                    <div className="flex items-center gap-2">
                      {nicheEnriching ? (
                        <div className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                      ) : (
                        <svg className="w-4 h-4 text-purple-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      )}
                      <span className="text-sm text-purple-200">{nicheEnrichResult.message}</span>
                    </div>
                  </div>
                )}

                {/* Sync progress */}
                {nicheSyncProgress && (
                  <div className={`border rounded-lg px-4 py-3 mb-4 ${nicheSyncProgress.done ? 'bg-green-900/20 border-green-600/40' : 'bg-blue-900/20 border-blue-600/40'}`}>
                    <div className="flex items-center gap-3">
                      {nicheSyncing && !nicheSyncProgress.done && (
                        <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                      )}
                      {(nicheSyncProgress.done || !nicheSyncing) && (
                        <svg className="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-blue-200 font-medium">{nicheSyncProgress.message}</p>
                        {nicheSyncProgress.batches > 0 && (
                          <div className="flex items-center gap-4 mt-1.5 text-xs text-gray-400 flex-wrap">
                            <span className="text-green-400">+{nicheSyncProgress.totalInserted} new</span>
                            <span className="text-yellow-400">{nicheSyncProgress.totalUpdated} updated</span>
                            <span>{nicheSyncProgress.totalLocal.toLocaleString()} total</span>
                            <span>{nicheSyncProgress.totalKeywords} keywords</span>
                          </div>
                        )}
                        {nicheSyncProgress.keywordBreakdown && nicheSyncProgress.keywordBreakdown.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {nicheSyncProgress.keywordBreakdown.slice(0, 8).map(k => (
                              <span key={k.keyword} className="text-[10px] bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full">
                                {k.keyword} <span className="text-green-400">+{k.new}</span>/{k.total}
                              </span>
                            ))}
                            {nicheSyncProgress.keywordBreakdown.length > 8 && (
                              <span className="text-[10px] text-gray-500">+{nicheSyncProgress.keywordBreakdown.length - 8} more</span>
                            )}
                          </div>
                        )}
                        {/* Saturation indicators */}
                        {nicheSyncProgress.saturation && nicheSyncProgress.saturation.length > 0 && (
                          <div className="mt-2 space-y-1">
                            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Saturation</span>
                            {nicheSyncProgress.saturation.slice(0, 6).map(s => (
                              <div key={s.keyword} className="flex items-center gap-2">
                                <span className="text-[10px] text-gray-400 w-28 truncate">{s.keyword}</span>
                                <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full ${s.runSatPct >= 90 ? 'bg-red-500' : s.runSatPct >= 60 ? 'bg-yellow-500' : 'bg-green-500'}`}
                                    style={{ width: `${Math.min(s.runSatPct, 100)}%` }}
                                  />
                                </div>
                                <span className={`text-[10px] font-mono w-10 text-right ${s.runSatPct >= 90 ? 'text-red-400' : s.runSatPct >= 60 ? 'text-yellow-400' : 'text-green-400'}`}>
                                  {s.runSatPct}%
                                </span>
                                <span className="text-[10px] text-gray-500">+{s.A} new</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Filters */}
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 uppercase tracking-wider">Keyword</span>
                    <select
                      value={nicheFilter.keyword}
                      onChange={e => setNicheFilter(prev => ({ ...prev, keyword: e.target.value }))}
                      className="bg-gray-700 border border-gray-600 text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none"
                    >
                      <option value="all">All keywords</option>
                      {nicheKeywords.map(k => (
                        <option key={k.keyword} value={k.keyword}>{k.keyword} ({k.cnt})</option>
                      ))}
                    </select>
                    <span className="text-xs text-gray-500">{nicheKeywords.length} keywords</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 uppercase tracking-wider">Score</span>
                    <select
                      value={nicheFilter.minScore}
                      onChange={e => setNicheFilter(prev => ({ ...prev, minScore: parseInt(e.target.value) }))}
                      className="bg-gray-700 border border-gray-600 text-white text-sm rounded-lg px-2 py-1.5"
                    >
                      <option value="0">Min</option>
                      {[10,20,30,40,50,60,70,80,90].map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                    <span className="text-gray-500">–</span>
                    <select
                      value={nicheFilter.maxScore}
                      onChange={e => setNicheFilter(prev => ({ ...prev, maxScore: parseInt(e.target.value) }))}
                      className="bg-gray-700 border border-gray-600 text-white text-sm rounded-lg px-2 py-1.5"
                    >
                      <option value="100">Max</option>
                      {[90,80,70,60,50,40,30,20,10].map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 uppercase tracking-wider">Sort</span>
                    <select
                      value={nicheFilter.sort}
                      onChange={e => setNicheFilter(prev => ({ ...prev, sort: e.target.value }))}
                      className="bg-gray-700 border border-gray-600 text-white text-sm rounded-lg px-3 py-1.5"
                    >
                      <option value="score">Score</option>
                      <option value="views">Views</option>
                      <option value="date">Newest First</option>
                      <option value="oldest">Oldest First</option>
                      <option value="likes">Likes</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Video Grid */}
              {nicheLoading && nicheVideos.length === 0 ? (
                <div className="text-center py-20 text-gray-400">Loading...</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {nicheVideos.map(v => (
                      <div key={v.id} className="bg-gray-800/60 border border-gray-700 rounded-xl overflow-hidden hover:border-gray-500 transition">
                        {/* Thumbnail */}
                        <div className="relative aspect-video bg-gray-900">
                          {(() => {
                            // Extract video ID from URL for YouTube thumbnail CDN
                            const vidMatch = v.url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
                            const thumbUrl = vidMatch ? `https://img.youtube.com/vi/${vidMatch[1]}/hqdefault.jpg` : v.thumbnail;
                            return thumbUrl ? (
                              <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-600">
                                <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                              </div>
                            );
                          })()}
                          {/* Score badge */}
                          <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold flex items-center gap-1 ${
                            v.score >= 80 ? 'bg-green-500 text-white' :
                            v.score >= 50 ? 'bg-yellow-500 text-black' :
                            'bg-red-500 text-white'
                          }`}>
                            ⚡ {v.score}
                          </div>
                        </div>

                        <div className="p-3">
                          {/* Keyword tag */}
                          {v.keyword && (
                            <span className="inline-block text-xs bg-purple-600/30 text-purple-300 border border-purple-600/50 rounded-full px-2 py-0.5 mb-2">
                              {v.keyword}
                            </span>
                          )}

                          {/* Title */}
                          <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>

                          {/* Stats */}
                          <div className="flex items-center gap-2 text-xs text-gray-400 mb-1.5">
                            <span className="text-green-400 font-medium">{v.view_count ? fmtYT(v.view_count) + ' views' : ''}</span>
                            {v.channel_name && <span>· {v.channel_name}</span>}
                            {(v.posted_at || v.posted_date) && (
                              <span>· {v.posted_at ? (() => {
                                const d = new Date(v.posted_at);
                                const now = new Date();
                                const diffMs = now.getTime() - d.getTime();
                                const days = Math.floor(diffMs / 86400000);
                                if (days < 1) return 'Today';
                                if (days === 1) return 'Yesterday';
                                if (days < 7) return `${days} days ago`;
                                if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
                                if (days < 365) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                                return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                              })() : v.posted_date}</span>
                            )}
                          </div>

                          {/* Engagement */}
                          <div className="flex items-center gap-3 text-xs text-gray-500 mb-2">
                            {v.like_count > 0 && <span>👍 {fmtYT(v.like_count)}</span>}
                            {v.comment_count > 0 && <span>💬 {fmtYT(v.comment_count)}</span>}
                            {v.subscriber_count > 0 && <span>👥 {fmtYT(v.subscriber_count)} subscribers</span>}
                          </div>

                          {/* Top comment */}
                          {v.top_comment && (
                            <p className="text-xs text-gray-500 italic line-clamp-2 border-l-2 border-gray-700 pl-2 mb-2">
                              &ldquo;{v.top_comment}&rdquo;
                            </p>
                          )}

                          {/* URL */}
                          {v.url && (
                            <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300 truncate block">
                              {v.url}
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Load more */}
                  {nicheVideos.length < nicheTotal && (
                    <div className="text-center mt-6">
                      <button
                        onClick={() => fetchNicheData(nicheOffset)}
                        disabled={nicheLoading}
                        className="px-6 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm"
                      >
                        {nicheLoading ? 'Loading...' : `Load More (${nicheVideos.length}/${nicheTotal})`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : currentView === 'library' ? (
            /* Library View */
            <div className="container mx-auto px-4 py-8 max-w-7xl">
              <div className="text-center mb-8">
                <h1 className="text-4xl font-bold text-white mb-4 bg-gradient-to-r from-blue-400 to-purple-600 bg-clip-text text-transparent">
                  Project Library
                </h1>
                <p className="text-gray-400 max-w-2xl mx-auto">
                  Browse and manage your saved projects
                </p>
              </div>

              {libraryLoading ? (
                <div className="flex items-center justify-center py-20">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500" />
                </div>
              ) : libraryProjects.length === 0 ? (
                <div className="text-center py-20">
                  <div className="text-6xl mb-4">📁</div>
                  <h3 className="text-xl font-semibold text-white mb-2">No projects yet</h3>
                  <p className="text-gray-400 mb-6">Create your first project to get started</p>
                  <button
                    onClick={startNewProject}
                    className="px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition"
                  >
                    Create New Project
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {libraryProjects.map((project) => (
                    <div
                      key={project.id}
                      className="bg-gray-800/50 rounded-xl border border-gray-700 overflow-hidden hover:border-purple-500 transition-all group"
                    >
                      {/* Thumbnail */}
                      <div
                        className="aspect-video bg-gray-900 flex items-center justify-center cursor-pointer"
                        onClick={() => loadProject(project.id)}
                      >
                        {project.thumbnail ? (
                          <img
                            src={project.thumbnail}
                            alt={project.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="text-4xl text-gray-600">🎬</div>
                        )}
                      </div>

                      {/* Info */}
                      <div className="p-4">
                        <h3
                          className="font-semibold text-white truncate cursor-pointer hover:text-purple-400"
                          onClick={() => loadProject(project.id)}
                        >
                          {project.title}
                        </h3>
                        <p className="text-sm text-gray-400 mt-1">
                          {new Date(project.updatedAt).toLocaleDateString()} {new Date(project.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>

                        {/* Actions */}
                        <div className="flex gap-2 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => loadProject(project.id)}
                            className="flex-1 px-3 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 transition"
                          >
                            Open
                          </button>
                          <button
                            onClick={() => deleteProject(project.id)}
                            className="px-3 py-2 bg-red-600/20 text-red-400 text-sm rounded-lg hover:bg-red-600/40 transition"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* Creator View - Original Content */
            <div className="container mx-auto px-4 py-8 max-w-7xl">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-4 bg-gradient-to-r from-blue-400 to-purple-600 bg-clip-text text-transparent">
            AI Video Production Pipeline
          </h1>
          <p className="text-gray-400 text-lg">
            Batch generate short story videos with AI - Scripts, Storyboards, Voice-overs, Images & Effects
          </p>
        </div>

        {/* API Keys Notice */}
        {(!papaiApiKey && !apiKey && !googleTtsKey) && (
          <div className="bg-yellow-900/20 border border-yellow-600/30 rounded-2xl p-4 mb-8 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🔑</span>
              <div>
                <p className="text-yellow-300 font-medium">API Keys Required</p>
                <p className="text-yellow-300/70 text-sm">Configure your API keys in Settings to start generating content</p>
              </div>
            </div>
            <button
              onClick={() => setActiveTab('settings')}
              className="px-4 py-2 bg-yellow-600/20 text-yellow-300 rounded-xl hover:bg-yellow-600/30 transition"
            >
              Go to Settings
            </button>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="bg-gray-800/50 backdrop-blur-xl rounded-2xl border border-gray-700 overflow-hidden">
          <div className="flex border-b border-gray-700 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center space-x-2 px-6 py-4 font-medium transition-all min-w-fit ${
                  activeTab === tab.id
                    ? 'bg-blue-600 text-white border-b-2 border-blue-400'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
                }`}
              >
                <span className="text-xl">{tab.icon}</span>
                <span>{tab.name}</span>
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="p-8">
            {/* Scripts Tab */}
            {activeTab === 'scripts' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Story Generation</h3>
                  <p className="text-gray-400 mb-6">Enter viral titles to generate complete story structures</p>
                </div>

                <div className="space-y-4">
                  {scriptTitles.map((title, index) => (
                    <div key={index} className="flex gap-3">
                      <input
                        type="text"
                        value={title}
                        onChange={(e) => updatePrompt('script', index, e.target.value)}
                        placeholder={`Enter viral title ${index + 1} (e.g., "The Secret That Changed Everything")`}
                        className="flex-1 px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                      />
                      <button
                        onClick={() => removePrompt('script', index)}
                        disabled={scriptTitles.length === 1}
                        className="px-4 py-2 bg-red-600/20 text-red-400 rounded-xl hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                {/* Scene Count Slider */}
                <div className="bg-gray-900/30 p-4 rounded-xl border border-gray-700">
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-white font-semibold">Number of Scenes</label>
                    <div className="text-white font-mono text-xl">{targetSceneCount}</div>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="30"
                    step="1"
                    value={targetSceneCount}
                    onChange={(e) => setTargetSceneCount(parseInt(e.target.value))}
                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                  <div className="flex justify-between text-sm text-gray-400 mt-2">
                    <span>5 scenes</span>
                    <span className="text-center">
                      Duration: {targetSceneCount * 2} seconds ({Math.floor((targetSceneCount * 2) / 60)}:{String((targetSceneCount * 2) % 60).padStart(2, '0')})
                    </span>
                    <span>30 scenes</span>
                  </div>
                  <div className="mt-3 text-xs text-gray-500">
                    {targetSceneCount <= 10 ? "🎯 Quick & Punchy - Perfect for TikTok/Reels" :
                     targetSceneCount <= 20 ? "📱 Standard Length - Great for Instagram/YouTube Shorts" :
                     "🎬 Full Story - Ideal for YouTube/Facebook"}
                  </div>
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={() => addPrompt('script')}
                    className="px-6 py-3 bg-gray-700 text-white rounded-xl hover:bg-gray-600 transition"
                  >
                    + Add Title
                  </button>
                  <button
                    onClick={handleScriptGeneration}
                    disabled={scriptsLoading || !papaiApiKey}
                    className="px-8 py-3 bg-gradient-to-r from-green-500 to-blue-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {scriptsLoading ? 'Generating Stories...' : 'Generate Stories'}
                  </button>
                </div>

                {/* Prompt Inspection Section */}
                <div className="bg-gray-900/30 p-6 rounded-xl border border-gray-700">
                  <h4 className="text-lg font-bold text-white mb-4">🔍 Inspect AI Prompts</h4>
                  <p className="text-gray-400 mb-4">View the exact prompts sent to AI models for story generation</p>
                  <div className="flex gap-4">
                    <button
                      onClick={() => setShowStoryBulbPrompt(true)}
                      className="px-6 py-3 bg-blue-600/20 border border-blue-500/30 text-blue-300 rounded-xl hover:bg-blue-600/30 transition"
                    >
                      📄 View Story Bulb Prompt
                    </button>
                    <button
                      onClick={() => setShowStoryboardPrompt(true)}
                      className="px-6 py-3 bg-purple-600/20 border border-purple-500/30 text-purple-300 rounded-xl hover:bg-purple-600/30 transition"
                    >
                      🎬 View Storyboard Prompt
                    </button>
                  </div>
                </div>

                {generatedStories.length > 0 && (
                  <div className="space-y-4">
                    <div className="flex justify-between items-center mb-2">
                      <h4 className="text-xl font-bold text-white">Generated Story Bulbs</h4>
                      <div className="text-sm text-gray-400 bg-green-600/20 px-3 py-1 rounded-lg">
                        ✏️ All story parameters are editable below
                      </div>
                    </div>
                    <div className="grid gap-4">
                      {generatedStories.map((story, index) => (
                        <div 
                          key={index} 
                          className={`bg-gray-900/50 p-6 rounded-xl border-2 transition ${
                            selectedStory === story ? 'border-green-500 bg-gray-900/70' : 'border-gray-700'
                          }`}
                        >
                          <div className="flex justify-between items-start mb-4">
                            <div className="flex-1 mr-4">
                              <label className="block text-xs text-gray-400 mb-1">Title</label>
                              <input
                                type="text"
                                value={story.title}
                                onChange={(e) => updateStoryBulb(index, 'title', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-lg font-bold"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Tone</label>
                              <select
                                value={story.tone}
                                onChange={(e) => updateStoryBulb(index, 'tone', e.target.value)}
                                className="bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              >
                                <option value="inspiring">Inspiring</option>
                                <option value="dramatic">Dramatic</option>
                                <option value="cozy">Cozy</option>
                                <option value="creepy">Creepy</option>
                                <option value="comedic">Comedic</option>
                                <option value="educational">Educational</option>
                              </select>
                            </div>
                          </div>
                          
                          <div className="grid grid-cols-2 gap-4 mb-4">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Protagonist</label>
                              <input
                                type="text"
                                value={story.protagonist}
                                onChange={(e) => updateStoryBulb(index, 'protagonist', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Setting</label>
                              <input
                                type="text"
                                value={story.setting}
                                onChange={(e) => updateStoryBulb(index, 'setting', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Target Viewer</label>
                              <input
                                type="text"
                                value={story.target_viewer}
                                onChange={(e) => updateStoryBulb(index, 'target_viewer', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Visual Style</label>
                              <input
                                type="text"
                                value={story.visual_style}
                                onChange={(e) => updateStoryBulb(index, 'visual_style', e.target.value)}
                                placeholder="e.g., cinematic photoreal, anime style, oil painting, cyberpunk neon..."
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500"
                              />
                            </div>
                          </div>
                          
                          <div className="mb-4">
                            <label className="block text-xs text-gray-400 mb-1">Premise</label>
                            <textarea
                              value={story.premise}
                              onChange={(e) => updateStoryBulb(index, 'premise', e.target.value)}
                              rows={2}
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm resize-none"
                            />
                          </div>
                          
                          <div className="grid grid-cols-2 gap-4 mb-4">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Goal</label>
                              <textarea
                                value={story.goal}
                                onChange={(e) => updateStoryBulb(index, 'goal', e.target.value)}
                                rows={2}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm resize-none"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Stakes</label>
                              <textarea
                                value={story.stakes}
                                onChange={(e) => updateStoryBulb(index, 'stakes', e.target.value)}
                                rows={2}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm resize-none"
                              />
                            </div>
                          </div>
                          
                          <div className="mb-4">
                            <label className="block text-xs text-gray-400 mb-1">Twist</label>
                            <textarea
                              value={story.twist}
                              onChange={(e) => updateStoryBulb(index, 'twist', e.target.value)}
                              rows={2}
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-yellow-400 text-sm resize-none italic"
                            />
                          </div>

                          <div className="mb-4">
                            <label className="block text-xs text-gray-400 mb-1">Action Emphasis</label>
                            <textarea
                              value={story.action_emphasis}
                              onChange={(e) => updateStoryBulb(index, 'action_emphasis', e.target.value)}
                              rows={2}
                              placeholder="How actions cause reactions and consequences..."
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm resize-none"
                            />
                          </div>

                          {/* Causality Fields */}
                          <div className="mb-4 border-t border-gray-700 pt-4">
                            <h5 className="text-sm font-semibold text-blue-300 mb-3">🔗 Causality Structure</h5>
                            
                            <div className="mb-4">
                              <label className="block text-xs text-gray-400 mb-1">Domino Sequences</label>
                              <div className="space-y-2">
                                {(story.domino_sequences || []).map((sequence, seqIndex) => (
                                  <div key={seqIndex} className="flex gap-2">
                                    <textarea
                                      value={sequence}
                                      onChange={(e) => {
                                        const newSequences = [...(story.domino_sequences || [])];
                                        newSequences[seqIndex] = e.target.value;
                                        updateStoryBulb(index, 'domino_sequences', newSequences);
                                      }}
                                      rows={1}
                                      placeholder="Cause → Effect → Consequence chain..."
                                      className="flex-1 bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-xs resize-none"
                                    />
                                    <button
                                      onClick={() => {
                                        const newSequences = (story.domino_sequences || []).filter((_, i) => i !== seqIndex);
                                        updateStoryBulb(index, 'domino_sequences', newSequences);
                                      }}
                                      className="px-2 py-2 bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 text-xs"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ))}
                                <button
                                  onClick={() => {
                                    const newSequences = [...(story.domino_sequences || []), ''];
                                    updateStoryBulb(index, 'domino_sequences', newSequences);
                                  }}
                                  className="text-xs text-blue-400 hover:text-blue-300"
                                >
                                  + Add Domino Sequence
                                </button>
                              </div>
                            </div>

                            <div className="mb-4">
                              <label className="block text-xs text-gray-400 mb-1">Setup/Payoff Pairs</label>
                              <div className="space-y-2">
                                {(story.setups_payoffs || []).map((pair, pairIndex) => (
                                  <div key={pairIndex} className="grid grid-cols-2 gap-2">
                                    <input
                                      type="text"
                                      value={pair.setup || ''}
                                      onChange={(e) => {
                                        const newPairs = [...(story.setups_payoffs || [])];
                                        newPairs[pairIndex] = { ...newPairs[pairIndex], setup: e.target.value };
                                        updateStoryBulb(index, 'setups_payoffs', newPairs);
                                      }}
                                      placeholder="Setup (early element)..."
                                      className="bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-xs"
                                    />
                                    <div className="flex gap-2">
                                      <input
                                        type="text"
                                        value={pair.payoff || ''}
                                        onChange={(e) => {
                                          const newPairs = [...(story.setups_payoffs || [])];
                                          newPairs[pairIndex] = { ...newPairs[pairIndex], payoff: e.target.value };
                                          updateStoryBulb(index, 'setups_payoffs', newPairs);
                                        }}
                                        placeholder="Payoff (later consequence)..."
                                        className="flex-1 bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-xs"
                                      />
                                      <button
                                        onClick={() => {
                                          const newPairs = (story.setups_payoffs || []).filter((_, i) => i !== pairIndex);
                                          updateStoryBulb(index, 'setups_payoffs', newPairs);
                                        }}
                                        className="px-2 py-2 bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 text-xs"
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  </div>
                                ))}
                                <button
                                  onClick={() => {
                                    const newPairs = [...(story.setups_payoffs || []), { setup: '', payoff: '' }];
                                    updateStoryBulb(index, 'setups_payoffs', newPairs);
                                  }}
                                  className="text-xs text-blue-400 hover:text-blue-300"
                                >
                                  + Add Setup/Payoff Pair
                                </button>
                              </div>
                            </div>

                            <div className="mb-4">
                              <label className="block text-xs text-gray-400 mb-1">Escalation Points</label>
                              <div className="space-y-2">
                                {(story.escalation_points || []).map((point, pointIndex) => (
                                  <div key={pointIndex} className="flex gap-2">
                                    <textarea
                                      value={point}
                                      onChange={(e) => {
                                        const newPoints = [...(story.escalation_points || [])];
                                        newPoints[pointIndex] = e.target.value;
                                        updateStoryBulb(index, 'escalation_points', newPoints);
                                      }}
                                      rows={1}
                                      placeholder="Stakes increase BECAUSE of protagonist action..."
                                      className="flex-1 bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-xs resize-none"
                                    />
                                    <button
                                      onClick={() => {
                                        const newPoints = (story.escalation_points || []).filter((_, i) => i !== pointIndex);
                                        updateStoryBulb(index, 'escalation_points', newPoints);
                                      }}
                                      className="px-2 py-2 bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 text-xs"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ))}
                                <button
                                  onClick={() => {
                                    const newPoints = [...(story.escalation_points || []), ''];
                                    updateStoryBulb(index, 'escalation_points', newPoints);
                                  }}
                                  className="text-xs text-blue-400 hover:text-blue-300"
                                >
                                  + Add Escalation Point
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-4 mb-4">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Call to Action</label>
                              <input
                                type="text"
                                value={story.call_to_action}
                                onChange={(e) => updateStoryBulb(index, 'call_to_action', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-blue-400 text-sm"
                                placeholder="Optional call to action"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Constraint</label>
                              <input
                                type="text"
                                value={story.constraint}
                                onChange={(e) => updateStoryBulb(index, 'constraint', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-orange-400 text-sm"
                                placeholder="Story constraint"
                              />
                            </div>
                          </div>
                          
                          <div className="grid grid-cols-2 gap-4 mb-4">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Runtime (seconds)</label>
                              <input
                                type="number"
                                value={story.runtime_sec}
                                onChange={(e) => updateStoryBulb(index, 'runtime_sec', parseInt(e.target.value) || 60)}
                                min="30"
                                max="180"
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Narration POV</label>
                              <select
                                value={story.narration_pov}
                                onChange={(e) => updateStoryBulb(index, 'narration_pov', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              >
                                <option value="first_person">First Person</option>
                                <option value="third_person">Third Person</option>
                              </select>
                            </div>
                          </div>
                          
                          <div className="flex justify-between items-center mt-4">
                            {selectedStory === story && (
                              <button
                                onClick={() => handleStoryboardGeneration()}
                                disabled={storyboardsLoading}
                                className="px-4 py-2 bg-gradient-to-r from-green-500 to-blue-600 text-white text-sm font-semibold rounded-lg hover:from-green-600 hover:to-blue-700 disabled:opacity-50 transition"
                              >
                                {storyboardsLoading ? (
                                  storyboardProgress.status ? `${storyboardProgress.currentScene}/${storyboardProgress.totalScenes}...` : 'Generating...'
                                ) : 'Generate Storyboard →'}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Images Tab */}
            {activeTab === 'images' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Batch Image Generation</h3>
                  <p className="text-gray-400 mb-6">Generate multiple images for your video scenes</p>
                </div>

                {/* Image Provider Selection */}
                <div className="bg-gray-900/50 p-4 rounded-xl">
                  <label className="block text-white text-sm font-semibold mb-3">
                    Image Generation Provider
                  </label>
                  <div className="flex gap-4 mb-4 flex-wrap">
                    <button
                      onClick={() => setImageProvider('openrouter')}
                      className={`px-4 py-2 rounded-xl transition ${
                        imageProvider === 'openrouter'
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      OpenRouter
                    </button>
                    <button
                      onClick={() => setImageProvider('gemini')}
                      className={`px-4 py-2 rounded-xl transition ${
                        imageProvider === 'gemini'
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      Gemini 2.5 (Requires Billing)
                    </button>
                    <button
                      onClick={() => setImageProvider('highbid')}
                      className={`px-4 py-2 rounded-xl transition ${
                        imageProvider === 'highbid'
                          ? 'bg-purple-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      Highbid (Flux)
                    </button>
                  </div>
                  
                  {/* Dimension controls for Highbid */}
                  {imageProvider === 'highbid' && (
                    <div className="mt-4">
                      <label className="block text-gray-400 text-xs mb-2">Quick Presets</label>
                      
                      {/* 16:9 Landscape Resolutions */}
                      <div className="mb-2">
                        <span className="text-xs text-gray-500 block mb-1">16:9 Landscape (Video)</span>
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            onClick={() => { setImageWidth(1920); setImageHeight(1080); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 1920 && imageHeight === 1080
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            1920×1080
                          </button>
                          <button
                            onClick={() => { setImageWidth(1280); setImageHeight(720); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 1280 && imageHeight === 720
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            1280×720
                          </button>
                          <button
                            onClick={() => { setImageWidth(1024); setImageHeight(576); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 1024 && imageHeight === 576
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            1024×576
                          </button>
                        </div>
                      </div>
                      
                      {/* 9:16 Portrait Resolutions */}
                      <div className="mb-2">
                        <span className="text-xs text-gray-500 block mb-1">9:16 Portrait (Stories/Reels)</span>
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            onClick={() => { setImageWidth(1080); setImageHeight(1920); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 1080 && imageHeight === 1920
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            1080×1920
                          </button>
                          <button
                            onClick={() => { setImageWidth(720); setImageHeight(1280); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 720 && imageHeight === 1280
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            720×1280
                          </button>
                          <button
                            onClick={() => { setImageWidth(576); setImageHeight(1024); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 576 && imageHeight === 1024
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            576×1024
                          </button>
                        </div>
                      </div>
                      
                      {/* Square Resolution */}
                      <div className="mb-3">
                        <span className="text-xs text-gray-500 block mb-1">1:1 Square (Instagram)</span>
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            onClick={() => { setImageWidth(1024); setImageHeight(1024); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 1024 && imageHeight === 1024
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            1024×1024
                          </button>
                          <button
                            onClick={() => { setImageWidth(768); setImageHeight(768); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 768 && imageHeight === 768
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            768×768
                          </button>
                          <button
                            onClick={() => { setImageWidth(512); setImageHeight(512); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 512 && imageHeight === 512
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            512×512
                          </button>
                        </div>
                      </div>
                      
                      {/* Custom dimension inputs */}
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-gray-400 text-xs mb-1">Custom Width</label>
                          <select
                            value={imageWidth}
                            onChange={(e) => setImageWidth(Number(e.target.value))}
                            className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white text-sm"
                          >
                            <option value={512}>512px</option>
                            <option value={576}>576px</option>
                            <option value={640}>640px</option>
                            <option value={720}>720px</option>
                            <option value={768}>768px</option>
                            <option value={896}>896px</option>
                            <option value={1024}>1024px</option>
                            <option value={1280}>1280px</option>
                            <option value={1536}>1536px</option>
                            <option value={1920}>1920px</option>
                            <option value={2048}>2048px</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-gray-400 text-xs mb-1">Custom Height</label>
                          <select
                            value={imageHeight}
                            onChange={(e) => setImageHeight(Number(e.target.value))}
                            className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white text-sm"
                          >
                            <option value={360}>360px</option>
                            <option value={480}>480px</option>
                            <option value={512}>512px</option>
                            <option value={576}>576px</option>
                            <option value={720}>720px</option>
                            <option value={768}>768px</option>
                            <option value={1024}>1024px</option>
                            <option value={1080}>1080px</option>
                            <option value={1536}>1536px</option>
                            <option value={2048}>2048px</option>
                          </select>
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-gray-500">
                        Aspect Ratio: {(imageWidth / imageHeight).toFixed(2)}:1 ({imageWidth}×{imageHeight})
                      </div>
                    </div>
                  )}
                  
                  {imageProvider === 'highbid' && !highbidApiUrl && (
                    <div className="mt-3 text-yellow-400 text-sm">
                      Please enter your Highbid API URL above to generate images
                    </div>
                  )}
                  {imageProvider === 'openrouter' && !apiKey && (
                    <div className="mt-3 text-yellow-400 text-sm">
                      Please enter your OpenRouter API key above to generate images
                    </div>
                  )}
                  {imageProvider === 'gemini' && !googleTtsKey && (
                    <div className="mt-3 text-yellow-400 text-sm">
                      Please enter your Gemini API key above (Requires billing enabled for image generation)
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  {imagePrompts.map((prompt, index) => (
                    <div key={index} className="flex gap-3">
                      <textarea
                        value={prompt}
                        onChange={(e) => updatePrompt('image', index, e.target.value)}
                        placeholder={`Image prompt ${index + 1}...`}
                        rows={3}
                        className="flex-1 px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition resize-none"
                      />
                      <button
                        onClick={() => removePrompt('image', index)}
                        disabled={imagePrompts.length === 1}
                        className="px-4 py-2 bg-red-600/20 text-red-400 rounded-xl hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={() => addPrompt('image')}
                    className="px-6 py-3 bg-gray-700 text-white rounded-xl hover:bg-gray-600 transition"
                  >
                    + Add Image Prompt
                  </button>
                  <button
                    onClick={handleImageGeneration}
                    disabled={imagesLoading || (imageProvider === 'openrouter' ? !apiKey : imageProvider === 'gemini' ? !googleTtsKey : !highbidApiUrl)}
                    className={`px-8 py-3 text-white font-semibold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition ${
                      imageProvider === 'highbid' 
                        ? 'bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700'
                        : imageProvider === 'gemini'
                          ? 'bg-gradient-to-r from-green-500 to-teal-600 hover:from-green-600 hover:to-teal-700'
                          : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700'
                    }`}
                  >
                    {imagesLoading 
                      ? `Generating with ${imageProvider === 'highbid' ? 'Highbid' : imageProvider === 'gemini' ? 'Gemini' : 'OpenRouter'}...` 
                      : `Generate with ${imageProvider === 'highbid' ? `Highbid (${imageWidth}x${imageHeight})` : imageProvider === 'gemini' ? 'Gemini' : 'OpenRouter'}`}
                  </button>
                </div>

                {generatedImages.length > 0 && (
                  <div className="space-y-4">
                    <h4 className="text-xl font-bold text-white">Generated Images</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {generatedImages.map((image, index) => (
                        <div key={index} className="bg-gray-900/50 p-4 rounded-xl">
                          <div className="relative w-full h-48 mb-3">
                            <Image
                              src={image}
                              alt={`Generated ${index + 1}`}
                              fill
                              className="object-cover rounded-xl"
                              unoptimized
                            />
                          </div>
                          <button
                            onClick={() => {
                              const link = document.createElement('a');
                              link.href = image;
                              link.download = `generated-image-${index + 1}.png`;
                              link.click();
                            }}
                            className="w-full py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-xl transition"
                          >
                            Download
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Storyboard Tab */}
            {activeTab === 'storyboard' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Visual Storyboard</h3>
                  <p className="text-gray-400 mb-6">Dynamic storyboard with complete visual and audio direction</p>
                  
                  {/* Project Import/Export Controls */}
                  <div className="bg-gray-900/30 p-4 rounded-xl border border-gray-700 mb-6">
                    <h4 className="text-lg font-bold text-white mb-3">📦 Project Management</h4>
                    <div className="flex gap-4">
                      <button
                        onClick={downloadProjectAsZip}
                        disabled={!selectedStory || generatedStoryboard.length === 0}
                        className="px-4 py-2 bg-green-600/20 border border-green-500/30 text-green-300 rounded-xl hover:bg-green-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        📥 Download Project ZIP
                      </button>
                      
                      <label className="px-4 py-2 bg-blue-600/20 border border-blue-500/30 text-blue-300 rounded-xl hover:bg-blue-600/30 cursor-pointer transition">
                        📤 Upload Project ZIP
                        <input
                          type="file"
                          accept=".zip"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              uploadProjectFromZip(file);
                            }
                          }}
                          className="hidden"
                        />
                      </label>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      Download preserves all generated content (scenes, images, voiceovers) with metadata for later restoration
                    </p>
                  </div>
                </div>

                {!selectedStory && !generatedStoryboard.length && (
                  <div className="text-center py-12 bg-gray-900/30 rounded-xl">
                    <div className="text-6xl mb-4">🎬</div>
                    <p className="text-gray-400 mb-4">No story selected</p>
                    <button
                      onClick={() => setActiveTab('scripts')}
                      className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                    >
                      Go to Scripts Tab
                    </button>
                  </div>
                )}

                {selectedStory && !generatedStoryboard.length && (
                  <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-700">
                    <h4 className="text-lg font-bold text-white mb-3">Selected Story: {selectedStory.title}</h4>
                    <button
                      onClick={() => handleStoryboardGeneration(1)}
                      disabled={storyboardsLoading}
                      className="px-8 py-3 bg-gradient-to-r from-green-500 to-blue-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-blue-700 disabled:opacity-50 transition"
                    >
                      {storyboardsLoading ? 'Generating Storyboard...' : 'Generate 30-Scene Storyboard'}
                    </button>
                  </div>
                )}

                {/* Resume Generation Section - Show when there are partial scenes */}
                {selectedStory && generatedStoryboard.length > 0 && generatedStoryboard.length < (selectedStory.target_scene_count || 30) && (
                  <div className="bg-yellow-900/20 p-6 rounded-xl border border-yellow-700">
                    <h4 className="text-lg font-bold text-yellow-200 mb-3">
                      Partial Storyboard ({generatedStoryboard.length}/{selectedStory.target_scene_count || 30} scenes)
                    </h4>
                    <p className="text-yellow-300 mb-4">
                      Generation stopped at scene {generatedStoryboard.length}. You can resume or start over.
                    </p>
                    <div className="flex gap-3">
                      <button
                        onClick={() => handleStoryboardGeneration(generatedStoryboard.length + 1)}
                        disabled={storyboardsLoading}
                        className="px-6 py-2 bg-gradient-to-r from-yellow-500 to-orange-600 text-white font-semibold rounded-xl hover:from-yellow-600 hover:to-orange-700 disabled:opacity-50 transition"
                      >
                        {storyboardsLoading ? 'Resuming...' : `Resume from Scene ${generatedStoryboard.length + 1}`}
                      </button>
                      <button
                        onClick={() => handleStoryboardGeneration(1)}
                        disabled={storyboardsLoading}
                        className="px-6 py-2 bg-gradient-to-r from-green-500 to-blue-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-blue-700 disabled:opacity-50 transition"
                      >
                        {storyboardsLoading ? 'Restarting...' : 'Start Over'}
                      </button>
                    </div>
                  </div>
                )}
                    
                    {/* Progress Display */}
                    {storyboardsLoading && storyboardProgress.status && (
                      <div className="mt-6 bg-gray-900/50 p-4 rounded-xl border border-gray-700">
                        <div className="flex justify-between items-center mb-3">
                          <div className="text-white font-medium">Storyboard Generation Progress</div>
                          <div className="text-sm text-gray-400">
                            {storyboardProgress.currentScene}/{storyboardProgress.totalScenes} scenes
                          </div>
                        </div>
                        
                        {/* Progress Bar */}
                        <div className="mb-3">
                          <div className="flex justify-between text-xs text-gray-500 mb-1">
                            <span>Batch {storyboardProgress.currentBatch}/{storyboardProgress.totalBatches}</span>
                            <span>{Math.round((storyboardProgress.currentScene / storyboardProgress.totalScenes) * 100)}%</span>
                          </div>
                          <div className="w-full bg-gray-800 rounded-full h-2">
                            <div 
                              className="bg-gradient-to-r from-green-500 to-blue-600 h-2 rounded-full transition-all duration-500"
                              style={{ width: `${(storyboardProgress.currentScene / storyboardProgress.totalScenes) * 100}%` }}
                            ></div>
                          </div>
                        </div>
                        
                        {/* Status Text */}
                        <div className="text-sm text-gray-300 flex items-center">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-green-500 mr-2"></div>
                          {storyboardProgress.status}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {generatedStoryboard.length > 0 && (
                  <div className="space-y-6">
                    {/* TTS Provider Selection */}
                    <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-700">
                      <label className="block text-white text-sm font-semibold mb-3">
                        🎤 TTS Provider for Voice Generation
                      </label>
                      <div className="flex flex-wrap gap-3 mb-4">
                        <button
                          onClick={() => {
                            setTtsProvider('elevenlabs');
                            setVoicesLoaded(false);
                            setGoogleVoicesLoaded(false);
                            setAvailableVoices([]);
                            setSelectedVoiceId('21m00Tcm4TlvDq8ikWAM');
                          }}
                          className={`px-4 py-2 rounded-xl transition text-sm font-medium ${
                            ttsProvider === 'elevenlabs'
                              ? 'bg-blue-600 text-white shadow-lg'
                              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          }`}
                        >
                          ElevenLabs
                        </button>
                        <button
                          onClick={() => {
                            setTtsProvider('google');
                            setVoicesLoaded(false);
                            setGoogleVoicesLoaded(false);
                            setAvailableVoices([]);
                            setSelectedVoiceId('Kore');
                          }}
                          className={`px-4 py-2 rounded-xl transition text-sm font-medium ${
                            ttsProvider === 'google'
                              ? 'bg-green-600 text-white shadow-lg'
                              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          }`}
                        >
                          Google Gemini TTS
                        </button>
                        <button
                          onClick={() => {
                            setTtsProvider('kokoro');
                            setVoicesLoaded(false);
                            setGoogleVoicesLoaded(false);
                            setAvailableVoices([]);
                            setSelectedVoiceId('af_heart');
                          }}
                          className={`px-4 py-2 rounded-xl transition text-sm font-medium ${
                            ttsProvider === 'kokoro'
                              ? 'bg-purple-600 text-white shadow-lg'
                              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          }`}
                        >
                          Kokoro TTS
                        </button>
                      </div>
                      <div className="text-xs text-gray-400">
                        Selected: <span className="text-white font-medium">{
                          ttsProvider === 'elevenlabs' ? 'ElevenLabs' :
                          ttsProvider === 'google' ? 'Google Gemini TTS' :
                          'Kokoro TTS'
                        }</span>
                      </div>
                    </div>

                    {/* Story Summary - Editable */}
                    {selectedStory && (
                      <div className="bg-gradient-to-r from-green-900/30 to-blue-900/30 p-6 rounded-xl border border-gray-700">
                        <div className="text-center mb-4">
                          <div className="inline-block bg-blue-600/20 text-blue-300 px-4 py-2 rounded-lg text-sm">
                            ✏️ <strong>Story Editing Mode</strong> - All fields below are editable. Changes apply immediately.
                          </div>
                        </div>
                        <div className="grid md:grid-cols-2 gap-4 mb-4">
                          {/* Title */}
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Title</label>
                            <input
                              type="text"
                              value={selectedStory.title}
                              onChange={(e) => {
                                const updated = { ...selectedStory, title: e.target.value };
                                setSelectedStory(updated);
                                // Update in generatedStories array
                                setGeneratedStories(prev => prev.map(story => 
                                  story === selectedStory ? updated : story
                                ));
                              }}
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                            />
                          </div>
                          
                          {/* Visual Style */}
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Visual Style</label>
                            <input
                              type="text"
                              value={selectedStory.visual_style}
                              onChange={(e) => {
                                const updated = { ...selectedStory, visual_style: e.target.value };
                                setSelectedStory(updated);
                                setGeneratedStories(prev => prev.map(story => 
                                  story === selectedStory ? updated : story
                                ));
                              }}
                              placeholder="e.g., cinematic photoreal, anime style, oil painting, cyberpunk neon..."
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500"
                            />
                          </div>
                        </div>
                        
                        {/* Premise */}
                        <div className="mb-4">
                          <label className="block text-xs text-gray-400 mb-1">Premise</label>
                          <textarea
                            value={selectedStory.premise}
                            onChange={(e) => {
                              const updated = { ...selectedStory, premise: e.target.value };
                              setSelectedStory(updated);
                              setGeneratedStories(prev => prev.map(story => 
                                story === selectedStory ? updated : story
                              ));
                            }}
                            rows={2}
                            className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                          />
                        </div>
                        
                        {/* Quick Settings Row */}
                        <div className="grid grid-cols-3 gap-4 mb-4">
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Tone</label>
                            <select
                              value={selectedStory.tone}
                              onChange={(e) => {
                                const updated = { ...selectedStory, tone: e.target.value };
                                setSelectedStory(updated);
                                setGeneratedStories(prev => prev.map(story => 
                                  story === selectedStory ? updated : story
                                ));
                              }}
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                            >
                              <option value="inspiring">Inspiring</option>
                              <option value="dramatic">Dramatic</option>
                              <option value="cozy">Cozy</option>
                              <option value="creepy">Creepy</option>
                              <option value="comedic">Comedic</option>
                              <option value="educational">Educational</option>
                            </select>
                          </div>
                          
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">POV</label>
                            <select
                              value={selectedStory.narration_pov}
                              onChange={(e) => {
                                const updated = { ...selectedStory, narration_pov: e.target.value };
                                setSelectedStory(updated);
                                setGeneratedStories(prev => prev.map(story => 
                                  story === selectedStory ? updated : story
                                ));
                              }}
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                            >
                              <option value="first_person">First Person</option>
                              <option value="third_person">Third Person</option>
                            </select>
                          </div>
                          
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Runtime (seconds)</label>
                            <input
                              type="number"
                              value={selectedStory.runtime_sec}
                              onChange={(e) => {
                                const updated = { ...selectedStory, runtime_sec: parseInt(e.target.value) || 60 };
                                setSelectedStory(updated);
                                setGeneratedStories(prev => prev.map(story => 
                                  story === selectedStory ? updated : story
                                ));
                              }}
                              min="30"
                              max="180"
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                            />
                          </div>
                        </div>
                        
                        {/* Expandable Advanced Settings */}
                        <details className="cursor-pointer">
                          <summary className="text-sm text-gray-400 hover:text-gray-300 mb-3">Advanced Story Parameters</summary>
                          <div className="grid md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Target Viewer</label>
                              <input
                                type="text"
                                value={selectedStory.target_viewer}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, target_viewer: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Protagonist</label>
                              <input
                                type="text"
                                value={selectedStory.protagonist}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, protagonist: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Goal</label>
                              <textarea
                                value={selectedStory.goal}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, goal: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                rows={2}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Stakes</label>
                              <textarea
                                value={selectedStory.stakes}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, stakes: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                rows={2}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Setting</label>
                              <input
                                type="text"
                                value={selectedStory.setting}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, setting: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Constraint</label>
                              <input
                                type="text"
                                value={selectedStory.constraint}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, constraint: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div className="md:col-span-2">
                              <label className="block text-xs text-gray-400 mb-1">Twist</label>
                              <textarea
                                value={selectedStory.twist}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, twist: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                rows={2}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div className="md:col-span-2">
                              <label className="block text-xs text-gray-400 mb-1">Call to Action</label>
                              <input
                                type="text"
                                value={selectedStory.call_to_action}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, call_to_action: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                          </div>
                        </details>
                      </div>
                    )}

                    {/* Batch Generation Buttons */}
                    <div className="grid md:grid-cols-2 gap-4 mb-4">
                      {/* Batch Images */}
                      <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-700">
                        <div className="flex justify-between items-center">
                          <div>
                            <h4 className="text-lg font-bold text-white mb-2">Generate Images</h4>
                            <p className="text-gray-400 text-sm">Generate images for all scenes</p>
                          </div>
                          <button
                            onClick={generateAllStoryboardImages}
                            disabled={batchImageLoading || (imageProvider === 'openrouter' ? !apiKey : imageProvider === 'gemini' ? !googleTtsKey : !highbidApiUrl)}
                            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                          >
                            {batchImageLoading ? 'Generating...' : 'Generate All'}
                          </button>
                        </div>
                        
                        {/* Batch Image Progress */}
                        {batchImageLoading && batchImageProgress.status && (
                          <div className="mt-4 p-4 bg-gray-800/50 rounded-lg border border-purple-500/30">
                            <div className="flex justify-between items-center mb-2">
                              <span className="text-sm text-white font-medium">Batch Image Generation</span>
                              <span className="text-xs text-gray-400">
                                {batchImageProgress.current}/{batchImageProgress.total} • Scene #{batchImageProgress.currentScene}
                              </span>
                            </div>
                            
                            <div className="w-full bg-gray-700 rounded-full h-2 mb-2">
                              <div 
                                className="bg-gradient-to-r from-purple-500 to-pink-500 h-2 rounded-full transition-all duration-500"
                                style={{ width: `${(batchImageProgress.current / batchImageProgress.total) * 100}%` }}
                              ></div>
                            </div>
                            
                            <div className="flex justify-between text-xs">
                              <span className="text-gray-300">{batchImageProgress.status}</span>
                              <span className="text-gray-400">
                                {batchImageProgress.failed > 0 && `${batchImageProgress.failed} failed • `}
                                {batchImageProgress.retries > 0 && `${batchImageProgress.retries} retries`}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                      
                      {/* Batch Voiceovers */}
                      <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-700">
                        <div className="flex justify-between items-center">
                          <div>
                            <h4 className="text-lg font-bold text-white mb-2">Generate Voiceovers</h4>
                            <p className="text-gray-400 text-sm">Generate voiceovers for all scenes</p>
                          </div>
                          <button
                            onClick={generateAllStoryboardVoiceovers}
                            disabled={batchVoiceoverLoading || (
                              ttsProvider === 'elevenlabs' ? !elevenLabsKey :
                              ttsProvider === 'kokoro' ? !kokoroUrl :
                              !googleTtsKey
                            ) || !selectedVoiceId}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                            title={!selectedVoiceId ? 'Loading voices...' : ''}
                          >
                            {batchVoiceoverLoading ? 'Generating...' : !selectedVoiceId ? 'Loading Voices...' : 'Generate All'}
                          </button>
                        </div>
                        
                        {/* Batch Voiceover Progress */}
                        {batchVoiceoverLoading && batchVoiceoverProgress.status && (
                          <div className="mt-4 p-4 bg-gray-800/50 rounded-lg border border-blue-500/30">
                            <div className="flex justify-between items-center mb-2">
                              <span className="text-sm text-white font-medium">Batch Voiceover Generation</span>
                              <span className="text-xs text-gray-400">
                                {batchVoiceoverProgress.current}/{batchVoiceoverProgress.total} • Scene #{batchVoiceoverProgress.currentScene}
                              </span>
                            </div>
                            
                            <div className="w-full bg-gray-700 rounded-full h-2 mb-2">
                              <div 
                                className="bg-gradient-to-r from-blue-500 to-cyan-500 h-2 rounded-full transition-all duration-500"
                                style={{ width: `${(batchVoiceoverProgress.current / batchVoiceoverProgress.total) * 100}%` }}
                              ></div>
                            </div>
                            
                            <div className="flex justify-between text-xs">
                              <span className="text-gray-300">{batchVoiceoverProgress.status}</span>
                              <span className="text-gray-400">
                                {batchVoiceoverProgress.failed > 0 && `${batchVoiceoverProgress.failed} failed • `}
                                {batchVoiceoverProgress.retries > 0 && `${batchVoiceoverProgress.retries} retries`}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Storyboard Grid */}
                    <div className="grid gap-4">
                      {generatedStoryboard.map((scene, index) => (
                        <div key={index} className="bg-gray-900/50 rounded-xl border border-gray-700 overflow-hidden">
                          <div className="flex">
                            {/* Scene Info Panel */}
                            <div className="w-1/5 p-4 border-r border-gray-700">
                              <div className="flex justify-between items-start mb-3">
                                <div>
                                  <span className="text-2xl font-bold text-white">#{scene.scene_id}</span>
                                  <span className={`ml-3 px-2 py-1 text-xs rounded-full ${
                                    scene.beat === 'hook' ? 'bg-red-600/20 text-red-400' :
                                    scene.beat === 'climax' ? 'bg-yellow-600/20 text-yellow-400' :
                                    scene.beat === 'resolution' ? 'bg-green-600/20 text-green-400' :
                                    scene.beat === 'cta' ? 'bg-blue-600/20 text-blue-400' :
                                    'bg-gray-600/20 text-gray-400'
                                  }`}>
                                    {scene.beat}
                                  </span>
                                </div>
                                <span className="text-xs text-gray-500">
                                  {(scene.start_ms / 1000).toFixed(1)}s - {(scene.end_ms / 1000).toFixed(1)}s
                                </span>
                              </div>
                              
                              {/* Voice Over */}
                              <div className="mb-4">
                                <label className="text-xs text-gray-500 block mb-1">Voice Over</label>
                                <p className={`text-sm text-white ${
                                  scene.vo_emphasis === 'strong' ? 'font-bold' :
                                  scene.vo_emphasis === 'slight' ? 'font-medium' : ''
                                }`}>
                                  &ldquo;{scene.vo_text}&rdquo;
                                </p>
                                <span className="text-xs text-gray-500">Speed: {scene.read_speed_wps} wps</span>
                              </div>

                              {/* Scene Twist */}
                              {scene.scene_twist && (
                                <div className="mb-4">
                                  <label className="text-xs text-gray-500 block mb-1">Scene Twist</label>
                                  <p className="text-sm text-orange-400 bg-orange-600/10 p-2 rounded italic">
                                    {scene.scene_twist}
                                  </p>
                                </div>
                              )}

                              {/* Causality Chain */}
                              {(scene.caused_by || scene.leads_to || scene.callback_to !== 'none') && (
                                <div className="mb-4 border-l-2 border-blue-500/30 pl-3">
                                  <label className="text-xs text-blue-400 block mb-2">🔗 Causality Chain</label>
                                  
                                  {scene.caused_by && (
                                    <div className="mb-2">
                                      <span className="text-xs text-gray-500">Caused by:</span>
                                      <p className="text-xs text-gray-300 bg-gray-800/50 p-1 rounded">
                                        {scene.caused_by}
                                      </p>
                                    </div>
                                  )}
                                  
                                  {scene.leads_to && (
                                    <div className="mb-2">
                                      <span className="text-xs text-gray-500">Leads to:</span>
                                      <p className="text-xs text-gray-300 bg-gray-800/50 p-1 rounded">
                                        {scene.leads_to}
                                      </p>
                                    </div>
                                  )}
                                  
                                  {scene.callback_to && scene.callback_to !== 'none' && (
                                    <div className="mb-2">
                                      <span className="text-xs text-gray-500">Callback to:</span>
                                      <p className="text-xs text-yellow-300 bg-yellow-800/20 p-1 rounded">
                                        {scene.callback_to}
                                      </p>
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Text Overlay */}
                              {scene.text_overlay?.content && (
                                <div className="mb-4">
                                  <label className="text-xs text-gray-500 block mb-1">Text Overlay</label>
                                  <p className={`text-sm ${
                                    scene.text_overlay.weight === 'bold' ? 'text-yellow-400 font-bold' :
                                    scene.text_overlay.weight === 'subtle' ? 'text-gray-400' :
                                    'text-gray-500'
                                  }`}>
                                    {scene.text_overlay.content}
                                  </p>
                                  <span className="text-xs text-gray-500">Position: {scene.text_overlay.position}</span>
                                </div>
                              )}

                              {/* Transitions & Music */}
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div>
                                  <span className="text-gray-500">In:</span>
                                  <span className="text-gray-400 ml-1">{scene.transition_in}</span>
                                </div>
                                <div>
                                  <span className="text-gray-500">Out:</span>
                                  <span className="text-gray-400 ml-1">{scene.transition_out}</span>
                                </div>
                                <div>
                                  <span className="text-gray-500">Music:</span>
                                  <span className="text-gray-400 ml-1">{scene.music_cue}</span>
                                </div>
                              </div>
                            </div>

                            {/* Visual Prompt Panel */}
                            <div className="w-1/4 p-4 border-r border-gray-700">
                              <label className="text-xs text-gray-500 block mb-2">Visual Direction</label>
                              
                              <div className="grid grid-cols-2 gap-3 mb-3">
                                <div>
                                  <span className="text-xs text-gray-500">Setting</span>
                                  <p className="text-sm text-gray-300">{scene.visual_prompt.setting}</p>
                                </div>
                                <div>
                                  <span className="text-xs text-gray-500">Characters</span>
                                  <p className="text-sm text-gray-300">{scene.visual_prompt.characters}</p>
                                </div>
                                <div>
                                  <span className="text-xs text-gray-500">Action</span>
                                  <p className="text-sm text-gray-300">{scene.visual_prompt.action}</p>
                                </div>
                                <div>
                                  <span className="text-xs text-gray-500">Props</span>
                                  <p className="text-sm text-gray-300">{scene.visual_prompt.props}</p>
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-2 mb-3">
                                <span className="px-2 py-1 text-xs bg-purple-600/20 text-purple-400 rounded">
                                  {scene.visual_prompt.mood}
                                </span>
                                <span className="px-2 py-1 text-xs bg-orange-600/20 text-orange-400 rounded">
                                  {scene.visual_prompt.lighting}
                                </span>
                                <span className="px-2 py-1 text-xs bg-blue-600/20 text-blue-400 rounded">
                                  {scene.visual_prompt.color_palette}
                                </span>
                                <span className="px-2 py-1 text-xs bg-green-600/20 text-green-400 rounded">
                                  {scene.visual_prompt.composition}
                                </span>
                              </div>

                              <div className="text-xs">
                                <p className="text-gray-500 mb-1">Camera: <span className="text-gray-400">{scene.visual_prompt.camera}</span></p>
                                <p className="text-gray-500 mb-1">Style: <span className="text-gray-400">{scene.visual_prompt.style_tags}</span></p>
                                <p className="text-gray-500">Model: <span className="text-gray-400">{scene.visual_prompt.model_hint}</span> | Seed: <span className="text-gray-400">{scene.visual_prompt.seed}</span></p>
                              </div>
                            </div>

                            {/* Voiceover Generation Panel */}
                            <div className="w-1/4 p-4 border-r border-gray-700">
                              <div className="flex justify-between items-center mb-2">
                                <label className="text-xs text-gray-500">Generated Audio</label>
                                <button
                                  onClick={() => generateStoryboardVoiceover(scene)}
                                  disabled={voiceoverGenerationLoading[scene.scene_id] || (
                                    ttsProvider === 'elevenlabs' ? !elevenLabsKey :
                                    ttsProvider === 'kokoro' ? !kokoroUrl :
                                    !googleTtsKey
                                  ) || !selectedVoiceId}
                                  className="px-3 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                  title={!selectedVoiceId ? 'Loading voices...' : ''}
                                >
                                  {voiceoverGenerationLoading[scene.scene_id] ? 'Gen...' : !selectedVoiceId ? '⏳' : 'Generate'}
                                </button>
                              </div>
                              
                              {/* Audio Display */}
                              <div className="bg-gray-800/50 rounded-lg p-4 mb-3">
                                {storyboardVoiceovers[scene.scene_id] ? (
                                  <div>
                                    <audio 
                                      controls 
                                      src={storyboardVoiceovers[scene.scene_id]}
                                      className="w-full mb-2"
                                      style={{ height: '32px' }}
                                      onLoadedMetadata={(e) => {
                                        const duration = (e.target as HTMLAudioElement).duration;
                                        setVoiceoverDurations(prev => ({ ...prev, [scene.scene_id]: duration }));
                                      }}
                                    />
                                    <div className="flex justify-between">
                                      <p className="text-xs text-gray-400">
                                        Voice: {storyboardVoiceovers[scene.scene_id].startsWith('blob:') ? 'Uploaded' : (ttsProvider === 'elevenlabs' ? 'ElevenLabs' : ttsProvider === 'kokoro' ? 'Kokoro TTS' : 'Google TTS')}
                                      </p>
                                      {voiceoverDurations[scene.scene_id] && (
                                        <p className="text-xs text-gray-400">
                                          {voiceoverDurations[scene.scene_id].toFixed(1)}s
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                ) : voiceoverGenerationLoading[scene.scene_id] ? (
                                  <div className="text-gray-400 text-center">
                                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto mb-2"></div>
                                    <p className="text-xs">Generating...</p>
                                  </div>
                                ) : (
                                  <div className="text-gray-500 text-center">
                                    <div className="text-xl mb-2">🎤</div>
                                    <p className="text-xs">Click Generate for voiceover</p>
                                    <p className="text-xs mt-1 text-gray-600">
                                      {ttsProvider === 'elevenlabs' ? 'ElevenLabs' : 'Google TTS'}
                                    </p>
                                    <label className="block mt-2">
                                      <span className="px-2 py-1 text-xs bg-gray-700 text-gray-300 rounded cursor-pointer hover:bg-gray-600">
                                        Or Upload Audio
                                      </span>
                                      <input
                                        type="file"
                                        accept="audio/*"
                                        className="hidden"
                                        onChange={(e) => {
                                          const file = e.target.files?.[0];
                                          if (file) {
                                            const url = URL.createObjectURL(file);
                                            setStoryboardVoiceovers(prev => ({ ...prev, [scene.scene_id]: url }));
                                          }
                                        }}
                                      />
                                    </label>
                                  </div>
                                )}
                              </div>
                              
                              {/* Voice Text Preview */}
                              <div className="text-xs">
                                <label className="text-gray-500 block mb-1">Voice Text:</label>
                                <p className="text-gray-300 bg-gray-800/50 p-2 rounded text-xs leading-relaxed">
                                  &ldquo;{scene.vo_text}&rdquo;
                                </p>
                                <div className="flex justify-between mt-1 text-gray-500">
                                  <span>Emphasis: {scene.vo_emphasis}</span>
                                  <span>Speed: {scene.read_speed_wps} wps</span>
                                </div>
                              </div>
                            </div>

                            {/* Image Generation Panels - Multiple based on audio duration */}
                            {(() => {
                              const numColumns = calculateImageColumns(voiceoverDurations[scene.scene_id]);
                              const columnWidth = numColumns === 1 ? 'w-1/4' : numColumns === 2 ? 'w-1/2' : 'w-3/4';
                              
                              return (
                                <div className={`${columnWidth} p-4`}>
                                  <div className="mb-2">
                                    <label className="text-xs text-gray-500 block mb-2">
                                      Generated Images ({numColumns} {numColumns === 1 ? 'image' : 'images'})
                                      {voiceoverDurations[scene.scene_id] && (
                                        <span className="text-gray-600"> • {voiceoverDurations[scene.scene_id].toFixed(1)}s audio</span>
                                      )}
                                    </label>
                                  </div>
                                  
                                  {/* Multiple Image Columns */}
                                  <div className={`grid gap-2 ${numColumns === 1 ? 'grid-cols-1' : numColumns === 2 ? 'grid-cols-2' : numColumns === 3 ? 'grid-cols-3' : 'grid-cols-4'}`}>
                                    {Array.from({ length: numColumns }, (_, colIndex) => (
                                      <div key={colIndex} className={`bg-gray-800/50 rounded-lg flex items-center justify-center overflow-hidden ${
                                        scene.visual_prompt.aspect_ratio === '9:16' ? 'aspect-[9/16]' :
                                        scene.visual_prompt.aspect_ratio === '16:9' ? 'aspect-[16/9]' :
                                        'aspect-square'
                                      }`}>
                                        {/* Individual image content for each column */}
                                        {storyboardImages[`${scene.scene_id}_${colIndex}`] || (colIndex === 0 && storyboardImages[scene.scene_id]) ? (
                                          (() => {
                                            const imageUrl = storyboardImages[`${scene.scene_id}_${colIndex}`] || storyboardImages[scene.scene_id];
                                            return (isVideoFile(imageUrl) || uploadedFileTypes[scene.scene_id] === 'video') ? (
                                              <video
                                                src={imageUrl}
                                                className="w-full h-full object-cover"
                                                controls
                                                loop
                                                muted
                                              />
                                            ) : (
                                              <img 
                                                src={imageUrl} 
                                                alt={`Scene ${scene.scene_id} - ${colIndex + 1}`}
                                                className="w-full h-full object-cover"
                                              />
                                            );
                                          })()
                                        ) : imageGenerationLoading[`${scene.scene_id}_${colIndex}`] ? (
                                          <div className="text-gray-400 text-center p-2">
                                            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-purple-600 mx-auto mb-1"></div>
                                            <p className="text-xs">Gen...</p>
                                          </div>
                                        ) : (
                                          <div className="text-gray-500 text-center p-2">
                                            <div className="text-lg mb-1">🖼️</div>
                                            <p className="text-xs">Image {colIndex + 1}</p>
                                            <p className="text-xs text-gray-600 mt-1">
                                              {Math.round(colIndex * 2)}-{Math.round((colIndex + 1) * 2)}s
                                            </p>
                                            <button
                                              onClick={() => generateStoryboardImageColumn(scene, colIndex)}
                                              disabled={imageGenerationLoading[`${scene.scene_id}_${colIndex}`] || (imageProvider === 'openrouter' ? !apiKey : imageProvider === 'gemini' ? !googleTtsKey : !highbidApiUrl)}
                                              className="px-2 py-1 mt-2 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                              Generate
                                            </button>
                                            <label className="block mt-1">
                                              <span className="px-1 py-1 text-xs bg-gray-700 text-gray-300 rounded cursor-pointer hover:bg-gray-600">
                                                Upload
                                              </span>
                                              <input
                                                type="file"
                                                accept="image/*,video/*"
                                                className="hidden"
                                                onChange={(e) => {
                                                  const file = e.target.files?.[0];
                                                  if (file) {
                                                    const url = URL.createObjectURL(file);
                                                    const key = colIndex === 0 ? scene.scene_id : `${scene.scene_id}_${colIndex}`;
                                                    setStoryboardImages(prev => ({ ...prev, [key]: url }));
                                                    const isVideo = file.type.startsWith('video/');
                                                    setUploadedFileTypes(prev => ({ ...prev, [scene.scene_id]: isVideo ? 'video' : 'image' }));
                                                  }
                                                }}
                                              />
                                            </label>
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                  
                                  {/* Flux Prompt Preview */}
                                  <div className="mt-3">
                                    <details className="cursor-pointer">
                                      <summary className="text-xs text-gray-500 hover:text-gray-400">View Flux Prompt</summary>
                                      <div className="mt-2 p-2 bg-gray-800/50 rounded text-xs">
                                        <p className="text-gray-300 mb-2">
                                          <strong>Prompt:</strong> {createFluxPrompt(scene, selectedStory?.visual_style).prompt}
                                        </p>
                                        <p className="text-gray-400">
                                          <strong>Negative:</strong> {createFluxPrompt(scene, selectedStory?.visual_style).negative}
                                        </p>
                                      </div>
                                    </details>
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Export Options */}
                    <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-700">
                      <h4 className="text-lg font-bold text-white mb-4">Export Storyboard</h4>
                      <div className="flex gap-4">
                        <button
                          onClick={() => {
                            const dataStr = JSON.stringify({ story: selectedStory, storyboard: generatedStoryboard }, null, 2);
                            const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
                            const exportFileDefaultName = `storyboard-${selectedStory?.title?.replace(/\s+/g, '-').toLowerCase()}.json`;
                            const linkElement = document.createElement('a');
                            linkElement.setAttribute('href', dataUri);
                            linkElement.setAttribute('download', exportFileDefaultName);
                            linkElement.click();
                          }}
                          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                        >
                          Export as JSON
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Video Rendering Section */}
                {selectedStory && generatedStoryboard.length > 0 && (
                  <div className="bg-gradient-to-r from-purple-900/30 to-pink-900/30 p-6 rounded-xl border border-purple-500/50 mt-6">
                    <div className="text-center">
                      <div className="text-4xl mb-4">🎬</div>
                      <h4 className="text-xl font-bold text-white mb-3">Ready to Create Your Video?</h4>
                      <p className="text-gray-300 mb-4">
                        Combine all scenes, images, and voiceovers into a final video
                      </p>
                      
                      {/* Content Status Summary */}
                      <div className="grid grid-cols-3 gap-4 mb-6 text-sm">
                        <div className="bg-gray-800/50 p-3 rounded-lg">
                          <div className="text-white font-semibold">{generatedStoryboard.length}/{selectedStory?.target_scene_count || 30}</div>
                          <div className="text-gray-400">Scenes</div>
                        </div>
                        <div className="bg-gray-800/50 p-3 rounded-lg">
                          <div className="text-white font-semibold">{Object.keys(storyboardImages).length}/{selectedStory?.target_scene_count || 30}</div>
                          <div className="text-gray-400">Images</div>
                        </div>
                        <div className="bg-gray-800/50 p-3 rounded-lg">
                          <div className="text-white font-semibold">{Object.keys(storyboardVoiceovers).length}/{selectedStory?.target_scene_count || 30}</div>
                          <div className="text-gray-400">Voiceovers</div>
                        </div>
                      </div>
                      
                      <button
                        onClick={handleVideoRender}
                        disabled={renderingVideo || generatedStoryboard.length === 0}
                        className="px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-600 text-white text-lg font-bold rounded-xl hover:from-purple-700 hover:to-pink-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform hover:scale-105"
                      >
                        {renderingVideo ? (
                          <div className="flex items-center">
                            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-3"></div>
                            Creating Video...
                          </div>
                        ) : (
                          '🎬 CREATE FINAL VIDEO'
                        )}
                      </button>
                      
                      {/* Rendering Progress */}
                      {(() => {
                        console.log('🎯 UI Render Check:', { renderingVideo, renderProgressStep: renderProgress.step, shouldShow: renderingVideo && renderProgress.step });
                        return renderingVideo && renderProgress.step;
                      })() && (
                        <div className="mt-4 bg-gray-900/50 p-4 rounded-xl border border-gray-700">
                          <div className="text-white font-semibold mb-2">{renderProgress.step}</div>
                          <div className="w-full bg-gray-800 rounded-full h-2">
                            <div 
                              className="bg-gradient-to-r from-purple-500 to-pink-500 h-2 rounded-full transition-all duration-1000"
                              style={{ width: `${renderProgress.progress}%` }}
                            ></div>
                          </div>
                          <div className="text-sm text-gray-400 mt-2">
                            {renderProgress.progress}% Complete
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

            {/* Final Video Tab */}
            {activeTab === 'final-video' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Final Video Rendering</h3>
                  <p className="text-gray-400 mb-6">Combine your storyboard, images, and voiceovers into a final video</p>
                </div>

                {/* Video Render Section */}
                {finalVideos.length === 0 ? (
                    <div className="bg-gradient-to-r from-purple-900/30 to-pink-900/30 p-8 rounded-xl border-2 border-purple-500/50">
                      <div className="text-center">
                        <div className="text-6xl mb-4">🎬</div>
                        <h3 className="text-3xl font-bold text-white mb-4">Ready to Render Your Video?</h3>
                        <p className="text-gray-300 mb-6 max-w-2xl mx-auto">
                          Combine all your generated content - storyboard, images, and voiceovers - into a professional video ready for social media.
                        </p>
                        
                        {/* Content Status */}
                        <div className="grid grid-cols-3 gap-4 mb-8">
                          <div className="bg-gray-800/50 p-4 rounded-xl">
                            <div className="text-2xl mb-2">📝</div>
                            <div className="text-white font-semibold">Storyboard</div>
                            <div className="text-sm text-gray-400">{generatedStoryboard.length}/{selectedStory?.target_scene_count || 30} scenes</div>
                            <div className={`text-xs mt-1 ${generatedStoryboard.length === (selectedStory?.target_scene_count || 30) ? 'text-green-400' : 'text-yellow-400'}`}>
                              {generatedStoryboard.length === (selectedStory?.target_scene_count || 30) ? '✓ Complete' : '⚠ Incomplete'}
                            </div>
                          </div>
                          
                          <div className="bg-gray-800/50 p-4 rounded-xl">
                            <div className="text-2xl mb-2">🖼️</div>
                            <div className="text-white font-semibold">Images</div>
                            <div className="text-sm text-gray-400">{Object.keys(storyboardImages).length}/{selectedStory?.target_scene_count || 30} images</div>
                            <div className={`text-xs mt-1 ${Object.keys(storyboardImages).length === (selectedStory?.target_scene_count || 30) ? 'text-green-400' : Object.keys(storyboardImages).length > 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                              {Object.keys(storyboardImages).length === (selectedStory?.target_scene_count || 30) ? '✓ Complete' : Object.keys(storyboardImages).length > 0 ? '⚠ Partial' : '✗ Missing'}
                            </div>
                          </div>
                          
                          <div className="bg-gray-800/50 p-4 rounded-xl">
                            <div className="text-2xl mb-2">🎤</div>
                            <div className="text-white font-semibold">Voiceovers</div>
                            <div className="text-sm text-gray-400">{Object.keys(storyboardVoiceovers).length}/{selectedStory?.target_scene_count || 30} audio</div>
                            <div className={`text-xs mt-1 ${Object.keys(storyboardVoiceovers).length === (selectedStory?.target_scene_count || 30) ? 'text-green-400' : Object.keys(storyboardVoiceovers).length > 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                              {Object.keys(storyboardVoiceovers).length === (selectedStory?.target_scene_count || 30) ? '✓ Complete' : Object.keys(storyboardVoiceovers).length > 0 ? '⚠ Partial' : '✗ Missing'}
                            </div>
                          </div>
                        </div>
                        
                        <button
                          onClick={handleVideoRender}
                          disabled={renderingVideo || generatedStoryboard.length === 0}
                          className="px-12 py-4 bg-gradient-to-r from-purple-600 to-pink-600 text-white text-xl font-bold rounded-xl hover:from-purple-700 hover:to-pink-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform hover:scale-105"
                        >
                          {renderingVideo ? (
                            <div className="flex items-center">
                              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white mr-3"></div>
                              Rendering Video...
                            </div>
                          ) : (
                            '🎬 RENDER FINAL VIDEO'
                          )}
                        </button>
                        
                        {/* Rendering Progress */}
                        {renderingVideo && renderProgress.step && (
                          <div className="mt-6 bg-gray-900/50 p-6 rounded-xl border border-gray-700">
                            <div className="text-center mb-4">
                              <div className="text-white font-semibold mb-2">Video Rendering Progress</div>
                              <div className="text-sm text-gray-300 mb-4">{renderProgress.step}</div>
                            </div>
                            
                            {/* Progress Bar */}
                            <div className="w-full bg-gray-800 rounded-full h-3 mb-2">
                              <div 
                                className="bg-gradient-to-r from-purple-500 to-pink-500 h-3 rounded-full transition-all duration-1000"
                                style={{ width: `${renderProgress.progress}%` }}
                              ></div>
                            </div>
                            <div className="text-center text-sm text-gray-400">
                              {renderProgress.progress}% Complete
                            </div>
                          </div>
                        )}
                        
                        {generatedStoryboard.length === 0 && (
                          <p className="text-yellow-400 text-sm mt-4">
                            ⚠️ Generate a storyboard first to enable video rendering
                          </p>
                        )}
                      </div>
                    </div>
                ) : (
                  <div className="text-center py-16">
                    <div className="text-6xl mb-4">✅</div>
                    <h3 className="text-2xl font-bold text-white mb-4">Video Rendered Successfully!</h3>
                    <p className="text-gray-400 mb-6">Your video has been created. Go to the Final Video tab to view and export it.</p>
                    <button
                      onClick={() => setActiveTab('effects')}
                      className="px-6 py-3 bg-green-600 text-white rounded-xl hover:bg-green-700 transition"
                    >
                      View Final Video
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'voiceovers' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Batch Voice-over Generation</h3>
                  <p className="text-gray-400 mb-6">Convert your scripts to professional audio narration</p>
                </div>

                {/* TTS Provider Selection */}
                <div className="bg-gray-900/50 p-4 rounded-xl">
                  <label className="block text-white text-sm font-semibold mb-3">
                    TTS Provider
                  </label>
                  <div className="flex gap-4 mb-4">
                    <button
                      onClick={() => {
                        setTtsProvider('elevenlabs');
                        setVoicesLoaded(false);
                        setGoogleVoicesLoaded(false);
                        setAvailableVoices([]);
                        setSelectedVoiceId('21m00Tcm4TlvDq8ikWAM');
                      }}
                      className={`px-4 py-2 rounded-xl transition ${
                        ttsProvider === 'elevenlabs'
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      ElevenLabs
                    </button>
                    <button
                      onClick={() => {
                        setTtsProvider('google');
                        setVoicesLoaded(false);
                        setGoogleVoicesLoaded(false);
                        setAvailableVoices([]);
                        setSelectedVoiceId('Kore');
                      }}
                      className={`px-4 py-2 rounded-xl transition ${
                        ttsProvider === 'google'
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      Google Gemini TTS
                    </button>
                    <button
                      onClick={() => {
                        setTtsProvider('kokoro');
                        setVoicesLoaded(false);
                        setGoogleVoicesLoaded(false);
                        setAvailableVoices([]);
                        setSelectedVoiceId('af_heart');
                      }}
                      className={`px-4 py-2 rounded-xl transition ${
                        ttsProvider === 'kokoro'
                          ? 'bg-purple-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      Kokoro TTS
                    </button>
                  </div>
                </div>

                {/* Voice Selection */}
                <div className="bg-gray-900/50 p-4 rounded-xl">
                  <label className="block text-white text-sm font-semibold mb-3">
                    Select Voice {ttsProvider === 'google' && '(Google Gemini)'} {ttsProvider === 'kokoro' && '(Kokoro TTS)'}
                  </label>
                  <div className="flex gap-4 items-center">
                    <select
                      value={selectedVoiceId}
                      onChange={(e) => setSelectedVoiceId(e.target.value)}
                      onFocus={() => loadVoices(ttsProvider)}
                      className="flex-1 px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    >
                      {ttsProvider === 'elevenlabs' ? (
                        <>
                          <option value="21m00Tcm4TlvDq8ikWAM">Rachel - Young Female (Default)</option>
                          {availableVoices.map((voice) => (
                            voice.voice_id !== '21m00Tcm4TlvDq8ikWAM' && (
                              <option key={voice.voice_id} value={voice.voice_id}>
                                {voice.name} - {voice.labels?.gender || 'Unknown'} {voice.labels?.age || ''}
                              </option>
                            )
                          ))}
                        </>
                      ) : ttsProvider === 'kokoro' ? (
                        <>
                          <option value="af_heart">Heart - Young Female (Default)</option>
                          <option value="af_alloy">Alloy - Female</option>
                          <option value="af_ember">Ember - Female</option>
                          <option value="am_adam">Adam - Male</option>
                          <option value="bf_emma">Emma - British Female</option>
                          <option value="bf_sarah">Sarah - British Female</option>
                          <option value="bm_george">George - British Male</option>
                        </>
                      ) : (
                        <>
                          <option value="Kore">Kore - Firm, reliable (Default)</option>
                          {availableVoices.map((voice) => (
                            voice.voice_id !== 'Kore' && (
                              <option key={voice.voice_id} value={voice.voice_id}>
                                {voice.name} - {voice.labels?.style || 'Natural'} ({voice.labels?.type || 'Standard'})
                              </option>
                            )
                          ))}
                        </>
                      )}
                    </select>
                    {selectedVoiceId && availableVoices.length > 0 && (
                      <div className="text-sm text-gray-400">
                        {availableVoices.find(v => v.voice_id === selectedVoiceId)?.description || 'Default voice'}
                      </div>
                    )}
                  </div>
                  {ttsProvider === 'google' && !googleTtsKey && (
                    <div className="mt-3 text-yellow-400 text-sm">
                      Please enter your Google Gemini TTS API key above to load voices
                    </div>
                  )}
                  {ttsProvider === 'elevenlabs' && !elevenLabsKey && (
                    <div className="mt-3 text-yellow-400 text-sm">
                      Please enter your ElevenLabs API key above to load voices
                    </div>
                  )}
                </div>

                {/* Text Input */}
                <div className="space-y-4">
                  {voiceoverTexts.map((text, index) => (
                    <div key={index} className="flex gap-3">
                      <textarea
                        value={text}
                        onChange={(e) => updatePrompt('voiceover', index, e.target.value)}
                        placeholder={`Voice-over text ${index + 1}...`}
                        rows={4}
                        className="flex-1 px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition resize-none"
                      />
                      <button
                        onClick={() => removePrompt('voiceover', index)}
                        disabled={voiceoverTexts.length === 1}
                        className="px-4 py-2 bg-red-600/20 text-red-400 rounded-xl hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={() => addPrompt('voiceover')}
                    className="px-6 py-3 bg-gray-700 text-white rounded-xl hover:bg-gray-600 transition"
                  >
                    + Add Voice-over Text
                  </button>
                  <button
                    onClick={handleVoiceoverGeneration}
                    disabled={voiceoversLoading || (
                      ttsProvider === 'elevenlabs' ? !elevenLabsKey :
                      ttsProvider === 'kokoro' ? !kokoroUrl :
                      !googleTtsKey
                    )}
                    className="px-8 py-3 bg-gradient-to-r from-blue-500 to-purple-600 text-white font-semibold rounded-xl hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {voiceoversLoading ? `Generating with ${
                      ttsProvider === 'elevenlabs' ? 'ElevenLabs' :
                      ttsProvider === 'kokoro' ? 'Kokoro TTS' :
                      'Google TTS'
                    }...` : `Generate with ${
                      ttsProvider === 'elevenlabs' ? 'ElevenLabs' :
                      ttsProvider === 'kokoro' ? 'Kokoro TTS' :
                      'Google TTS'
                    }`}
                  </button>
                </div>

                {/* Generated Audio */}
                {generatedVoiceovers.length > 0 && (
                  <div className="space-y-4">
                    <h4 className="text-xl font-bold text-white">Generated Voice-overs</h4>
                    <div className="grid gap-4">
                      {generatedVoiceovers.map((voiceover, index) => (
                        <div key={index} className="bg-gray-900/50 p-4 rounded-xl">
                          <div className="mb-3">
                            <div className="flex justify-between items-start mb-2">
                              <h5 className="text-lg font-semibold text-white">Voice-over {index + 1}</h5>
                              {voiceover.provider && (
                                <span className={`px-2 py-1 text-xs rounded-full ${
                                  voiceover.provider === 'google-gemini' ? 'bg-green-600/20 text-green-400' : 'bg-blue-600/20 text-blue-400'
                                }`}>
                                  {voiceover.provider === 'google-gemini' ? 'Google TTS' : 'ElevenLabs'}
                                </span>
                              )}
                            </div>
                            <p className="text-gray-400 text-sm mb-3">{voiceover.text}</p>
                          </div>
                          <audio 
                            controls 
                            className="w-full mb-3"
                            src={voiceover.audio}
                          >
                            Your browser does not support the audio element.
                          </audio>
                          <button
                            onClick={() => {
                              const link = document.createElement('a');
                              link.href = voiceover.audio;
                              link.download = `voiceover-${index + 1}.mp3`;
                              link.click();
                            }}
                            className="w-full py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-xl transition"
                          >
                            Download Audio
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'effects' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Final Video</h3>
                  <p className="text-gray-400 mb-6">Your rendered video combining all generated content</p>
                </div>

                {finalVideos.length === 0 ? (
                  <div className="text-center py-16">
                    <div className="text-6xl mb-4">🎬</div>
                    <h3 className="text-2xl font-bold text-white mb-4">No Video Rendered Yet</h3>
                    <p className="text-gray-400 mb-6">Go to the Storyboard tab and click &quot;RENDER FINAL VIDEO&quot; to create your video</p>
                    <button
                      onClick={() => setActiveTab('storyboard')}
                      className="px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition"
                    >
                      Go to Storyboard Tab
                    </button>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* Video Preview Section */}
                    <div className="bg-gray-900/50 p-8 rounded-xl border border-gray-700">
                      <div className="text-center mb-6">
                        <h4 className="text-xl font-bold text-white mb-2">Rendered Video Preview</h4>
                        <p className="text-gray-400">60-second vertical video optimized for social media</p>
                      </div>
                      
                      {/* Video Player */}
                      <div className="max-w-sm mx-auto">
                        <video
                          src={finalVideos[0]}
                          className="w-full rounded-xl"
                          controls
                          loop
                          playsInline
                          onLoadStart={() => console.log('📹 Video load started:', finalVideos[0]?.substring(0, 100))}
                          onLoadedMetadata={() => console.log('✅ Video metadata loaded')}
                          onLoadedData={() => console.log('✅ Video data loaded')}
                          onCanPlay={() => console.log('✅ Video can play')}
                          onError={(e) => {
                            console.error('❌ Video element error:', e);
                            console.error('❌ Video src:', finalVideos[0]?.substring(0, 100));
                            console.error('❌ Video error details:', (e.target as HTMLVideoElement).error);
                          }}
                        />
                      </div>
                    </div>

                    {/* Video Stats */}
                    <div className="grid grid-cols-4 gap-4">
                      <div className="bg-gray-900/50 p-4 rounded-xl text-center">
                        <div className="text-2xl mb-2">⏱️</div>
                        <div className="text-white font-semibold">{generatedStoryboard.length * 2}s</div>
                        <div className="text-xs text-gray-400">Duration</div>
                      </div>
                      <div className="bg-gray-900/50 p-4 rounded-xl text-center">
                        <div className="text-2xl mb-2">📐</div>
                        <div className="text-white font-semibold">9:16</div>
                        <div className="text-xs text-gray-400">Aspect Ratio</div>
                      </div>
                      <div className="bg-gray-900/50 p-4 rounded-xl text-center">
                        <div className="text-2xl mb-2">🎞️</div>
                        <div className="text-white font-semibold">{generatedStoryboard.length}</div>
                        <div className="text-xs text-gray-400">Scenes</div>
                      </div>
                      <div className="bg-gray-900/50 p-4 rounded-xl text-center">
                        <div className="text-2xl mb-2">🎨</div>
                        <div className="text-white font-semibold">{selectedStory?.visual_style}</div>
                        <div className="text-xs text-gray-400">Style</div>
                      </div>
                    </div>

                    {/* Content Summary */}
                    <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-700">
                      <h4 className="text-lg font-bold text-white mb-4">Video Content Summary</h4>
                      <div className="grid grid-cols-3 gap-6">
                        <div>
                          <div className="text-sm text-gray-400 mb-2">Images Generated</div>
                          <div className="text-white font-semibold">{Object.keys(storyboardImages).length}/{selectedStory?.target_scene_count || 30}</div>
                          <div className="w-full bg-gray-800 rounded-full h-2 mt-2">
                            <div 
                              className="bg-green-500 h-2 rounded-full transition-all"
                              style={{ width: `${(Object.keys(storyboardImages).length / (selectedStory?.target_scene_count || 30)) * 100}%` }}
                            ></div>
                          </div>
                        </div>
                        <div>
                          <div className="text-sm text-gray-400 mb-2">Voiceovers Generated</div>
                          <div className="text-white font-semibold">{Object.keys(storyboardVoiceovers).length}/{selectedStory?.target_scene_count || 30}</div>
                          <div className="w-full bg-gray-800 rounded-full h-2 mt-2">
                            <div 
                              className="bg-blue-500 h-2 rounded-full transition-all"
                              style={{ width: `${(Object.keys(storyboardVoiceovers).length / (selectedStory?.target_scene_count || 30)) * 100}%` }}
                            ></div>
                          </div>
                        </div>
                        <div>
                          <div className="text-sm text-gray-400 mb-2">Story Completion</div>
                          <div className="text-white font-semibold">{Math.round(((Object.keys(storyboardImages).length + Object.keys(storyboardVoiceovers).length) / 60) * 100)}%</div>
                          <div className="w-full bg-gray-800 rounded-full h-2 mt-2">
                            <div 
                              className="bg-purple-500 h-2 rounded-full transition-all"
                              style={{ width: `${((Object.keys(storyboardImages).length + Object.keys(storyboardVoiceovers).length) / 60) * 100}%` }}
                            ></div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Export Options */}
                    <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-700">
                      <h4 className="text-lg font-bold text-white mb-4">Export & Share</h4>
                      <div className="flex gap-4">
                        <button
                          onClick={() => {
                            if (finalVideos.length > 0) {
                              console.log('📥 Downloading video for mobile...');
                              const videoUrl = finalVideos[0];
                              const exportFileDefaultName = `${selectedStory?.title?.replace(/\s+/g, '-').toLowerCase() || 'video'}-mobile.mp4`;
                              const linkElement = document.createElement('a');
                              linkElement.setAttribute('href', videoUrl);
                              linkElement.setAttribute('download', exportFileDefaultName);
                              linkElement.click();
                              console.log('✅ Download initiated:', exportFileDefaultName);
                            }
                          }}
                          className="px-6 py-3 bg-green-600 text-white rounded-xl hover:bg-green-700 transition"
                        >
                          📱 Download Video
                        </button>
                        <button
                          onClick={() => {
                            if (finalVideos.length > 0) {
                              console.log('📋 Copying video URL to clipboard...');
                              navigator.clipboard.writeText(finalVideos[0]).then(() => {
                                alert('Video URL copied to clipboard!');
                                console.log('✅ Video URL copied to clipboard');
                              }).catch((err) => {
                                console.error('❌ Failed to copy to clipboard:', err);
                                alert('Failed to copy to clipboard');
                              });
                            }
                          }}
                          className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition"
                        >
                          📋 Copy Video URL
                        </button>
                        <button
                          onClick={() => {
                            if (finalVideos.length > 0) {
                              console.log('📤 Sharing project metadata...');
                              const shareData = {
                                title: selectedStory?.title,
                                premise: selectedStory?.premise,
                                duration: `${generatedStoryboard.length * 2}s`,
                                scenes: generatedStoryboard.length,
                                style: selectedStory?.visual_style,
                                timestamp: new Date().toISOString()
                              };
                              navigator.clipboard.writeText(JSON.stringify(shareData, null, 2)).then(() => {
                                alert('Project metadata copied to clipboard!');
                                console.log('✅ Project metadata copied');
                              }).catch((err) => {
                                console.error('❌ Failed to copy metadata:', err);
                                const dataStr = JSON.stringify(shareData, null, 2);
                                const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
                                const exportFileDefaultName = `${selectedStory?.title?.replace(/\s+/g, '-').toLowerCase() || 'video'}-metadata.json`;
                                const linkElement = document.createElement('a');
                                linkElement.setAttribute('href', dataUri);
                                linkElement.setAttribute('download', exportFileDefaultName);
                                linkElement.click();
                              });
                            }
                          }}
                          className="px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition"
                        >
                          🔗 Generate Share Link
                        </button>
                      </div>
                    </div>

                    {/* Re-render Button */}
                    <div className="text-center pt-6 border-t border-gray-700">
                      <button
                        onClick={() => setActiveTab('storyboard')}
                        className="px-8 py-3 bg-gray-700 text-white rounded-xl hover:bg-gray-600 transition"
                      >
                        ← Back to Storyboard to Re-render
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Prompt Inspection Modals */}
            {showStoryBulbPrompt && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                <div className="bg-gray-900 rounded-xl border border-gray-700 max-w-4xl w-full max-h-[80vh] overflow-hidden">
                  <div className="p-6 border-b border-gray-700 flex justify-between items-center">
                    <h3 className="text-xl font-bold text-white">📄 Story Bulb Generation Prompt</h3>
                    <button
                      onClick={() => setShowStoryBulbPrompt(false)}
                      className="text-gray-400 hover:text-white transition"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="p-6 overflow-y-auto max-h-[60vh]">
                    <div className="bg-gray-800/50 rounded-lg p-4 font-mono text-sm">
                      <pre className="text-gray-300 whitespace-pre-wrap">{`SYSTEM:
You are a story generator. 
You must output valid JSON only, with no explanations, no prose, no comments.

The JSON object must have the following keys:
{
  "title": string,
  "runtime_sec": 60,
  "tone": one of ["inspiring","dramatic","cozy","creepy","comedic","educational"],
  "narration_pov": one of ["first_person","third_person"],
  "target_viewer": string,
  "premise": string (≤22 words),
  "protagonist": string,
  "goal": string,
  "stakes": string,
  "setting": string,
  "constraint": string,
  "twist": string (≤22 words),
  "call_to_action": string or "",
  "visual_style": string (free-form description),
  "action_emphasis": string (guidance for creating action-packed scenes),
  "domino_sequences": array of 3-5 cause-effect chains,
  "setups_payoffs": array of setup/payoff pairs,
  "escalation_points": array of 3 moments where stakes increase,
  "plot_threads": object with three acts and their turning points
}

RULES:
- All values must be single-line strings (no line breaks).
- runtime_sec is always 60 unless explicitly told otherwise.
- Keep premise and twist short, max 22 words.
- visual_style can be any creative description (e.g., "cinematic photoreal", "anime style", "oil painting")
- CRITICAL: Focus on ACTION-DRIVEN narratives. Avoid passive observation.
- Every story element should lead to dynamic, visual scenes with conflict/movement.
- action_emphasis should guide how each scene will show action, not passive states.
- Examples of good action_emphasis: "constant movement and revelations", "each scene shows character making discoveries", "fast-paced confrontations and escapes".
- Do not output anything except the JSON object.

USER:
Generate a Story Bulb JSON for this viral title: "<TITLE>"`}</pre>
                    </div>
                    <div className="mt-4 text-sm text-gray-400">
                      <p><strong>Note:</strong> The &lt;TITLE&gt; placeholder gets replaced with your actual title when sent to the AI model.</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {showStoryboardPrompt && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                <div className="bg-gray-900 rounded-xl border border-gray-700 max-w-4xl w-full max-h-[80vh] overflow-hidden">
                  <div className="p-6 border-b border-gray-700 flex justify-between items-center">
                    <h3 className="text-xl font-bold text-white">🎬 Storyboard Generation Prompt</h3>
                    <button
                      onClick={() => setShowStoryboardPrompt(false)}
                      className="text-gray-400 hover:text-white transition"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="p-6 overflow-y-auto max-h-[60vh]">
                    <div className="bg-gray-800/50 rounded-lg p-4 font-mono text-sm">
                      <pre className="text-gray-300 whitespace-pre-wrap">{`SYSTEM:
You are a storyboard generator.
You must output exactly 30 lines of JSON (JSONL format). 
Each line must be a valid JSON object conforming to the schema below.
No prose, no explanations, no comments.

REQUIRED FIELDS:
{
  "scene_id": int (1..30),
  "start_ms": int (2000*(scene_id-1)),
  "end_ms": int (start_ms+2000),
  "beat": one of ["hook","setup","inciting","rise","midpoint","complication","climax","resolution","cta"],
  "vo_text": string (≤7 words, no line breaks, action-focused),
  "scene_twist": string (the specific action/conflict/revelation in this scene),
  "caused_by": string (what previous event directly triggers THIS scene),
  "leads_to": string (what immediate consequence this scene creates),
  "callback_to": string (reference to earlier setup if payoff, or "none"),
  "vo_emphasis": one of ["none","slight","strong"],
  "read_speed_wps": float between 1.8 and 3.2,
  "visual_prompt": {
    "setting": string,
    "characters": string,
    "action": string,
    "props": string,
    "mood": string,
    "lighting": one of ["soft","hard","noir","neon","golden_hour","overcast","practical"],
    "color_palette": one of ["warm","cool","monochrome","teal_orange","pastel"],
    "camera": string,
    "composition": one of ["rule_of_thirds","center","symmetry","leading_lines"],
    "aspect_ratio": "9:16",
    "style_tags": string,
    "negative_tags": "blurry, extra fingers, watermark",
    "model_hint": one of ["sdxl","flux","juggernaut","midjourney","dalle","kling"],
    "seed": int
  },
  "text_overlay": {
    "content": string,
    "position": one of ["top","center","bottom","caption"],
    "weight": one of ["none","subtle","bold"]
  },
  "transition_in": one of ["cut","fade","dolly_in","whip"],
  "transition_out": one of ["cut","fade","dolly_out","whip"],
  "music_cue": one of ["low","medium","high","drop","silence"]
}

RULES:
- Output 30 lines, one JSON object per line, no extra text.
- Each scene covers 2000 ms (2 seconds).
- CRITICAL: vo_text must be ≤7 words maximum to fit 2-second timing.
- CRITICAL: Every scene must be a DIRECT CONSEQUENCE of previous events.
- CRITICAL: Use "therefore/but/however" logic between ALL scenes.
- caused_by must reference SPECIFIC actions from previous scenes
- leads_to must create concrete problems that next scene MUST address
- callback_to should reference earlier setups when paying them off
- Each scene_twist must be CAUSED BY previous actions, not random
- Example: Scene 3 hero action → Scene 4 enemy reaction → Scene 5 consequence
- Avoid generic actions: specify WHO does WHAT causing WHAT
- Ensure final scene (#30) has beat="cta" if a call_to_action exists.

USER:
Here is the Story Bulb JSON:
<PASTE STORY BULB JSON HERE>

Expand this into a 30-scene storyboard in JSONL format.`}</pre>
                    </div>
                    <div className="mt-4 text-sm text-gray-400">
                      <p><strong>Note:</strong> The &lt;PASTE STORY BULB JSON HERE&gt; placeholder gets replaced with the actual story bulb JSON when sent to the AI model.</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'pages' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-bold text-white mb-2">5. Page Template Overrides</h2>
                  <p className="text-gray-400">
                    Switch frame templates for individual pages and recompose only the affected page.
                  </p>
                </div>

                {/* For now, show a placeholder that demonstrates the concept */}
                <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-700">
                  <div className="text-center text-gray-400">
                    <p className="mb-4">🚧 Page Override Controls</p>
                    <p className="text-sm">
                      This feature allows you to override the frame template for individual storyboard pages.<br />
                      Once you have storyboard composition results, you&apos;ll be able to:
                    </p>
                    <ul className="text-left mt-4 space-y-2 max-w-md mx-auto">
                      <li>• Switch any page to a different frame template with the same panel count</li>
                      <li>• Preview alternative layouts for each page</li>
                      <li>• Apply/remove overrides with real-time recomposition</li>
                      <li>• See which pages have custom overrides applied</li>
                    </ul>
                    <p className="text-xs mt-4 text-gray-500">
                      Complete the storyboard composition in step 2 to enable this feature.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'settings' && (
              <SettingsTab />
            )}

            {/* Global Error Display */}
            {error && (
              <div className="mt-6 bg-red-900/20 border border-red-500 text-red-400 px-4 py-3 rounded-xl">
                <p className="text-sm">{error}</p>
              </div>
            )}
            </div>
          </div>
          )}
        </div>
      </div>
  );
}
