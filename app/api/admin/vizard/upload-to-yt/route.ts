import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { submitClipToXgodo } from '@/lib/xgodo-vizard-upload';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * POST /api/admin/vizard/upload-to-yt
 *
 * Body: { clipIds: number[], description?: string }
 *
 * For each clip, submits a planned task to xgodo's YT-upload job using
 * the clip's existing Vizard-generated title verbatim. Per the user's
 * spec we DO NOT rewrite titles via LLM — Vizard's titles are already
 * decent and rewriting introduces another failure mode.
 *
 * Description: the same text is reused for every selected clip
 * (typical case: send 3 related clips, one description for the batch).
 * Defaults to '' if omitted.
 *
 * Idempotent: clips that are already queued return their existing
 * planned_task_id without re-submitting.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    clipIds?: number[];
    description?: string;
  };

  const clipIds = Array.isArray(body.clipIds)
    ? body.clipIds.filter(n => typeof n === 'number' && Number.isFinite(n))
    : [];
  if (clipIds.length === 0) {
    return NextResponse.json({ error: 'clipIds (number[]) required' }, { status: 400 });
  }
  const description = typeof body.description === 'string' ? body.description : '';

  const pool = await getPool();
  const clipsRes = await pool.query<{
    id: number; title: string | null; video_url: string | null;
  }>(
    `SELECT id, title, video_url FROM vizard_clips WHERE id = ANY($1::int[])`,
    [clipIds]
  );
  const clipsById = new Map(clipsRes.rows.map(r => [r.id, r]));

  // Process sequentially — small batches, simpler error reporting, and
  // xgodo's submit endpoint is fast enough that parallelism isn't needed.
  const results: Array<{
    clipId: number; ok: boolean; plannedTaskId?: string;
    alreadyQueued?: boolean; error?: string;
  }> = [];

  for (const clipId of clipIds) {
    const clip = clipsById.get(clipId);
    if (!clip) {
      results.push({ clipId, ok: false, error: 'clip not found' });
      continue;
    }
    if (!clip.video_url) {
      results.push({ clipId, ok: false, error: 'clip has no video_url' });
      continue;
    }
    const r = await submitClipToXgodo({
      clipId,
      videoUrl: clip.video_url,
      title: clip.title || '(untitled)',
      description,
    });
    if (r.ok === true) {
      results.push({ clipId, ok: true, plannedTaskId: r.plannedTaskId, alreadyQueued: r.alreadyQueued });
    } else {
      results.push({ clipId, ok: false, error: r.error });
    }
  }

  const okCount = results.filter(r => r.ok).length;
  return NextResponse.json({
    submitted: okCount,
    skipped: results.filter(r => r.alreadyQueued).length,
    failed: results.filter(r => !r.ok).length,
    results,
  });
}
