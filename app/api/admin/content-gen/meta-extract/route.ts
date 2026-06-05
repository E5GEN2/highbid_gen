import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { extractChannelMeta, type ChannelMetaAnalysis } from '@/lib/content-gen/channel-analysis';

/**
 * Content-gen meta-extraction + persist (stage A, step 2 — productized).
 *
 * POST { videoIds: number[], force?: boolean }
 *   For each video with a DONE transcription job, runs extractChannelMeta
 *   over its timeline and upserts the result into
 *   content_gen_channel_analysis keyed on the video's channel_id.
 *   Skips channels already analyzed (same analyzer_version) unless force.
 *
 * GET ?channelIds=UC..,UC..  OR  ?videoIds=1,2,3
 *   Read back stored analyses (no Gemini call).
 *
 * Replaces the throwaway meta-test endpoint — this one persists.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 180;

const ANALYZER_VERSION = 1;

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { videoIds?: number[]; force?: boolean };
  const videoIds = Array.isArray(body.videoIds) ? body.videoIds.filter(n => Number.isFinite(n)) : [];
  const force = body.force === true;
  if (videoIds.length === 0) {
    return NextResponse.json({ error: 'videoIds (number[]) required' }, { status: 400 });
  }

  const pool = await getPool();

  // Latest DONE transcription job per video + the video's channel_id.
  const r = await pool.query<{
    video_id: number;
    channel_id: string | null;
    job_id: number;
    source_video_title: string | null;
    timeline_jsonb: Record<string, unknown> | null;
  }>(
    `SELECT DISTINCT ON (j.video_id)
       j.video_id, v.channel_id, j.id AS job_id,
       j.source_video_title, j.timeline_jsonb
     FROM video_analysis_jobs j
     JOIN niche_spy_videos v ON v.id = j.video_id
     WHERE j.video_id = ANY($1::int[]) AND j.status = 'done'
     ORDER BY j.video_id, j.created_at DESC`,
    [videoIds],
  );

  // Which channels already have a current-version analysis? Skip unless force.
  const channelIds = r.rows.map(x => x.channel_id).filter(Boolean) as string[];
  const existing = new Set<string>();
  if (!force && channelIds.length > 0) {
    const ex = await pool.query<{ channel_id: string }>(
      `SELECT channel_id FROM content_gen_channel_analysis
        WHERE channel_id = ANY($1::text[]) AND analyzer_version = $2`,
      [channelIds, ANALYZER_VERSION],
    );
    for (const row of ex.rows) existing.add(row.channel_id);
  }

  const results: Array<Record<string, unknown>> = [];

  // Process sequentially-ish but allow some parallelism. Meta calls are
  // ~7-11s each; with ~10 channels we run them in a small parallel batch.
  await Promise.all(r.rows.map(async (row) => {
    if (!row.channel_id) {
      results.push({ videoId: row.video_id, skipped: 'no channel_id on video' });
      return;
    }
    if (!force && existing.has(row.channel_id)) {
      results.push({ videoId: row.video_id, channelId: row.channel_id, skipped: 'already analyzed (use force=true to redo)' });
      return;
    }
    if (!row.timeline_jsonb) {
      results.push({ videoId: row.video_id, channelId: row.channel_id, skipped: 'no timeline' });
      return;
    }
    const t0 = Date.now();
    let meta: ChannelMetaAnalysis;
    try {
      meta = await extractChannelMeta(
        row.timeline_jsonb as Parameters<typeof extractChannelMeta>[0],
        row.source_video_title ?? '',
      );
    } catch (e) {
      results.push({ videoId: row.video_id, channelId: row.channel_id, error: (e as Error).message });
      return;
    }

    await pool.query(
      `INSERT INTO content_gen_channel_analysis
         (channel_id, analyzed_video_id, analysis_job_id, niche_label, recipe_formula,
          language, is_faceless, production_format, voice_type, content_summary,
          confidence, analyzer_version, analyzed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (channel_id) DO UPDATE SET
         analyzed_video_id = EXCLUDED.analyzed_video_id,
         analysis_job_id   = EXCLUDED.analysis_job_id,
         niche_label       = EXCLUDED.niche_label,
         recipe_formula    = EXCLUDED.recipe_formula,
         language          = EXCLUDED.language,
         is_faceless       = EXCLUDED.is_faceless,
         production_format = EXCLUDED.production_format,
         voice_type        = EXCLUDED.voice_type,
         content_summary   = EXCLUDED.content_summary,
         confidence        = EXCLUDED.confidence,
         analyzer_version  = EXCLUDED.analyzer_version,
         analyzed_at       = NOW()`,
      [
        row.channel_id, row.video_id, row.job_id, meta.niche_label, meta.recipe_formula,
        meta.language, meta.is_faceless, meta.production_format, meta.voice_type, meta.content_summary,
        meta.confidence, ANALYZER_VERSION,
      ],
    );

    results.push({
      videoId: row.video_id,
      channelId: row.channel_id,
      title: row.source_video_title,
      extractionMs: Date.now() - t0,
      meta,
    });
  }));

  const notReady = videoIds.filter(vid => !r.rows.some(row => row.video_id === vid));
  return NextResponse.json({
    ok: true,
    analyzed: results.filter(x => 'meta' in x).length,
    skipped:  results.filter(x => 'skipped' in x).length,
    errored:  results.filter(x => 'error' in x).length,
    notReady, // videos without a done transcription
    results,
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const channelIds = (sp.get('channelIds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const videoIds = (sp.get('videoIds') ?? '').split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));

  const pool = await getPool();
  let rows;
  if (channelIds.length > 0) {
    rows = (await pool.query(
      `SELECT * FROM content_gen_channel_analysis WHERE channel_id = ANY($1::text[]) ORDER BY analyzed_at DESC`,
      [channelIds],
    )).rows;
  } else if (videoIds.length > 0) {
    rows = (await pool.query(
      `SELECT cga.* FROM content_gen_channel_analysis cga
        JOIN niche_spy_videos v ON v.channel_id = cga.channel_id
       WHERE v.id = ANY($1::int[]) ORDER BY cga.analyzed_at DESC`,
      [videoIds],
    )).rows;
  } else {
    rows = (await pool.query(
      `SELECT * FROM content_gen_channel_analysis ORDER BY analyzed_at DESC LIMIT 100`,
    )).rows;
  }
  return NextResponse.json({ ok: true, count: rows.length, analyses: rows });
}
