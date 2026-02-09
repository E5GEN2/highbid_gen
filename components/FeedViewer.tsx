'use client';

import React, { useRef, useCallback, useEffect, useState } from 'react';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: (() => void) | undefined;
  }
}

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

function ageBadgeColor(dateStr: string | null): string {
  if (!dateStr) return 'bg-gray-600/80';
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days <= 30) return 'bg-green-500/90';
  if (days <= 90) return 'bg-yellow-500/90';
  if (days <= 180) return 'bg-orange-500/90';
  return 'bg-gray-600/80';
}

// Load the YouTube IFrame API script once
let ytApiLoading = false;
let ytApiReady = false;
const ytReadyCallbacks: (() => void)[] = [];

function loadYTApi(callback: () => void) {
  if (ytApiReady && window.YT?.Player) {
    callback();
    return;
  }
  ytReadyCallbacks.push(callback);
  if (ytApiLoading) return;
  ytApiLoading = true;

  window.onYouTubeIframeAPIReady = () => {
    ytApiReady = true;
    ytReadyCallbacks.forEach((cb) => cb());
    ytReadyCallbacks.length = 0;
  };

  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
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
  const playerRef = useRef<any>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [muted, setMuted] = useState(true);
  const mutedRef = useRef(true);
  const [paused, setPaused] = useState(false);
  const [started, setStarted] = useState(false); // tracks if user has initiated first play
  const startedRef = useRef(false);

  const channel = channels[channelIndex];
  const video = channel?.videos?.[videoIndex];

  // Prevent iOS overscroll/bounce when in feed view
  useEffect(() => {
    const preventDefault = (e: TouchEvent) => {
      if (!(e.target as HTMLElement).closest('[data-scrollable]')) {
        e.preventDefault();
      }
    };
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
    document.body.style.height = '100%';
    document.addEventListener('touchmove', preventDefault, { passive: false });
    return () => {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.width = '';
      document.body.style.height = '';
      document.removeEventListener('touchmove', preventDefault);
    };
  }, []);

  // Initialize YouTube Player API
  useEffect(() => {
    if (!video) return;

    loadYTApi(() => {
      // Destroy old player if exists
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      }
      setPlayerReady(false);

      // Need a fresh div for each player instance
      if (playerContainerRef.current) {
        playerContainerRef.current.innerHTML = '<div id="yt-feed-player"></div>';
      }

      playerRef.current = new window.YT.Player('yt-feed-player', {
        width: '100%',
        height: '100%',
        videoId: video.video_id,
        playerVars: {
          autoplay: started ? 1 : 0, // Only autoplay after user has started once
          mute: 1, // Always start muted for autoplay; unmute via API after
          controls: 0,
          playsinline: 1,
          loop: 1,
          playlist: video.video_id,
          rel: 0,
          modestbranding: 1,
          fs: 0,
          iv_load_policy: 3,
          disablekb: 1,
        },
        events: {
          onReady: () => {
            setPlayerReady(true);
            if (startedRef.current) {
              playerRef.current?.playVideo();
              // Restore mute state after autoplay starts
              if (!mutedRef.current) {
                playerRef.current?.unMute();
              }
            }
          },
          onStateChange: (event: any) => {
            // YT.PlayerState.ENDED = 0 — loop
            if (event.data === 0) {
              playerRef.current?.seekTo(0);
              playerRef.current?.playVideo();
            }
          },
        },
      });
    });

    return () => {
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.video_id]);

  // Trigger load more when approaching end
  useEffect(() => {
    if (channels.length > 0 && channelIndex >= channels.length - 5) {
      onLoadMore();
    }
  }, [channelIndex, channels.length, onLoadMore]);

  // Reset pause state on video change
  useEffect(() => {
    setPaused(false);
  }, [channelIndex, videoIndex]);

  const togglePause = useCallback(() => {
    if (!playerRef.current) return;
    setPaused((p) => {
      if (p) {
        playerRef.current?.playVideo();
      } else {
        playerRef.current?.pauseVideo();
      }
      return !p;
    });
  }, []);

  // "Tap to start" — user gesture that kicks off the first play
  const handleStart = useCallback(() => {
    setStarted(true);
    startedRef.current = true;
    if (playerRef.current) {
      playerRef.current.playVideo();
    }
  }, []);

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
      else if (e.key === 'm') {
        setMuted((m) => {
          const next = !m;
          mutedRef.current = next;
          if (playerRef.current) {
            next ? playerRef.current.mute() : playerRef.current.unMute();
          }
          return next;
        });
      }
      else if (e.key === ' ') { e.preventDefault(); if (started) togglePause(); else handleStart(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, togglePause, handleStart, started]);

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
      const startX = touchRef.current.startX;
      touchRef.current = null;

      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const minDist = 50;
      const maxTime = 500;

      // Tap detection
      if (absDx < 10 && absDy < 10 && dt < 300) {
        if (!started) {
          handleStart();
          return;
        }
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const relX = startX - rect.left;
        if (relX < rect.width * 0.8) {
          togglePause();
        }
        return;
      }

      if (dt > maxTime) return;

      if (absDy > absDx && absDy > minDist) {
        navigate(dy < 0 ? 'up' : 'down');
      } else if (absDx > absDy && absDx > minDist) {
        navigate(dx < 0 ? 'left' : 'right');
      }
    },
    [navigate, togglePause, handleStart, started]
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

  const age = channelAge(channel.channel_creation_date);
  const ageColor = ageBadgeColor(channel.channel_creation_date);

  return (
    <div
      className="fixed inset-0 bg-black flex items-center justify-center z-40"
      style={{ touchAction: 'none' }}
    >
      {/* Channel counter */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50" style={{ top: 'max(1rem, env(safe-area-inset-top, 1rem))' }}>
        <span className="bg-black/60 backdrop-blur-sm text-white text-xs sm:text-sm px-3 py-1.5 rounded-full shadow-text">
          {channelIndex + 1}/{channels.length}
        </span>
      </div>

      {/* Top-right controls */}
      <div className="absolute right-2 sm:right-4 z-50 flex gap-1.5 sm:gap-2" style={{ top: 'max(1rem, env(safe-area-inset-top, 1rem))' }}>
        <button
          onClick={() => { if (started) togglePause(); else handleStart(); }}
          className="w-9 h-9 sm:w-10 sm:h-10 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center text-white active:bg-black/80 transition"
          title={paused ? 'Play (Space)' : 'Pause (Space)'}
        >
          {paused || !started ? (
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          )}
        </button>

        <button
          onClick={() => {
            setMuted((m) => {
              const next = !m;
              mutedRef.current = next;
              if (playerRef.current) {
                next ? playerRef.current.mute() : playerRef.current.unMute();
              }
              return next;
            });
          }}
          className="w-9 h-9 sm:w-10 sm:h-10 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center text-white active:bg-black/80 transition"
          title={muted ? 'Unmute (M)' : 'Mute (M)'}
        >
          {muted ? (
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
            </svg>
          ) : (
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
          )}
        </button>
      </div>

      {/* Video container */}
      <div
        className="relative w-full h-full md:max-w-[calc(100vh*9/16)] mx-auto"
        style={{ transition: 'opacity 150ms ease', opacity: transitioning ? 0 : 1 }}
      >
        {/* YouTube Player API container */}
        <div
          ref={playerContainerRef}
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: 'none' }}
        >
          <div id="yt-feed-player" />
        </div>

        {/* Loading placeholder */}
        {!playerReady && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900 z-10">
            {channel.avatar_url && (
              <img src={channel.avatar_url} alt="" className="w-16 h-16 sm:w-20 sm:h-20 rounded-full mb-4 animate-pulse" />
            )}
            <p className="text-gray-400 animate-pulse text-sm sm:text-base">{channel.channel_name}</p>
            <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin mt-4" />
          </div>
        )}

        {/* "Tap to start" overlay — shown until user initiates first play */}
        {playerReady && !started && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center cursor-pointer"
            onClick={handleStart}
          >
            <div className="bg-black/60 backdrop-blur-sm rounded-2xl px-6 py-4 text-center">
              <div className="w-16 h-16 sm:w-20 sm:h-20 bg-pink-600 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-8 h-8 sm:w-10 sm:h-10 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              <p className="text-white text-sm sm:text-base font-medium">Tap to start</p>
              <p className="text-gray-400 text-[10px] sm:text-xs mt-1">Swipe to browse channels</p>
            </div>
          </div>
        )}

        {/* Paused overlay */}
        {started && paused && (
          <div className="absolute inset-0 z-[15] bg-black/30 flex items-center justify-center pointer-events-none">
            <div className="w-14 h-14 sm:w-16 sm:h-16 bg-black/50 backdrop-blur-sm rounded-full flex items-center justify-center">
              <svg className="w-7 h-7 sm:w-8 sm:h-8 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}

        {/* Touch overlay — captures swipes and taps */}
        {started && (
          <div
            className="absolute inset-0 z-20"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = e.clientX - rect.left;
              if (relX < rect.width * 0.8) {
                togglePause();
              }
            }}
          />
        )}

        {/* Swipe overlay for navigation before started (no pause on tap) */}
        {!started && playerReady && (
          <div
            className="absolute inset-0 z-20"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
          />
        )}

        {/* Stats overlay — right side */}
        <div
          className="absolute right-2 sm:right-3 z-30 flex flex-col items-center gap-4 sm:gap-5"
          style={{ bottom: 'max(7rem, calc(5rem + env(safe-area-inset-bottom, 0px)))' }}
        >
          <div className="flex flex-col items-center">
            <div className="w-9 h-9 sm:w-10 sm:h-10 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center">
              <svg className="w-4 h-4 sm:w-5 sm:h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
            <span className="text-white text-[10px] sm:text-xs mt-1 shadow-text">{formatCount(video.view_count)}</span>
          </div>

          <div className="flex flex-col items-center">
            <div className="w-9 h-9 sm:w-10 sm:h-10 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center">
              <svg className="w-4 h-4 sm:w-5 sm:h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
              </svg>
            </div>
            <span className="text-white text-[10px] sm:text-xs mt-1 shadow-text">{formatCount(video.like_count)}</span>
          </div>

          <div className="flex flex-col items-center">
            <div className="w-9 h-9 sm:w-10 sm:h-10 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center">
              <svg className="w-4 h-4 sm:w-5 sm:h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <span className="text-white text-[10px] sm:text-xs mt-1 shadow-text">{formatCount(video.comment_count)}</span>
          </div>

          <a
            href={channel.channel_url}
            target="_blank"
            rel="noopener noreferrer"
            className="relative z-30"
            onClick={(e) => e.stopPropagation()}
          >
            {channel.avatar_url ? (
              <img src={channel.avatar_url} alt={channel.channel_name} className="w-10 h-10 sm:w-11 sm:h-11 rounded-full border-2 border-white" />
            ) : (
              <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-full border-2 border-white bg-gray-700 flex items-center justify-center text-white font-bold text-xs sm:text-sm">
                {channel.channel_name?.charAt(0) || '?'}
              </div>
            )}
          </a>
        </div>

        {/* Bottom info overlay */}
        <div
          className="absolute left-2 sm:left-3 right-14 sm:right-16 z-30"
          style={{ bottom: 'max(1rem, calc(0.5rem + env(safe-area-inset-bottom, 0px)))' }}
        >
          <div className="flex items-center gap-1.5 sm:gap-2 mb-1 sm:mb-1.5">
            <a
              href={channel.channel_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-white font-bold text-xs sm:text-sm shadow-text hover:underline z-30 truncate max-w-[60%]"
              onClick={(e) => e.stopPropagation()}
            >
              @{channel.channel_name}
            </a>
            {age && (
              <span className={`${ageColor} text-white text-[10px] sm:text-xs font-semibold px-1.5 sm:px-2 py-0.5 rounded-full whitespace-nowrap`}>
                {age}
              </span>
            )}
          </div>

          <p className="text-white text-xs sm:text-sm shadow-text mb-1 line-clamp-2">
            {video.title || 'Untitled'}
          </p>

          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
            {channel.subscriber_count && (
              <span className="bg-black/50 backdrop-blur-sm text-white text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 rounded-full">
                {formatCount(parseInt(channel.subscriber_count))} subs
              </span>
            )}
            {channel.total_video_count && (
              <span className="bg-black/50 backdrop-blur-sm text-white text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 rounded-full">
                {formatCount(parseInt(channel.total_video_count))} videos
              </span>
            )}
            <span className="bg-black/50 backdrop-blur-sm text-white text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 rounded-full">
              seen {channel.sighting_count}x
            </span>
          </div>

          {channel.videos.length > 1 && (
            <div className="flex items-center justify-center gap-1 sm:gap-1.5 mt-2 sm:mt-3">
              <span className="text-gray-400 text-[10px] sm:text-xs mr-1 sm:mr-2 shadow-text">
                {videoIndex + 1}/{channel.videos.length}
              </span>
              {channel.videos.slice(0, 10).map((_, i) => (
                <button
                  key={i}
                  onClick={() => onVideoChange(i)}
                  className={`rounded-full transition-all z-30 ${
                    i === videoIndex
                      ? 'w-2 h-2 sm:w-2.5 sm:h-2.5 bg-white'
                      : 'w-1 h-1 sm:w-1.5 sm:h-1.5 bg-white/50 active:bg-white/80'
                  }`}
                />
              ))}
              {channel.videos.length > 10 && (
                <span className="text-gray-400 text-[10px] sm:text-xs ml-1">+{channel.videos.length - 10}</span>
              )}
            </div>
          )}
        </div>

        {/* Swipe hints (first load only) */}
        {!started && <SwipeHints />}
      </div>

      {loading && channels.length > 0 && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-50" style={{ bottom: 'max(0.5rem, env(safe-area-inset-bottom, 0.5rem))' }}>
          <span className="bg-black/60 text-gray-300 text-[10px] sm:text-xs px-3 py-1 rounded-full">
            Loading more channels...
          </span>
        </div>
      )}
    </div>
  );
}

function SwipeHints() {
  return (
    <div className="absolute inset-x-0 bottom-1/3 z-20 flex justify-center pointer-events-none">
      <div className="flex items-center justify-center gap-4 text-gray-400 text-[10px] sm:text-xs">
        <span>
          <span className="block text-base sm:text-lg mb-1 text-center">&#8593;&#8595;</span>
          Channels
        </span>
        <span>
          <span className="block text-base sm:text-lg mb-1 text-center">&#8592;&#8594;</span>
          Videos
        </span>
      </div>
    </div>
  );
}
