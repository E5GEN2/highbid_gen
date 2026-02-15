'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

interface VideoRenderButtonProps {
  compositionId: string;
  inputProps: Record<string, unknown>;
  channelIds?: string[];
  label?: string;
}

type RenderState = 'idle' | 'downloading' | 'rendering' | 'complete' | 'error';

export default function VideoRenderButton({
  compositionId,
  inputProps,
  channelIds,
  label = 'Render Video',
}: VideoRenderButtonProps) {
  const [state, setState] = useState<RenderState>('idle');
  const [progress, setProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const startRender = async () => {
    setState('downloading');
    setProgress(0);
    setError(null);
    setVideoUrl(null);

    try {
      const res = await fetch('/api/admin/x-posts/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compositionId, inputProps, channelIds }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start render');

      setJobId(data.jobId);

      // Start polling
      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/admin/x-posts/render-status/${data.jobId}`);
          const statusData = await statusRes.json();

          setProgress(statusData.progress || 0);

          if (statusData.progress < 30) {
            setState('downloading');
          } else {
            setState('rendering');
          }

          if (statusData.status === 'completed') {
            setState('complete');
            setVideoUrl(statusData.videoUrl);
            stopPolling();
          } else if (statusData.status === 'failed') {
            setState('error');
            setError(statusData.error || 'Render failed');
            stopPolling();
          }
        } catch {
          // Continue polling on network errors
        }
      }, 2000);

      // Safety: stop polling after 10 minutes
      setTimeout(() => stopPolling(), 600000);
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Failed to start render');
    }
  };

  return (
    <div className="mt-3">
      {state === 'idle' && (
        <button
          onClick={startRender}
          className="px-4 py-2 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-700 hover:to-pink-700"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-2.625 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0118 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0-5.25C6 5.004 6.504 4.5 7.125 4.5h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0118 7.125v-1.5m1.125 2.625c-.621 0-1.125.504-1.125 1.125v1.5m2.625-2.625c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M18 5.625v5.25M7.125 12h9.75m-9.75 0A1.125 1.125 0 016 10.875M7.125 12C6.504 12 6 12.504 6 13.125m0-2.25C6 11.496 5.496 12 4.875 12M18 10.875c0 .621-.504 1.125-1.125 1.125M18 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m-12 5.25v-5.25m0 5.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-12 0v-1.5c0-.621-.504-1.125-1.125-1.125M18 18.375v-5.25m0 5.25v-1.5c0-.621.504-1.125 1.125-1.125M18 13.125v1.5c0 .621.504 1.125 1.125 1.125M18 13.125c0-.621.504-1.125 1.125-1.125M6 13.125v1.5c0 .621-.504 1.125-1.125 1.125M6 13.125C6 12.504 5.496 12 4.875 12m-1.5 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 12 6 12.504 6 13.125" />
          </svg>
          {label}
        </button>
      )}

      {(state === 'downloading' || state === 'rendering') && (
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <span className="text-sm text-gray-300">
              {state === 'downloading' ? 'Downloading clips...' : `Rendering... ${progress}%`}
            </span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {state === 'complete' && videoUrl && (
        <div className="bg-gray-800/50 border border-green-800/50 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Render complete
          </div>

          {/* Inline video preview */}
          <video
            src={videoUrl}
            controls
            autoPlay
            muted
            loop
            className="w-full max-w-md rounded-lg border border-gray-700"
            style={{ aspectRatio: '1/1' }}
          />

          <div className="flex items-center gap-2">
            <a
              href={videoUrl}
              download
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-green-900/50 text-green-400 border border-green-800 hover:bg-green-900 transition flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Download MP4
            </a>
            <button
              onClick={() => {
                setState('idle');
                setProgress(0);
                setVideoUrl(null);
                setJobId(null);
              }}
              className="px-4 py-2 text-xs text-gray-400 rounded-lg bg-gray-800 hover:bg-gray-700 hover:text-white transition"
            >
              Re-render
            </button>
          </div>
        </div>
      )}

      {state === 'error' && (
        <div className="bg-gray-800/50 border border-red-800/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-red-400 text-sm mb-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            Render failed
          </div>
          <p className="text-xs text-red-400/70">{error}</p>
          <button
            onClick={() => { setState('idle'); setError(null); }}
            className="mt-2 px-3 py-1.5 text-xs text-gray-400 rounded-lg bg-gray-800 hover:bg-gray-700 hover:text-white transition"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
