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
    return {
      tool: row.tool,
      version: row.version,
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
    action?: 'invalidate' | 'invalidate_all';
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

  return NextResponse.json({ error: 'action required (invalidate | invalidate_all)' }, { status: 400 });
}
