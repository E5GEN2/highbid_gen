'use client';

import React, { useState, useEffect, useRef } from 'react';

export function ApiTokenPopover() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Array<{ id: string; name: string; tokenPreview: string; lastUsedAt: string | null; createdAt: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      fetch('/api/admin/tokens').then(r => r.json()).then(d => setTokens(d.tokens || [])).catch(() => {});
    }
  }, [open]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const generateToken = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'api-token' }),
      });
      const data = await res.json();
      if (data.token) {
        setToken(data.token);
        const listRes = await fetch('/api/admin/tokens');
        const listData = await listRes.json();
        setTokens(listData.tokens || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  const deleteToken = async (id: string) => {
    await fetch(`/api/admin/tokens?id=${id}`, { method: 'DELETE' });
    setTokens(prev => prev.filter(t => t.id !== id));
    if (token) setToken(null);
  };

  const copyToken = () => {
    if (token) {
      navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="relative" ref={popoverRef}>
      {/* Sidebar button */}
      <button
        onClick={() => setOpen(!open)}
        className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
          open
            ? 'bg-amber-600 text-white'
            : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
        }`}
        title="API Token"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
        </svg>
      </button>

      {/* Popover */}
      {open && (
        <div className="absolute bottom-0 left-14 w-96 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-5 z-[100]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-semibold text-white">API Token</h3>
            <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-300">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            Use a Bearer token with all clipping API endpoints.
          </p>

          {/* Newly generated token */}
          {token && (
            <div className="bg-green-900/20 border border-green-600 rounded-lg p-3 mb-3">
              <p className="text-xs text-green-400 mb-1.5 font-medium">Copy now — won't be shown again:</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-black/40 text-green-300 px-2 py-1.5 rounded text-xs font-mono break-all select-all">
                  {token}
                </code>
                <button
                  onClick={copyToken}
                  className="px-2 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded text-xs flex-shrink-0"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Existing tokens */}
          {tokens.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {tokens.map(t => (
                <div key={t.id} className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-white font-mono truncate">{t.tokenPreview}</span>
                    {t.lastUsedAt && (
                      <span className="text-[10px] text-gray-500 flex-shrink-0">
                        Used {new Date(t.lastUsedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => deleteToken(t.id)}
                    className="text-red-400 hover:text-red-300 text-xs flex-shrink-0 ml-2"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={generateToken}
            disabled={loading}
            className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded-lg text-sm font-medium"
          >
            {loading ? 'Generating...' : 'Generate New Token'}
          </button>

          <div className="mt-3 bg-gray-800/30 border border-gray-700 rounded-lg p-2.5">
            <p className="text-[10px] text-gray-500">
              <code className="text-gray-400">Authorization: Bearer hb_...</code>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
