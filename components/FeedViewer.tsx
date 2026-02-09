'use client';

import React, { useRef, useCallback, useEffect, useState } from 'react';

export interface FeedVideo {
  video_id: string;
  title: string | null;
  duration_seconds: number;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  upload_date: string | null;
}

export interface FeedChannel {
  channel_id: string;
  channel_name: string;
  channel_url: string;
  avatar_url: string | null;
  subscriber_count: string | null;
  total_video_count: string | null;
  channel_creation_date: string | null;
  first_seen_at: string;
  sighting_count: number;
  videos: FeedVideo[];
}

interface FeedViewerProps {
  channels: FeedChannel[];
  loading: boolean;
  channelIndex: number;
  videoIndex: number;
  onChannelChange: (index: number) => void;
  onVideoChange: (index: number) => void;
  onLoadMore: () => void;
}

function formatCount(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

function channelAge(dateStr: string | null): string {
  if (!dateStr) return '';
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d old`;
  if (days < 365) return `${Math.floor(days / 30)}mo old`;
  return `${(days / 365).toFixed(1)}y old`;
}

export default function FeedViewer({
  channels,
  loading,
  channelIndex,
  videoIndex,
  onChannelChange,
  onVideoChange,
  onLoadMore,
}: FeedViewerProps) {
  const touchRef = useRef<{ startX: number; startY: number; startTime: number } | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [muted, setMuted] = useState(true);

  const channel = channels[channelIndex];
  const video = channel?.videos?.[videoIndex];

  // Trigger load more when approaching end
  useEffect(() => {
    if (channels.length > 0 && channelIndex >= channels.length - 5) {
      onLoadMore();
    }
  }, [channelIndex, channels.length, onLoadMore]);

  // Reset iframe loaded state on video change
  useEffect(() => {
    setIframeLoaded(false);
  }, [channelIndex, videoIndex]);

  const navigate = useCallback(
    (dir: 'up' | 'down' | 'left' | 'right') => {
      if (transitioning || !channel) return;
      setTransitioning(true);
      setTimeout(() => setTransitioning(false), 150);

      if (dir === 'up' && channelIndex < channels.length - 1) {
        onChannelChange(channelIndex + 1);
        onVideoChange(0);
      } else if (dir === 'down' && channelIndex > 0) {
        onChannelChange(channelIndex - 1);
        onVideoChange(0);
      } else if (dir === 'left' && channel.videos.length > 1) {
        onVideoChange((videoIndex + 1) % channel.videos.length);
      } else if (dir === 'right' && channel.videos.length > 1) {
        onVideoChange((videoIndex - 1 + channel.videos.length) % channel.videos.length);
      }
    },
    [transitioning, channel, channelIndex, channels.length, videoIndex, onChannelChange, onVideoChange]
  );

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); navigate('down'); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); navigate('up'); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); navigate('right'); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navigate('left'); }
      else if (e.key === 'm') { setMuted((m) => !m); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    touchRef.current = { startX: t.clientX, startY: t.clientY, startTime: Date.now() };
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!touchRef.current) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchRef.current.startX;
      const dy = t.clientY - touchRef.current.startY;
      const dt = Date.now() - touchRef.current.startTime;
      touchRef.current = null;

      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const minDist = 50;
      const maxTime = 500;

      if (dt > maxTime) return;

      if (absDy > absDx && absDy > minDist) {
        navigate(dy < 0 ? 'up' : 'down');
      } else if (absDx > absDy && absDx > minDist) {
        navigate(dx < 0 ? 'left' : 'right');
      }
    },
    [navigate]
  );

  // Loading state
  if (loading && channels.length === 0) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-40">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-pink-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-white text-lg">Loading Shorts Feed...</p>
        </div>
      </div>
    );
  }

  // Empty state
  if (!channel || !video) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-40">
        <div className="text-center">
          <p className="text-gray-400 text-lg">No shorts data available</p>
          <p className="text-gray-500 text-sm mt-2">Run a Feed Spy sync first</p>
        </div>
      </div>
    );
  }

  const embedUrl = `https://www.youtube.com/embed/${video.video_id}?autoplay=1&loop=1&controls=0&playsinline=1&rel=0&mute=${muted ? 1 : 0}&playlist=${video.video_id}`;
  const age = channelAge(channel.channel_creation_date);

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center z-40">
      {/* Channel counter */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50">
        <span className="bg-black/60 backdrop-blur-sm text-white text-sm px-3 py-1.5 rounded-full shadow-text">
          channel {channelIndex + 1}/{channels.length}
        </span>
      </div>

      {/* Mute toggle */}
      <button
        onClick={() => setMuted((m) => !m)}
        className="absolute top-4 right-4 z-50 w-10 h-10 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center text-white hover:bg-black/80 transition"
        title={muted ? 'Unmute (M)' : 'Mute (M)'}
      >
        {muted ? (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
          </svg>
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          </svg>
        )}
      </button>

      {/* Video container — 9:16 aspect */}
      <div
        className="relative w-full h-full max-w-[calc(100vh*9/16)] mx-auto"
        style={{ transition: 'opacity 150ms ease', opacity: transitioning ? 0 : 1 }}
      >
        {/* Background placeholder while loading */}
        {!iframeLoaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900 z-10">
            {channel.avatar_url && (
              <img
                src={channel.avatar_url}
                alt=""
                className="w-20 h-20 rounded-full mb-4 animate-pulse"
              />
            )}
            <p className="text-gray-400 animate-pulse">{channel.channel_name}</p>
            <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin mt-4" />
          </div>
        )}

        {/* YouTube embed */}
        <iframe
          key={`${video.video_id}-${muted}`}
          src={embedUrl}
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: 'none' }}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          onLoad={() => setIframeLoaded(true)}
        />

        {/* Touch overlay */}
        <div
          className="absolute inset-0 z-20"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        />

        {/* Stats overlay — right side (TikTok style) */}
        <div className="absolute right-3 bottom-32 z-30 flex flex-col items-center gap-5">
          {/* Views */}
          <div className="flex flex-col items-center">
            <div className="w-10 h-10 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
            <span className="text-white text-xs mt-1 shadow-text">{formatCount(video.view_count)}</span>
          </div>

          {/* Likes */}
          <div className="flex flex-col items-center">
            <div className="w-10 h-10 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
              </svg>
            </div>
            <span className="text-white text-xs mt-1 shadow-text">{formatCount(video.like_count)}</span>
          </div>

          {/* Comments */}
          <div className="flex flex-col items-center">
            <div className="w-10 h-10 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <span className="text-white text-xs mt-1 shadow-text">{formatCount(video.comment_count)}</span>
          </div>

          {/* Avatar */}
          <a
            href={channel.channel_url}
            target="_blank"
            rel="noopener noreferrer"
            className="relative z-30"
            onClick={(e) => e.stopPropagation()}
          >
            {channel.avatar_url ? (
              <img
                src={channel.avatar_url}
                alt={channel.channel_name}
                className="w-11 h-11 rounded-full border-2 border-white"
              />
            ) : (
              <div className="w-11 h-11 rounded-full border-2 border-white bg-gray-700 flex items-center justify-center text-white font-bold text-sm">
                {channel.channel_name?.charAt(0) || '?'}
              </div>
            )}
          </a>
        </div>

        {/* Bottom info overlay */}
        <div className="absolute bottom-4 left-3 right-16 z-30">
          {/* Channel name + age */}
          <div className="flex items-center gap-2 mb-1">
            <a
              href={channel.channel_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-white font-bold text-sm shadow-text hover:underline z-30"
              onClick={(e) => e.stopPropagation()}
            >
              @{channel.channel_name}
            </a>
            {age && (
              <span className="text-gray-300 text-xs shadow-text">[{age}]</span>
            )}
          </div>

          {/* Video title */}
          <p className="text-white text-sm shadow-text mb-1 line-clamp-2">
            {video.title || 'Untitled'}
          </p>

          {/* Channel stats */}
          <p className="text-gray-300 text-xs shadow-text">
            {channel.subscriber_count ? `${formatCount(parseInt(channel.subscriber_count))} subs` : ''}
            {channel.total_video_count ? ` · ${formatCount(parseInt(channel.total_video_count))} videos` : ''}
          </p>

          {/* Video dots */}
          {channel.videos.length > 1 && (
            <div className="flex items-center justify-center gap-1.5 mt-3">
              {channel.videos.map((_, i) => (
                <button
                  key={i}
                  onClick={() => onVideoChange(i)}
                  className={`rounded-full transition-all z-30 ${
                    i === videoIndex
                      ? 'w-2.5 h-2.5 bg-white'
                      : 'w-1.5 h-1.5 bg-white/50 hover:bg-white/80'
                  }`}
                />
              ))}
            </div>
          )}
        </div>

        {/* Swipe hints (shown briefly on first load) */}
        <SwipeHints />
      </div>

      {/* Loading more indicator */}
      {loading && channels.length > 0 && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-50">
          <span className="bg-black/60 text-gray-300 text-xs px-3 py-1 rounded-full">
            Loading more channels...
          </span>
        </div>
      )}
    </div>
  );
}

function SwipeHints() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none">
      <div className="bg-black/70 backdrop-blur-sm rounded-2xl px-6 py-4 text-center">
        <p className="text-white text-sm mb-2">Swipe to navigate</p>
        <div className="flex items-center justify-center gap-4 text-gray-300 text-xs">
          <span>
            <span className="block text-lg mb-1">&#8593;&#8595;</span>
            Channels
          </span>
          <span>
            <span className="block text-lg mb-1">&#8592;&#8594;</span>
            Videos
          </span>
        </div>
        <p className="text-gray-500 text-xs mt-2">M to unmute</p>
      </div>
    </div>
  );
}
