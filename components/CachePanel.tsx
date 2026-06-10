'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Producer Tab → Cache panel.
 *
 * Lists per-tool stats from content_gen_tool_cache (row count, hits,
 * latest version, sample on-disk bytes) with an "Invalidate" button per
 * tool. Backs onto GET / POST /api/admin/content-gen/producer/cache.
 *
 * Folded collapsed by default — most renders don't need cache management
 * visible. Click the header to expand.
 */

interface ToolCacheStats {
  tool: string;
  version: string;
  rows: number;
  hits: number;
  oldest: string;
  newest: string;
  sample_bytes: number | null;
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface DiskUsage {
  clips_dir: string;
  totals: { file_count: number; bytes: number; orphan_count: number; orphan_bytes: number };
  dirs: Array<{ dir: string; file_count: number; bytes: number; orphan_count: number; orphan_bytes: number }>;
}

export default function CachePanel() {
  const [tools, setTools] = useState<ToolCacheStats[]>([]);
  const [disk, setDisk] = useState<DiskUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [c, d] = await Promise.all([
        fetch('/api/admin/content-gen/producer/cache', { credentials: 'include' }).then(r => r.json()),
        fetch('/api/admin/content-gen/producer/disk-usage', { credentials: 'include' }).then(r => r.json()),
      ]);
      if (c.ok) setTools(c.tools);
      else setErr(c.error ?? 'failed');
      if (d.ok) setDisk(d);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setLoading(false); }
  }, []);

  const sweepOrphans = async () => {
    if (!disk) return;
    if (!confirm(`Delete ${disk.totals.orphan_count} orphan files (${fmtBytes(disk.totals.orphan_bytes)})? They aren't referenced by any cache row, voice/sfx asset, or producer job.`)) return;
    setBusy('__sweep__');
    try {
      const r = await fetch('/api/admin/content-gen/producer/disk-usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'sweep' }),
      }).then(r => r.json());
      if (r.ok) {
        await refresh();
      } else {
        setErr(r.error ?? 'sweep failed');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const invalidate = async (tool: string) => {
    if (!confirm(`Invalidate ${tool} cache? Next render will repopulate from scratch.`)) return;
    setBusy(tool);
    try {
      const r = await fetch('/api/admin/content-gen/producer/cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'invalidate', tool }),
      }).then(r => r.json());
      if (r.ok) {
        await refresh();
      } else {
        setErr(r.error ?? 'invalidate failed');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  const invalidateAll = async () => {
    if (!confirm('Invalidate ALL tools? Every cache row will be deleted.')) return;
    setBusy('__all__');
    try {
      const r = await fetch('/api/admin/content-gen/producer/cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'invalidate_all' }),
      }).then(r => r.json());
      if (r.ok) await refresh();
      else setErr(r.error ?? 'failed');
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  const totalRows = tools.reduce((a, t) => a + t.rows, 0);
  const totalHits = tools.reduce((a, t) => a + t.hits, 0);

  return (
    <div className="mb-5 rounded border border-[#1f1f1f] bg-[#0c0c0c]">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-[#aaa] hover:bg-[#101010]"
      >
        <span className="flex items-center gap-2">
          <span className="text-[#666]">{open ? '▾' : '▸'}</span>
          <span>Tool cache</span>
          {tools.length > 0 && (
            <span className="text-[#666]">
              · {tools.length} tool{tools.length === 1 ? '' : 's'} · {totalRows} rows · {totalHits} hits
            </span>
          )}
        </span>
        {open && (
          <span className="flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); void refresh(); }}
              disabled={loading}
              className="px-2 py-0.5 text-[10px] rounded border border-[#333] hover:border-[#444] text-[#aaa] disabled:opacity-50"
            >{loading ? '…' : 'Refresh'}</button>
            <button
              onClick={(e) => { e.stopPropagation(); void invalidateAll(); }}
              disabled={busy != null}
              className="px-2 py-0.5 text-[10px] rounded border border-red-500/40 hover:border-red-500/60 text-red-300 disabled:opacity-50"
              title="Delete every cache row across all tools"
            >Invalidate all</button>
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-[#1f1f1f] p-3">
          {err && <div className="mb-2 text-[11px] text-red-300">{err}</div>}
          {tools.length === 0 && !loading && (
            <div className="text-[11px] text-[#666] py-2">Cache is empty. Run a render to populate.</div>
          )}
          {disk && (
            <div className="mb-3 pb-3 border-b border-[#1a1a1a] flex items-center gap-3 text-[11px]">
              <span className="text-[#666]">Disk:</span>
              <span className="text-[#ddd]">{fmtBytes(disk.totals.bytes)} across {disk.totals.file_count} files</span>
              {disk.totals.orphan_count > 0 && (
                <>
                  <span className="text-[#666]">·</span>
                  <span className="text-amber-300">
                    {disk.totals.orphan_count} orphan ({fmtBytes(disk.totals.orphan_bytes)})
                  </span>
                  <button
                    onClick={sweepOrphans}
                    disabled={busy != null}
                    className="ml-auto px-2 py-0.5 text-[10px] rounded border border-amber-500/40 hover:border-amber-500/60 text-amber-300 disabled:opacity-50"
                    title="Delete files not referenced by any cache row, voice/sfx asset, or producer job"
                  >
                    {busy === '__sweep__' ? '…' : 'Sweep orphans'}
                  </button>
                </>
              )}
              {disk.totals.orphan_count === 0 && (
                <span className="text-[#666] ml-auto">All files referenced ✓</span>
              )}
            </div>
          )}
          {tools.length > 0 && (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-[#666] border-b border-[#1a1a1a]">
                  <th className="py-1 pr-3 font-normal">Tool</th>
                  <th className="py-1 pr-3 font-normal">Version</th>
                  <th className="py-1 pr-3 font-normal text-right">Rows</th>
                  <th className="py-1 pr-3 font-normal text-right">Hits</th>
                  <th className="py-1 pr-3 font-normal">Last used</th>
                  <th className="py-1 pr-3 font-normal text-right">~Size</th>
                  <th className="py-1 pr-3 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {tools.map(t => (
                  <tr key={t.tool} className="border-b border-[#141414]">
                    <td className="py-1 pr-3 font-mono text-[#ddd]">{t.tool}</td>
                    <td className="py-1 pr-3 text-[#888]">{t.version}</td>
                    <td className="py-1 pr-3 text-right text-[#aaa]">{t.rows}</td>
                    <td className="py-1 pr-3 text-right">
                      {t.hits > 0 ? <span className="text-purple-300">⚡{t.hits}</span> : <span className="text-[#666]">—</span>}
                    </td>
                    <td className="py-1 pr-3 text-[#888]">{timeAgo(t.newest)}</td>
                    <td className="py-1 pr-3 text-right text-[#888]" title="Sample size from 4 newest cached assets">
                      {fmtBytes(t.sample_bytes)}
                    </td>
                    <td className="py-1 pr-3 text-right">
                      <button
                        onClick={() => invalidate(t.tool)}
                        disabled={busy != null}
                        className="px-1.5 py-0.5 rounded border border-[#333] hover:border-[#555] text-[#aaa] disabled:opacity-50"
                      >
                        {busy === t.tool ? '…' : 'Invalidate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
