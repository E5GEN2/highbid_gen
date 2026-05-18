'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Manual video import modal. Pasted YouTube URL → POST to the
 * SSE endpoint /api/niche-spy/favourites/import, then renders the
 * pipeline stages live as the server writes them.
 *
 * Stage list (matches the server's send() calls):
 *   1. validating  — URL parsed, ID extracted
 *   2. checking    — DB lookup for an existing row
 *   3. fetching    — YouTube Data API metadata pull
 *   4. inserting   — niche_spy_videos row written
 *   5. embedding   — multimodal vector generated
 *   6. starring    — niche_spy_favourites row written
 *   7. done        — success terminal
 *      error       — failure terminal
 *
 * Idempotent — pasting the same URL twice does not create a
 * duplicate niche_spy_videos row; we just re-star it (or no-op if
 * already starred).
 */

type Stage = 'idle' | 'validating' | 'checking' | 'fetching' | 'inserting' | 'embedding' | 'starring' | 'done' | 'error';

interface ProgressEvent {
  stage: Stage;
  message: string;
  videoId?: number;
  ytId?: string;
  title?: string;
  thumbnail?: string;
  alreadyExisted?: boolean;
  alreadyStarred?: boolean;
}

// Render order — used to determine which stages are "done" vs "pending".
const STAGE_FLOW: Exclude<Stage, 'idle' | 'done' | 'error'>[] = [
  'validating', 'checking', 'fetching', 'inserting', 'embedding', 'starring',
];

const STAGE_LABELS: Record<Exclude<Stage, 'idle'>, string> = {
  validating: 'Validate URL',
  checking:   'Check database',
  fetching:   'Fetch metadata',
  inserting:  'Save to database',
  embedding:  'Generate embedding',
  starring:   'Add to Favourites',
  done:       'Done',
  error:      'Error',
};

export function ImportVideoModal({
  open, onClose, onImported,
}: {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful import. Passes the videoId so the
   *  parent can refresh its Favourites list. */
  onImported: (videoId: number) => void;
}) {
  const [url, setUrl] = useState('');
  const [running, setRunning] = useState(false);
  const [currentStage, setCurrentStage] = useState<Stage>('idle');
  const [messages, setMessages] = useState<Array<{ stage: Stage; message: string }>>([]);
  const [result, setResult] = useState<ProgressEvent | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset state every time the modal opens.
  useEffect(() => {
    if (open) {
      setUrl('');
      setRunning(false);
      setCurrentStage('idle');
      setMessages([]);
      setResult(null);
    }
    return () => {
      // Abort any inflight import on unmount so the server stops
      // pumping events into a writer with no reader.
      abortRef.current?.abort();
    };
  }, [open]);

  // ESC closes (unless we're mid-import — in that case let it
  // finish; user can hit Cancel to abort explicitly).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, running, onClose]);

  const handleStart = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setRunning(true);
    setCurrentStage('validating');
    setMessages([]);
    setResult(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch('/api/niche-spy/favourites/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        setCurrentStage('error');
        setMessages(m => [...m, { stage: 'error', message: `HTTP ${res.status}` }]);
        return;
      }

      // SSE reader — split incoming text on the standard `\n\n`
      // event boundary, parse each `data: ` line as JSON.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() ?? '';
        for (const block of events) {
          const dataLine = block.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;
          try {
            const evt = JSON.parse(dataLine.slice(5).trim()) as ProgressEvent;
            setCurrentStage(evt.stage);
            setMessages(m => [...m, { stage: evt.stage, message: evt.message }]);
            if (evt.stage === 'done' || evt.stage === 'error') {
              setResult(evt);
              if (evt.stage === 'done' && evt.videoId != null) {
                onImported(evt.videoId);
              }
            }
          } catch { /* skip malformed line */ }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Closed/cancelled — no-op, the user dismissed.
      } else {
        setCurrentStage('error');
        setMessages(m => [...m, { stage: 'error', message: (err as Error).message }]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [url, onImported]);

  if (!open) return null;

  // Index of the currently-running stage in STAGE_FLOW (used to
  // mark earlier stages "done" in the checklist).
  const flowIdx = (() => {
    if (currentStage === 'done')  return STAGE_FLOW.length;        // all complete
    if (currentStage === 'error') return STAGE_FLOW.length;        // halt, mark up to error
    return STAGE_FLOW.indexOf(currentStage as never);
  })();

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4 py-8"
      onClick={() => { if (!running) onClose(); }}
    >
      <div
        className="w-full max-w-md bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#1f1f1f]">
          <div>
            <h2 className="text-base font-semibold text-white">Import a YouTube video</h2>
            <p className="text-xs text-[#888] mt-0.5">
              Paste a URL. We&apos;ll fetch the metadata, generate the embedding,
              and star it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="text-[#888] hover:text-white disabled:opacity-30 text-2xl leading-none px-2"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4">
          <label className="block text-[12px] uppercase tracking-[0.12em] text-[#666] font-semibold mb-2">
            YouTube URL
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://youtu.be/… or https://youtube.com/watch?v=…"
              disabled={running || currentStage === 'done'}
              autoFocus
              className="flex-1 px-3 py-2 text-sm bg-[#0f0f0f] border border-[#1f1f1f] rounded-md text-white placeholder-[#555] focus:outline-none focus:border-amber-400/50 disabled:opacity-60"
              onKeyDown={e => {
                if (e.key === 'Enter' && !running && url.trim()) handleStart();
              }}
            />
            <button
              type="button"
              onClick={handleStart}
              disabled={running || !url.trim() || currentStage === 'done'}
              className="px-4 py-2 text-sm font-semibold bg-amber-400 text-black rounded-md hover:bg-amber-300 transition disabled:opacity-50 whitespace-nowrap"
            >
              {running ? 'Importing…' : currentStage === 'done' ? 'Done' : 'Import'}
            </button>
          </div>

          {/* Pipeline checklist — shows live as events arrive. Each
              row is one stage; flowIdx decides done/active/pending. */}
          {currentStage !== 'idle' && (
            <div className="mt-5 space-y-1.5">
              {STAGE_FLOW.map((stg, i) => {
                const isDone   = currentStage === 'error' ? i < flowIdx : i < flowIdx;
                const isActive = currentStage !== 'done' && currentStage !== 'error' && i === flowIdx;
                const lastMsg = [...messages].reverse().find(m => m.stage === stg);
                return (
                  <StageRow
                    key={stg}
                    label={STAGE_LABELS[stg]}
                    status={isDone ? 'done' : isActive ? 'active' : 'pending'}
                    message={lastMsg?.message}
                  />
                );
              })}
            </div>
          )}

          {/* Result panel — success or error */}
          {result && (
            <div className={`mt-5 p-3 rounded-md border ${
              result.stage === 'done'
                ? 'bg-emerald-500/10 border-emerald-500/25'
                : 'bg-red-500/10 border-red-500/25'
            }`}>
              <div className="flex items-start gap-3">
                {result.thumbnail && result.stage === 'done' && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={result.thumbnail}
                    alt=""
                    className="w-20 h-12 rounded object-cover flex-shrink-0"
                    loading="lazy"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className={`text-sm font-semibold ${
                    result.stage === 'done' ? 'text-emerald-300' : 'text-red-300'
                  }`}>
                    {result.stage === 'done' ? 'Imported' : 'Error'}
                  </div>
                  {result.title && <div className="text-xs text-white mt-1 line-clamp-2">{result.title}</div>}
                  <div className="text-[11px] text-[#888] mt-1">{result.message}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-[#1f1f1f]">
          <span className="text-[11px] text-[#666]">
            {running && currentStage === 'embedding' && 'Embedding takes ~5s on a cold call'}
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="px-4 py-1.5 text-sm text-[#888] hover:text-white disabled:opacity-30"
          >
            {result?.stage === 'done' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Single stage row in the pipeline checklist
 * ──────────────────────────────────────────────────────────────── */

function StageRow({
  label, status, message,
}: { label: string; status: 'pending' | 'active' | 'done'; message?: string }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <div className="flex-shrink-0 w-5 h-5 mt-0.5">
        {status === 'done' && (
          <div className="w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
            <svg className="w-3 h-3 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
        {status === 'active' && (
          <div className="w-5 h-5 rounded-full bg-amber-400/15 border border-amber-400/40 flex items-center justify-center">
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          </div>
        )}
        {status === 'pending' && (
          <div className="w-5 h-5 rounded-full bg-[#1a1a1a] border border-[#2a2a2a]" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className={
          status === 'done'   ? 'text-white' :
          status === 'active' ? 'text-amber-300' :
                                'text-[#555]'
        }>{label}</div>
        {message && status !== 'pending' && (
          <div className="text-[11px] text-[#666] mt-0.5 line-clamp-2">{message}</div>
        )}
      </div>
    </div>
  );
}
