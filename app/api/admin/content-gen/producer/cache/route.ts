/**
 * Cache management endpoints for content_gen_tool_cache.
 *
 *   GET  /api/admin/content-gen/producer/cache
 *     → list per-tool stats: row count, total asset bytes, oldest/newest
 *       entry, hit counts, latest version stored.
 *
 *   POST /api/admin/content-gen/producer/cache
 *       body: { action: 'invalidate', tool: 'tts'              }
 *       body: { action: 'invalidate', tool: 'tts', version: 'v0.9.0' }
 *       body: { action: 'invalidate_all' }
 *     → DELETE matching rows. Returns { deleted: N }. Optional asset_paths
 *       are NOT removed from disk by this endpoint — disk cleanup is a
 *       separate sweep so an accidental click here can't blow files away.
 *
 * Used by the "Cache" panel in the Producer admin tab so the user can
 * see what's cached and force a fresh render without going through a
 * code deploy to bump a tool version.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const pool = await getPool();

  // Per-tool rollup: which tools have cache entries, how many, current
  // version, total hits, oldest/newest entry timestamps. asset_paths size
  // is computed lazily on disk because Postgres has no concept of file
  // sizes; we cap the file-stat work to the 100 newest rows so this
  // endpoint stays snappy on big caches.
  const r = await pool.query<{
    tool: string;
    version: string;
    rows: number;
    hits: number;
    oldest: Date;
    newest: Date;
    sample_paths: string[];
  }>(
    `SELECT tool,
            MAX(version) AS version,
            COUNT(*)::int AS rows,
            SUM(hit_count)::int AS hits,
            MIN(created_at) AS oldest,
            MAX(last_used_at) AS newest,
            (ARRAY_AGG(asset_paths ORDER BY last_used_at DESC) FILTER (WHERE COALESCE(array_length(asset_paths, 1), 0) > 0))[1] AS sample_paths
       FROM content_gen_tool_cache
      GROUP BY tool
      ORDER BY tool`,
  );

  // Load any runtime version overrides so the GUI can show "(bumped)"
  // beside tools whose effective version differs from the static spec.
  const overrides = await pool.query<{ tool: string; suffix: string; bumped_at: Date }>(
    `SELECT tool, suffix, bumped_at FROM content_gen_tool_version_overrides`,
  );
  const overrideByTool = new Map(overrides.rows.map(o => [o.tool, o]));

  // Estimate disk usage from sample_paths (one row per tool). Coarse but
  // gives the user a vibe-check number without scanning every cached file.
  const tools = await Promise.all(r.rows.map(async row => {
    let sample_bytes: number | null = null;
    if (row.sample_paths && row.sample_paths.length > 0) {
      sample_bytes = 0;
      for (const p of row.sample_paths.slice(0, 4)) {
        try {
          const st = await fs.stat(p);
          sample_bytes += st.size;
        } catch { /* file missing or unreadable — fine */ }
      }
    }
    const ov = overrideByTool.get(row.tool);
    return {
      tool: row.tool,
      version: row.version,
      override_suffix: ov?.suffix ?? null,
      override_bumped_at: ov?.bumped_at ?? null,
      rows: row.rows,
      hits: row.hits,
      oldest: row.oldest,
      newest: row.newest,
      sample_bytes,           // sum of up to 4 newest entry's asset files
    };
  }));

  return NextResponse.json({ ok: true, tools });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    action?: 'invalidate' | 'invalidate_all' | 'bump_version' | 'revert_version';
    tool?: string;
    version?: string;
  };

  const pool = await getPool();

  if (body.action === 'invalidate_all') {
    const r = await pool.query(`DELETE FROM content_gen_tool_cache`);
    return NextResponse.json({ ok: true, deleted: r.rowCount, scope: 'all' });
  }

  if (body.action === 'invalidate') {
    if (!body.tool) return NextResponse.json({ error: 'tool required' }, { status: 400 });
    if (body.version) {
      const r = await pool.query(
        `DELETE FROM content_gen_tool_cache WHERE tool = $1 AND version = $2`,
        [body.tool, body.version],
      );
      return NextResponse.json({ ok: true, deleted: r.rowCount, scope: `${body.tool}@${body.version}` });
    }
    const r = await pool.query(`DELETE FROM content_gen_tool_cache WHERE tool = $1`, [body.tool]);
    return NextResponse.json({ ok: true, deleted: r.rowCount, scope: body.tool });
  }

  // Bump version — namespace bump that keeps OLD cache rows on disk so a
  // revert is possible. Old rows just won't be served because the hash
  // changes. UPSERT a random short suffix; cache module re-reads within 5s.
  if (body.action === 'bump_version') {
    if (!body.tool) return NextResponse.json({ error: 'tool required' }, { status: 400 });
    const suffix = `bump-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await pool.query(
      `INSERT INTO content_gen_tool_version_overrides (tool, suffix, bumped_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tool) DO UPDATE SET suffix = EXCLUDED.suffix, bumped_at = NOW()`,
      [body.tool, suffix],
    );
    const { invalidateOverridesCache } = await import('@/lib/content-gen/tool-cache');
    invalidateOverridesCache();
    return NextResponse.json({ ok: true, tool: body.tool, suffix });
  }

  // Revert — delete the override so the static version applies again
  // and any rows cached under it become re-servable.
  if (body.action === 'revert_version') {
    if (!body.tool) return NextResponse.json({ error: 'tool required' }, { status: 400 });
    const r = await pool.query(
      `DELETE FROM content_gen_tool_version_overrides WHERE tool = $1`,
      [body.tool],
    );
    const { invalidateOverridesCache } = await import('@/lib/content-gen/tool-cache');
    invalidateOverridesCache();
    return NextResponse.json({ ok: true, tool: body.tool, reverted: (r.rowCount ?? 0) > 0 });
  }

  return NextResponse.json({ error: 'action required (invalidate | invalidate_all | bump_version | revert_version)' }, { status: 400 });
}
