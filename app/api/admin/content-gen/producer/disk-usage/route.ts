/**
 * Disk usage + orphan sweep for producer-generated assets.
 *
 *   GET  /api/admin/content-gen/producer/disk-usage
 *     → returns { dirs: [{ dir, file_count, bytes, oldest, newest }], totals }
 *
 *   POST /api/admin/content-gen/producer/disk-usage
 *       body: { action: 'sweep' }                  — delete orphan files
 *       body: { action: 'sweep', max_age_days: N } — also delete files older than N days
 *     → returns { deleted: N, freed_bytes: M }
 *
 * "Orphan" = a file on disk under CLIPS_DIR/{producer_renders, images,
 * tts, sfx, group_audio} that is NOT referenced by any active
 * content_gen_tool_cache.asset_paths entry AND was not the
 * final_video_url of any content_gen_producer_jobs row.
 *
 * The voice + sfx libs also have their own DB-backed caches —
 * content_gen_voice_assets.local_path + content_gen_sfx_assets.local_path —
 * which we honor as "referenced" so we don't blow away TTS/SFX assets
 * the libs would otherwise re-use.
 *
 * Without this sweep, cache invalidation (POST /producer/cache) frees DB
 * rows but the disk files keep accumulating, eventually filling
 * /data/clips on Railway. With this sweep, the admin can reclaim disk
 * after any cache purge.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { CLIPS_DIR } from '@/lib/clips-dir';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SCAN_DIRS = [
  path.join(CLIPS_DIR, 'producer_renders'),
  path.join(CLIPS_DIR, 'producer_renders', 'images'),
  path.join(CLIPS_DIR, 'tts'),
  path.join(CLIPS_DIR, 'sfx'),
  path.join(CLIPS_DIR, 'group_audio'),
];

interface DirEntry {
  full: string;       // absolute path
  size: number;
  mtime_ms: number;
}

async function walkDir(dir: string): Promise<DirEntry[]> {
  const out: DirEntry[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;  // dir doesn't exist on this box — skip
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isFile()) {
      try {
        const st = await fs.stat(full);
        out.push({ full, size: st.size, mtime_ms: st.mtimeMs });
      } catch { /* race: file gone between readdir and stat */ }
    }
    // Don't recurse — SCAN_DIRS already lists the leaf folders we care about.
  }
  return out;
}

/** Build the set of file paths the DB considers "referenced" — meaning a
 *  cache row, a producer job, or a voice/sfx asset row points at them. */
async function loadReferencedPaths(): Promise<Set<string>> {
  const pool = await getPool();
  const refs = new Set<string>();

  // Tool cache asset_paths (TEXT[])
  const cache = await pool.query<{ p: string }>(
    `SELECT UNNEST(asset_paths) AS p FROM content_gen_tool_cache WHERE asset_paths IS NOT NULL`,
  ).catch(() => ({ rows: [] as { p: string }[] }));
  for (const r of cache.rows) if (r.p) refs.add(r.p);

  // Producer final mp4s — stored as URL fragments like "/api/...?path=job-N.mp4".
  // Reconstruct the absolute path under COMPOSE_DIR.
  const jobs = await pool.query<{ final_video_url: string | null }>(
    `SELECT final_video_url FROM content_gen_producer_jobs WHERE final_video_url IS NOT NULL`,
  ).catch(() => ({ rows: [] as { final_video_url: string | null }[] }));
  for (const r of jobs.rows) {
    const u = r.final_video_url;
    if (!u) continue;
    const m = /[?&]path=([^&]+)/.exec(u);
    if (m) refs.add(path.join(CLIPS_DIR, 'producer_renders', decodeURIComponent(m[1])));
  }

  // Voice + SFX libs have their own asset stores.
  for (const [table, col] of [['content_gen_voice_assets', 'local_path'],
                              ['content_gen_sfx_assets',   'local_path']] as const) {
    const r = await pool.query<{ p: string | null }>(
      `SELECT ${col} AS p FROM ${table} WHERE ${col} IS NOT NULL`,
    ).catch(() => ({ rows: [] as { p: string | null }[] }));
    for (const row of r.rows) if (row.p) refs.add(row.p);
  }

  return refs;
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const referenced = await loadReferencedPaths();
  const dirs: Array<{ dir: string; file_count: number; bytes: number; orphan_count: number; orphan_bytes: number; oldest: number | null; newest: number | null }> = [];

  for (const dir of SCAN_DIRS) {
    const files = await walkDir(dir);
    let orphanCount = 0;
    let orphanBytes = 0;
    let totalBytes = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    for (const f of files) {
      totalBytes += f.size;
      if (oldest == null || f.mtime_ms < oldest) oldest = f.mtime_ms;
      if (newest == null || f.mtime_ms > newest) newest = f.mtime_ms;
      if (!referenced.has(f.full)) {
        orphanCount += 1;
        orphanBytes += f.size;
      }
    }
    dirs.push({
      dir: dir.replace(CLIPS_DIR, '$CLIPS_DIR'),
      file_count: files.length,
      bytes: totalBytes,
      orphan_count: orphanCount,
      orphan_bytes: orphanBytes,
      oldest, newest,
    });
  }

  const totals = dirs.reduce(
    (acc, d) => ({
      file_count: acc.file_count + d.file_count,
      bytes: acc.bytes + d.bytes,
      orphan_count: acc.orphan_count + d.orphan_count,
      orphan_bytes: acc.orphan_bytes + d.orphan_bytes,
    }),
    { file_count: 0, bytes: 0, orphan_count: 0, orphan_bytes: 0 },
  );

  return NextResponse.json({ ok: true, clips_dir: CLIPS_DIR, dirs, totals, referenced_count: referenced.size });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { action?: 'sweep'; max_age_days?: number };
  if (body.action !== 'sweep') return NextResponse.json({ error: 'action: "sweep" required' }, { status: 400 });

  const referenced = await loadReferencedPaths();
  const cutoffMs = typeof body.max_age_days === 'number'
    ? Date.now() - body.max_age_days * 24 * 3600 * 1000
    : null;
  let deleted = 0;
  let freedBytes = 0;
  const removedPreview: string[] = [];

  for (const dir of SCAN_DIRS) {
    const files = await walkDir(dir);
    for (const f of files) {
      const isOrphan = !referenced.has(f.full);
      const isStale = cutoffMs != null && f.mtime_ms < cutoffMs;
      if (!isOrphan && !isStale) continue;
      try {
        await fs.unlink(f.full);
        deleted += 1;
        freedBytes += f.size;
        if (removedPreview.length < 10) removedPreview.push(f.full.replace(CLIPS_DIR, '$CLIPS_DIR'));
      } catch (e) {
        console.warn(`[disk-sweep] failed to unlink ${f.full}: ${(e as Error).message}`);
      }
    }
  }

  return NextResponse.json({
    ok: true, deleted, freed_bytes: freedBytes,
    removed_preview: removedPreview,
    cutoff_days: body.max_age_days ?? null,
  });
}
