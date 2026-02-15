'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

interface VideoRenderButtonProps {
  compositionId: string;
  inputProps: Record<string, unknown>;
  channelIds?: string[];
  label?: string;
}

type RenderState = 'idle' | 'processing' | 'complete' | 'error';

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
  const [logs, setLogs] = useState<string>('');
  const [logsExpanded, setLogsExpanded] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logsExpanded && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, logsExpanded]);

  const lastLogLine = logs.split('\n').filter(Boolean).pop() || '';

  const startRender = async () => {
    setState('processing');
    setProgress(0);
    setError(null);
    setVideoUrl(null);
    setLogs('');

    try {
      const res = await fetch('/api/admin/x-posts/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compositionId, inputProps, channelIds }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start render');

      // Start polling
      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/admin/x-posts/render-status/${data.jobId}`);
          const statusData = await statusRes.json();

          setProgress(statusData.progress || 0);
          if (statusData.logs) setLogs(statusData.logs);

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
      }, 1500);

      setTimeout(() => stopPolling(), 600000);
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Failed to start render');
    }
  };

  const reset = () => {
    setState('idle');
    setProgress(0);
    setVideoUrl(null);
    setError(null);
    setLogs('');
    setLogsExpanded(false);
  };

  return (
    <div className="mt-3">
      {state === 'idle' && (
        <button
          onClick={startRender}
          className="px-4 py-2 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-700 hover:to-pink-700"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
          </svg>
          {label}
        </button>
      )}

      {state === 'processing' && (
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl overflow-hidden">
          {/* Header with progress */}
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <span className="text-xs font-medium text-gray-300 truncate max-w-[300px]">
                  {lastLogLine.replace(/^\[[\d:]+\]\s*/, '') || 'Starting...'}
                </span>
              </div>
              <span className="text-xs font-mono text-purple-400 flex-shrink-0 ml-2">{progress}%</span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-1.5 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-700"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Expandable log */}
          {logs && (
            <>
              <button
                onClick={() => setLogsExpanded(!logsExpanded)}
                className="w-full flex items-center gap-1.5 px-4 py-1.5 text-[10px] text-gray-500 hover:text-gray-400 border-t border-gray-700/50 transition"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${logsExpanded ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                {logsExpanded ? 'Hide' : 'Show'} console ({logs.split('\n').filter(Boolean).length} lines)
              </button>
              {logsExpanded && (
                <div className="px-3 pb-3 max-h-48 overflow-y-auto">
                  <pre className="text-[10px] font-mono text-gray-500 leading-relaxed whitespace-pre-wrap">
                    {logs.split('\n').map((line, i) => (
                      <div key={i} className={line.includes('ERROR') ? 'text-red-400' : line.includes('complete') ? 'text-green-400' : ''}>
                        {line}
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {state === 'complete' && videoUrl && (
        <div className="bg-gray-800/50 border border-green-800/50 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Render complete
            </div>
            {logs && (
              <button
                onClick={() => setLogsExpanded(!logsExpanded)}
                className="text-[10px] text-gray-500 hover:text-gray-400 transition"
              >
                {logsExpanded ? 'hide log' : 'show log'}
              </button>
            )}
          </div>

          {logsExpanded && logs && (
            <pre className="text-[10px] font-mono text-gray-500 leading-relaxed whitespace-pre-wrap max-h-36 overflow-y-auto bg-gray-900/50 rounded-lg p-2">
              {logs.split('\n').map((line, i) => (
                <div key={i} className={line.includes('ERROR') ? 'text-red-400' : line.includes('complete') ? 'text-green-400' : ''}>
                  {line}
                </div>
              ))}
            </pre>
          )}

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
            <button onClick={reset} className="px-4 py-2 text-xs text-gray-400 rounded-lg bg-gray-800 hover:bg-gray-700 hover:text-white transition">
              Re-render
            </button>
          </div>
        </div>
      )}

      {state === 'error' && (
        <div className="bg-gray-800/50 border border-red-800/50 rounded-xl overflow-hidden">
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 text-red-400 text-sm mb-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              Render failed
            </div>
            <p className="text-xs text-red-400/70 mb-2">{error?.split('\n')[0]}</p>
            <button onClick={reset} className="px-3 py-1.5 text-xs text-gray-400 rounded-lg bg-gray-800 hover:bg-gray-700 hover:text-white transition">
              Try Again
            </button>
          </div>

          {/* Full error + log expandable */}
          {(error?.includes('--- Log ---') || logs) && (
            <>
              <button
                onClick={() => setLogsExpanded(!logsExpanded)}
                className="w-full flex items-center gap-1.5 px-4 py-1.5 text-[10px] text-gray-500 hover:text-gray-400 border-t border-gray-700/50 transition"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${logsExpanded ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                {logsExpanded ? 'Hide' : 'Show'} full log
              </button>
              {logsExpanded && (
                <pre className="px-3 pb-3 text-[10px] font-mono text-gray-500 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {(logs || error || '').split('\n').map((line, i) => (
                    <div key={i} className={line.includes('ERROR') ? 'text-red-400' : ''}>{line}</div>
                  ))}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
