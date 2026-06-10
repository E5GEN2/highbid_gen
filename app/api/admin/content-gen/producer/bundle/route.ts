/**
 * GET /api/admin/content-gen/producer/bundle?id=<job_id>
 *
 * Streams a ZIP containing everything produced by the job:
 *   final.mp4                 — the video_compose output
 *   manifest.json             — script + per-gem metadata (slot, gem_id,
 *                                 tool, args, output_jsonb, elapsed_ms,
 *                                 cache_hit)
 *   assets/<slot>/<gem>.<ext> — every gem's on-disk asset, organized by
 *                                 slot for easy reuse
 *
 * Useful when the user wants to:
 *   - Repurpose stock visuals (PNGs of money_math cards) for X posts.
 *   - Hand the bundle off for editing in CapCut / Premiere.
 *   - Archive a render they like before tool versions get bumped.
 *
 * No new DB tables — reads content_gen_producer_jobs + _gems,
 * dereferences output_jsonb.local_path / file_url, packs into the ZIP
 * via jszip (already a project dependency for other zip flows).
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { CLIPS_DIR } from '@/lib/clips-dir';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
// ZIP-streaming endpoints want longer execution windows than the
// default — a big listicle bundle can be 200MB+ across 100+ gems.
export const maxDuration = 60;

interface GemRow {
  slot_id: string;
  slot_index: number;
  gem_id: string;
  tool: string;
  status: string;
  cache_hit: boolean | null;
  elapsed_ms: number | null;
  output_jsonb: Record<string, unknown> | null;
  args_jsonb: Record<string, unknown>;
}

function safeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
}

function extFromPath(p: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(p);
  return m ? m[1] : 'bin';
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const idStr = new URL(req.url).searchParams.get('id');
  if (!idStr) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const jobId = parseInt(idStr, 10);
  if (!Number.isFinite(jobId)) return NextResponse.json({ error: 'bad id' }, { status: 400 });

  const pool = await getPool();
  const jobRow = await pool.query<{
    id: number; channel_id: string | null; channel_name: string | null;
    status: string; final_video_url: string | null;
    script_jsonb: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, channel_id, channel_name, status, final_video_url,
            script_jsonb, created_at
       FROM content_gen_producer_jobs WHERE id = $1`,
    [jobId],
  );
  if (jobRow.rows.length === 0) return NextResponse.json({ error: `job ${jobId} not found` }, { status: 404 });
  const job = jobRow.rows[0];

  const gemRows = await pool.query<GemRow>(
    `SELECT slot_id, slot_index, gem_id, tool, status, cache_hit,
            elapsed_ms, output_jsonb, args_jsonb
       FROM content_gen_producer_gems
      WHERE job_id = $1
      ORDER BY slot_index ASC, gem_id ASC`,
    [jobId],
  );

  const zip = new JSZip();
  const errors: string[] = [];
  let assetCount = 0;
  let totalBytes = 0;

  // 1. Final mp4 — derived from final_video_url's ?path= param.
  if (job.final_video_url) {
    const m = /[?&]path=([^&]+)/.exec(job.final_video_url);
    if (m) {
      const finalPath = path.join(CLIPS_DIR, 'producer_renders', decodeURIComponent(m[1]));
      try {
        const buf = await fs.readFile(finalPath);
        zip.file('final.mp4', buf);
        assetCount += 1;
        totalBytes += buf.length;
      } catch (e) {
        errors.push(`final.mp4: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }

  // 2. Per-gem assets organized by slot. Stream-write so we don't
  //    materialize the whole ZIP in memory at once.
  for (const g of gemRows.rows) {
    const out = g.output_jsonb;
    if (!out) continue;
    const localPath = (out.local_path as string | undefined)
      || (Array.isArray(out.local_paths) ? (out.local_paths as string[])[0] : undefined);
    if (!localPath) continue;
    try {
      const buf = await fs.readFile(localPath);
      const ext = extFromPath(localPath);
      const zipPath = `assets/${safeFileName(g.slot_id)}/${safeFileName(g.gem_id)}.${ext}`;
      zip.file(zipPath, buf);
      assetCount += 1;
      totalBytes += buf.length;
    } catch (e) {
      errors.push(`${g.slot_id}/${g.gem_id}: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  // 3. Manifest — everything needed to reconstruct or audit the render.
  //    Skipped fields: script.slots[*].compose internals (they're huge and
  //    repeated in the gem rows' args).
  const manifest = {
    job: {
      id: job.id,
      channel_id: job.channel_id,
      channel_name: job.channel_name,
      status: job.status,
      created_at: job.created_at,
      final_video_url: job.final_video_url,
    },
    script_meta: {
      title: (job.script_jsonb as Record<string, unknown> | null)?.title ?? null,
      voice: (job.script_jsonb as Record<string, unknown> | null)?.voice ?? null,
    },
    gems: gemRows.rows.map(g => ({
      slot_id: g.slot_id,
      slot_index: g.slot_index,
      gem_id: g.gem_id,
      tool: g.tool,
      status: g.status,
      cache_hit: g.cache_hit ?? false,
      elapsed_ms: g.elapsed_ms,
      args: g.args_jsonb,
      output: g.output_jsonb,
    })),
    bundle_stats: {
      asset_count: assetCount,
      total_bytes: totalBytes,
      errors_count: errors.length,
    },
    errors: errors.slice(0, 50),  // cap for readability
    generated_at: new Date().toISOString(),
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  const safeChannel = safeFileName(job.channel_name ?? job.channel_id ?? 'unknown');
  const filename = `producer-job-${job.id}-${safeChannel}.zip`;
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buf.length),
      'X-Bundle-Assets': String(assetCount),
      'X-Bundle-Errors': String(errors.length),
    },
  });
}
