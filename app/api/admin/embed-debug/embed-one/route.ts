import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { batchEmbedInputs, batchEmbedGrouped, TARGET_CONFIG, type EmbeddingTarget, type EmbedInput } from '@/lib/embeddings';
import { probeThumbnail, thumbnailUrlFor } from '@/lib/thumbnail-validate';
import { upsertVector } from '@/lib/vector-db';

/**
 * POST /api/admin/embed-debug/embed-one
 *
 * Single-video embedding probe with verbose per-step output. Built so
 * Claude can curl one video through the pipeline and see exactly what
 * happens at every stage:
 *   - the video row pulled from the DB (title, thumbnail URL)
 *   - thumbnail probe (which URL was tried, terminal/transient, latency,
 *     body size, mime)
 *   - the Gemini call (target, model, response shape — embedding length
 *     + first-5 values for sanity)
 *   - persistence (UPDATE niche_spy_videos + upsertVector)
 *   - per-step timings
 *
 * Body: { videoId: number; target: 'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined_v2'; dryRun?: boolean }
 *
 * dryRun=true (default) skips the persistence step so you can prod the
 * pipeline against any video without touching the DB. Set false to
 * actually write the embedding through.
 *
 * Auth: admin Bearer token.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const VALID: EmbeddingTarget[] = ['title_v1', 'title_v2', 'thumbnail_v2', 'combined_v2'];

interface Step {
  name: string;
  ms: number;
  ok: boolean;
  detail?: unknown;
  error?: string;
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { videoId?: number; target?: string; dryRun?: boolean };
  const videoId = body.videoId;
  const dryRun = body.dryRun !== false;   // default true (safe)
  if (typeof videoId !== 'number' || !Number.isFinite(videoId)) {
    return NextResponse.json({ error: 'videoId (number) required' }, { status: 400 });
  }
  const target = body.target && (VALID as string[]).includes(body.target)
    ? body.target as EmbeddingTarget
    : 'combined_v2';
  const cfg = TARGET_CONFIG[target];
  const steps: Step[] = [];
  const t0 = Date.now();

  // ── 1. Pull video row ───────────────────────────────────────────
  const pool = await getPool();
  let stepStart = Date.now();
  const vRes = await pool.query(
    `SELECT id, title, keyword, thumbnail, url,
            (${cfg.column} IS NOT NULL) AS already_embedded,
            (thumbnail_dead_at IS NOT NULL) AS thumb_dead
       FROM niche_spy_videos WHERE id = $1 LIMIT 1`,
    [videoId],
  );
  if (vRes.rows.length === 0) {
    steps.push({ name: 'fetch_video', ms: Date.now() - stepStart, ok: false, error: 'video not found' });
    return NextResponse.json({ ok: false, target, dryRun, totalMs: Date.now() - t0, steps }, { status: 404 });
  }
  const v = vRes.rows[0];
  steps.push({
    name: 'fetch_video', ms: Date.now() - stepStart, ok: true,
    detail: {
      id: v.id, title: v.title, keyword: v.keyword,
      thumbnail: v.thumbnail, url: v.url,
      alreadyEmbedded: v.already_embedded, thumbDead: v.thumb_dead,
    },
  });

  // ── 2. Thumbnail probe (when applicable) ────────────────────────
  let imageInput: { mimeType: string; data: string } | null = null;
  if (target === 'thumbnail_v2' || target === 'combined_v2') {
    stepStart = Date.now();
    const picked = thumbnailUrlFor({ thumbnail: v.thumbnail, url: v.url });
    if (!picked.url) {
      steps.push({ name: 'thumb_pick', ms: Date.now() - stepStart, ok: false, error: 'no fetchable thumbnail url', detail: picked });
      return NextResponse.json({ ok: false, target, dryRun, totalMs: Date.now() - t0, steps }, { status: 400 });
    }
    steps.push({ name: 'thumb_pick', ms: Date.now() - stepStart, ok: true, detail: picked });

    stepStart = Date.now();
    const probe = await probeThumbnail(picked.url, { omitBody: false });
    if (!probe.ok) {
      steps.push({
        name: 'thumb_probe', ms: Date.now() - stepStart, ok: false,
        error: probe.reason ?? 'probe failed',
        detail: { terminal: probe.terminal, latencyMs: probe.latencyMs },
      });
      return NextResponse.json({ ok: false, target, dryRun, totalMs: Date.now() - t0, steps }, { status: 400 });
    }
    imageInput = { mimeType: probe.mime ?? 'image/jpeg', data: probe.body!.toString('base64') };
    steps.push({
      name: 'thumb_probe', ms: Date.now() - stepStart, ok: true,
      detail: { mime: probe.mime, bodyBytes: probe.body?.length ?? 0, latencyMs: probe.latencyMs },
    });
  }

  // ── 3. Build inputs / groups ────────────────────────────────────
  let inputs: EmbedInput[] = [];
  let groups: EmbedInput[][] = [];
  if (target === 'thumbnail_v2') {
    inputs = [{ type: 'image', mimeType: imageInput!.mimeType, data: imageInput!.data }];
  } else if (target === 'combined_v2') {
    groups = [[
      { type: 'text', text: v.title || '' },
      { type: 'image', mimeType: imageInput!.mimeType, data: imageInput!.data },
    ]];
  } else {
    if (!v.title) {
      steps.push({ name: 'build_input', ms: 0, ok: false, error: 'video has no title' });
      return NextResponse.json({ ok: false, target, dryRun, totalMs: Date.now() - t0, steps }, { status: 400 });
    }
    inputs = [{ type: 'text', text: v.title }];
  }
  steps.push({
    name: 'build_input', ms: 0, ok: true,
    detail: { mode: target === 'combined_v2' ? 'grouped(text+image)' : target === 'thumbnail_v2' ? 'image-only' : 'text-only', model: cfg.model },
  });

  // ── 4. Gemini call ──────────────────────────────────────────────
  stepStart = Date.now();
  let embedding: number[] | null = null;
  try {
    const embeddings = target === 'combined_v2'
      ? await batchEmbedGrouped(groups, cfg.model)
      : await batchEmbedInputs(inputs, cfg.model);
    embedding = embeddings[0] || null;
    steps.push({
      name: 'gemini_embed', ms: Date.now() - stepStart, ok: !!embedding && embedding.length > 0,
      detail: {
        receivedCount: embeddings.length,
        length: embedding?.length ?? 0,
        first5: embedding?.slice(0, 5) ?? null,
        last5: embedding?.slice(-5) ?? null,
      },
      error: !embedding ? 'no embedding in response' : embedding.length === 0 ? 'zero-length embedding' : undefined,
    });
    if (!embedding || embedding.length === 0) {
      return NextResponse.json({ ok: false, target, dryRun, totalMs: Date.now() - t0, steps }, { status: 502 });
    }
  } catch (err) {
    steps.push({
      name: 'gemini_embed', ms: Date.now() - stepStart, ok: false,
      error: (err as Error).message?.slice(0, 500) || 'unknown',
    });
    return NextResponse.json({ ok: false, target, dryRun, totalMs: Date.now() - t0, steps }, { status: 502 });
  }

  // ── 5. Persist (skipped in dryRun) ──────────────────────────────
  if (dryRun) {
    steps.push({ name: 'persist', ms: 0, ok: true, detail: { skipped: true, reason: 'dryRun' } });
    return NextResponse.json({ ok: true, target, dryRun, totalMs: Date.now() - t0, steps });
  }

  stepStart = Date.now();
  try {
    const arrayLiteral = `{${embedding.join(',')}}`;
    await pool.query(
      `UPDATE niche_spy_videos SET ${cfg.column} = $1::real[], ${cfg.stampColumn} = NOW() WHERE id = $2`,
      [arrayLiteral, videoId],
    );
    await upsertVector(videoId, v.keyword || '', v.title || '', embedding, target);
    steps.push({ name: 'persist', ms: Date.now() - stepStart, ok: true, detail: { mainDb: 'updated', vectorDb: 'upserted' } });
  } catch (err) {
    steps.push({
      name: 'persist', ms: Date.now() - stepStart, ok: false,
      error: (err as Error).message?.slice(0, 500) || 'unknown',
    });
    return NextResponse.json({ ok: false, target, dryRun, totalMs: Date.now() - t0, steps }, { status: 500 });
  }

  return NextResponse.json({ ok: true, target, dryRun, totalMs: Date.now() - t0, steps });
}
