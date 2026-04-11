'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import FeedViewer, { FeedChannel, FeedFilters, DEFAULT_FEED_FILTERS } from '@/components/FeedViewer';

export default function FeedPage() {
  const { data: session } = useSession();

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

  // Fetch channels with nested videos
  const feedAbortRef = useRef<AbortController | null>(null);
  const fetchFeedData = useCallback(async () => {
    if (feedAbortRef.current) feedAbortRef.current.abort();
    const controller = new AbortController();
    feedAbortRef.current = controller;
    setFeedLoading(true);
    try {
      const response = await fetch(`/api/feed-spy/feed?${buildFeedParams(0)}`, { signal: controller.signal });
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
            const existingIds = new Set(ch.videos.map((v) => v.video_id));
            const newVideos = data.videos.filter((v: { video_id: string }) => !existingIds.has(v.video_id));
            if (newVideos.length === 0) return ch;
            return { ...ch, channel_id: resolved, videos: [...ch.videos, ...newVideos] };
          })
        );
      }
    } catch (err) {
      console.error('Error fetching channel videos:', err);
    }
  }, []);

  // Mark a channel as seen
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
    fetchFeedData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedFiltersKey, sessionUserId]);

  return (
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
  );
}
